// App storage and the person over IPC (docs/apps.md, "Storage" and "The
// person"); the renderer's side is src/ipc/appDataBridge.ts.
//
// Storage: project values are files in the open project
// (electron/project/appStorageStore.ts); local values are this person's, under
// the user data folder, `app-storage/<project digest>/<person digest>/`. The open
// project's data folder is watched while the renderer asks it to be
// (`apps:storageWatch`), so a pull or a teammate's edit reaches running apps as
// `storage.change`. One project is open at a time: opening another closes the
// last one's store and watcher.
//
// The person: Git's name and email for the project, and the GitHub account roles
// resolve for (roleAccess.ts, the publishing account when signed in). When the
// person chose to hide their details (Settings, Privacy), main answers the id
// only, so no detail ever reaches the renderer's app layer.
import fs from 'node:fs';
import type { NativeImage } from 'electron';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { appsFailureMessage, type AppsResult } from '../../shared/properties/apps';
import { appMembers, type AppMember, type AppPerson } from '../../shared/properties/appsRpc';
import { githubLoginAvatar } from '../../shared/ipc/commitAvatars';
import type { AppStorageScope } from '../../shared/properties/appStorage';
import { appPerson, appProjectKey, readGitAuthors, readGitPerson } from '../project/appPerson';
import { createAppStorageStore, localAppStorageDirectory, type AppStorageStore, type AppStorageTarget } from '../project/appStorageStore';
import type { MainHost } from './mainHost';
import { readDesktopRoles, type IdentityReader } from './roleAccess';

/** Desktop has one person per user data folder: their local values live under this key. */
const DESKTOP_PERSON_KEY = 'desktop';
/** The file that keeps this computer's person key, for a person known by neither GitHub nor Git. */
const DEVICE_KEY_FILE = 'app-person-device';

export interface AppDataOptions {
  /** The user data folder: read when first needed, as Electron sets it once ready. */
  readonly userData: () => string;
  readonly identity: IdentityReader;
  /** Whether the person hides their details from apps (Settings, Privacy). */
  readonly personHidden: () => boolean;
  readonly version: () => string;
}

export function registerAppDataHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'send'>, options: AppDataOptions): void {
  let open: { readonly root: string; readonly store: AppStorageStore; stopWatching: (() => void) | undefined } | undefined;
  // The open project only, by its real path; its store is made once per project.
  const project = (projectPath: string): NonNullable<typeof open> => {
    const root = fs.realpathSync(projectPath);
    host.assertInProject(path.join(root, 'package.json'));
    if (open?.root === root) {
      return open;
    }
    open?.stopWatching?.();
    open = { root, store: createAppStorageStore({ projectRoot: root, notify: (change) => host.send('apps:storageChanged', change) }), stopWatching: undefined };
    return open;
  };
  const target = (root: string, scope: AppStorageScope): AppStorageTarget =>
    scope === 'project' ? { scope } : { scope, directory: desktopLocalStorageDirectory(options.userData(), root) };
  const { ipcMain } = host;
  ipcMain.handle('apps:storageGet', (_event, input) =>
    attempt(() => {
      const { root, store } = project(input.projectPath);
      return { value: store.get(input.id, target(root, input.scope), input.key) };
    }),
  );
  ipcMain.handle('apps:storageSet', (_event, input) =>
    attempt(() => {
      const { root, store } = project(input.projectPath);
      return store.set(input.id, target(root, input.scope), input.key, input.value, input.writer);
    }),
  );
  ipcMain.handle('apps:storageKeys', (_event, input) =>
    attempt(() => {
      const { root, store } = project(input.projectPath);
      return store.keys(input.id, target(root, input.scope));
    }),
  );
  ipcMain.handle('apps:storageWatch', (_event, input) => {
    const current = project(input.projectPath);
    if (current.stopWatching === undefined) {
      current.stopWatching = current.store.watch();
    }
    return { ok: true as const };
  });
  ipcMain.handle('apps:person', async (_event, input): Promise<AppsResult<AppPerson>> => {
    try {
      const { root } = project(input.projectPath);
      const [projectKey, gitPerson, github] = await Promise.all([appProjectKey(root), readGitPerson(root), options.identity(root).catch(() => undefined)]);
      const person = appPerson(projectKey, { ...gitPerson, github }, deviceKey(options.userData()), { hidden: options.personHidden() });
      return { ok: true, value: person };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      return { ok: false, message: appsFailureMessage(error) };
    }
  });
  // `people.list`: the role members and recent commit authors, no more of each than `person.get` tells,
  // and logins alone while the person hides their details from apps.
  ipcMain.handle('apps:people', async (_event, input): Promise<AppsResult<readonly AppMember[]>> => {
    try {
      const { root } = project(input.projectPath);
      const roleMembers = (readDesktopRolesOrNone(root)?.roles ?? []).flatMap((role) => role.members);
      const people = appMembers({ roleMembers, authors: await readGitAuthors(root), hidden: options.personHidden(), avatar: githubLoginAvatar });
      return { ok: true, value: people };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      return { ok: false, message: appsFailureMessage(error) };
    }
  });
  ipcMain.handle('apps:hostVersion', () => ({ version: options.version() }));
  // `canvas.snapshot` (docs/apps.md): the sender's own window, cropped to the element the renderer measured.
  ipcMain.handle('apps:canvasSnapshot', async (event, input) => {
    try {
      const image = await event.sender.capturePage(input.rect, { stayHidden: false, stayAwake: false });
      return { ok: true, value: snapshotPNG(image, input.widthMax) };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.startsWith('Assertion failed')) {
        throw error;
      }
      return { ok: false, message: appsFailureMessage(error) };
    }
  });
}

/** `canvas.snapshot`'s bound on the PNG (APP_RPC_LIMITS.snapshotBytesMax), and the narrowest it shrinks to meet it. */
const SNAPSHOT_BYTES_MAX = 200 * 1024;
const SNAPSHOT_WIDTH_MIN = 16;
/** Halvings tried to meet the byte bound: 800 pixels wide halves to 16 within six. */
const SNAPSHOT_SHRINKS_MAX = 6;

// The capture as a PNG data URL, no wider than `widthMax` and within the byte bound: a busy element is halved until it fits.
function snapshotPNG(image: NativeImage, widthMax: number): { readonly url: string; readonly width: number; readonly height: number } {
  assert(widthMax >= 1, 'A snapshot is at least a pixel wide');
  let current = image.getSize().width > widthMax ? image.resize({ width: widthMax, quality: 'good' }) : image;
  for (let shrink = 0; shrink < SNAPSHOT_SHRINKS_MAX; shrink += 1) {
    const png = current.toPNG();
    if (png.length <= SNAPSHOT_BYTES_MAX) {
      const size = current.getSize();
      return { url: `data:image/png;base64,${png.toString('base64')}`, width: size.width, height: size.height };
    }
    const width = Math.floor(current.getSize().width / 2);
    if (width < SNAPSHOT_WIDTH_MIN) {
      break;
    }
    current = current.resize({ width, quality: 'good' });
  }
  throw new Error(`The element’s snapshot is larger than ${SNAPSHOT_BYTES_MAX / 1024} KiB at any width`);
}

/** This person's local values for a project, under the user data folder. */
export function desktopLocalStorageDirectory(userData: string, projectRoot: string): string {
  return localAppStorageDirectory(path.join(userData, 'app-storage'), projectRoot, DESKTOP_PERSON_KEY);
}

// A random key for this computer, made once: a person known by neither GitHub nor Git still keeps one id.
function deviceKey(userData: string): string {
  const file = path.join(userData, DEVICE_KEY_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) {
      return existing;
    }
  } catch {
    // None yet: made below.
  }
  const created = randomBytes(16).toString('hex');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(file, created, { mode: 0o600 });
  assert(fs.readFileSync(file, 'utf8') === created, 'The device key reads back as written');
  return created;
}

// A storage call: an expected failure (a file that does not parse, the disk) is a message; a broken invariant crashes.
function attempt<T>(run: () => T): AppsResult<T> {
  try {
    return { ok: true, value: run() };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, message: appsFailureMessage(error) };
  }
}

// A broken roles file lists no members: the commit authors still answer, and Settings → Roles says what is wrong.
function readDesktopRolesOrNone(root: string): ReturnType<typeof readDesktopRoles> {
  try {
    return readDesktopRoles(root);
  } catch {
    return undefined;
  }
}
