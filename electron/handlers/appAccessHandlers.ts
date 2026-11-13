// What apps reach beyond the editor, over IPC: project files (`files.*`,
// electron/project/appFilesStore.ts) and OAuth sign-ins (`auth.*`,
// electron/project/appSignIn.ts). registerAppsHandlers registers both with the
// same open-project check and secret vault as the rest of the apps channels.
//
// Files: a text write goes through the document actors, the editor's own save
// path, so it never interleaves with a save of the same file; then main tells
// the renderer which files changed (`fs:changed` and the panel channels the
// project watcher would use), so open editors and the canvas reload them as
// they do any change on disk. The watcher does not hear the actors' own writes,
// which is why this announces them. Main refuses the channel to a role without
// `code:edit` (channelAccess.ts).
//
// Sign-ins (RFC 8252): main opens a loopback listener on 127.0.0.1 and a random
// port for one flow, opens the authorize URL in the system browser, and closes
// the listener once the callback arrives or the flow times out.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { isAtomicTemporary } from '../documents/atomicWrite';
import { writeProjectText } from '../documents/documentWrites';
import { APP_AUTH_LIMITS, type AppAuthStatus } from '../../shared/properties/appAuth';
import { appsFailure, type AppManifest, type AppsResult } from '../../shared/properties/apps';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { createAppFileBudget, runAppFileOperation } from '../project/appFilesStore';
import { appNetFetch, createAppNetRate } from '../project/appNetFetch';
import { createAppSignIns, type AppSignIns, type FlowOutcome } from '../project/appSignIn';
import { listInstalledApps } from '../project/appStore';
import type { SecretVault } from '../project/appSettingsStore';
import type { MainHost } from './mainHost';

export function registerAppAccessHandlers(
  host: Pick<MainHost, 'ipcMain' | 'noteAppWrite' | 'send'>,
  options: {
    /** The open project's real path, checked as every apps channel checks it. */
    readonly root: (projectPath: string) => string;
    readonly vault: SecretVault;
    /** Opens a URL in the person's own browser (Electron's shell.openExternal). */
    readonly openBrowser: (url: string) => Promise<void>;
    /** The Stacki connections broker's origin (appConnections.ts stackiBrokerOrigin). */
    readonly broker: string;
  },
): AppSignIns {
  const { ipcMain } = host;
  const budget = createAppFileBudget(() => Date.now());
  const signIns = createAppSignIns({ fetch: (url, init) => fetch(url, init), now: () => Date.now(), vault: options.vault, broker: options.broker });

  ipcMain.handle('apps:files', (_event, input) => {
    const project = options.root(input.projectPath);
    const answer = runAppFileOperation(project, input.id, input.operation, {
      budget,
      writeFile: (absolute, bytes, text) => {
        if (text === undefined) {
          writeAppBinary(absolute, bytes);
          return;
        }
        writeProjectText(absolute, text);
      },
    });
    if (answer.ok && answer.value.kind === 'changed' && answer.value.change.paths.length > 0) {
      announceFileChanges(host, project, answer.value.change.paths);
    }
    return answer;
  });

  // Requests made for an app (appNetFetch.ts): its declared hosts only, signed with its sign-in when it asks.
  const netRate = createAppNetRate(() => Date.now());
  ipcMain.handle('apps:netFetch', async (_event, input) => {
    const project = options.root(input.projectPath);
    return withAppAsync(project, input.id, (manifest) =>
      appNetFetch(manifest, input.request, netRate, {
        fetch: (url, init) => fetch(url, init),
        now: () => Date.now(),
        accessToken: async (signedIn, provider) => (await signIns.token(project, signedIn, provider)).accessToken,
      }),
    );
  });
  ipcMain.handle('apps:authStatus', async (_event, input) => {
    const project = options.root(input.projectPath);
    return withAppAsync(project, input.id, (manifest) => signIns.checkedStatus(project, manifest));
  });
  ipcMain.handle('apps:authToken', async (_event, input) => {
    const project = options.root(input.projectPath);
    return withAppAsync(project, input.id, (manifest) => signIns.token(project, manifest, input.provider));
  });
  ipcMain.handle('apps:authDisconnect', (_event, input) =>
    withApp(options.root(input.projectPath), input.id, (project, manifest) => {
      signIns.disconnect(project, manifest.id, input.provider);
      host.send('apps:authChanged', { id: manifest.id });
      return signIns.status(project, manifest);
    }),
  );
  ipcMain.handle('apps:authConnect', async (_event, input): Promise<AppsResult<AppAuthStatus>> => {
    const project = options.root(input.projectPath);
    // A broker that cannot sign in now answers at once, before any browser opens (`unconfigured`).
    const outcome = await withAppAsync(
      project,
      input.id,
      async (manifest) =>
        (await signIns.unconfigured(project, manifest, input.provider)) ?? connect(signIns, project, manifest, input.provider, options.openBrowser),
    );
    if (outcome.ok && outcome.value.connected) {
      host.send('apps:authChanged', { id: input.id });
    }
    return outcome;
  });
  return signIns;
}

// One sign-in: a loopback listener for its callback, the browser, and the outcome; the listener closes either way.
async function connect(
  signIns: AppSignIns,
  project: string,
  manifest: AppManifest,
  provider: string,
  openBrowser: (url: string) => Promise<void>,
): Promise<AppAuthStatus> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    assert(address !== null, 'A loopback listener has an address');
    assert(typeof address === 'object', 'A loopback listener has a port');
    assert(address.address === '127.0.0.1', 'The listener is on the loopback address only');
    const redirectURI = `http://127.0.0.1:${address.port}/callback`;
    const flow = signIns.begin(project, manifest, provider, redirectURI);
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', redirectURI);
      if (request.method !== 'GET' || url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const field = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
      void signIns.complete({ state: field('state'), code: field('code'), error: field('error'), handoff: field('handoff') }).then((outcome) => {
        response.writeHead(outcome.ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(callbackPage(outcome));
      });
    });
    await openBrowser(flow.authorizeURL);
    const outcome = await flow.done;
    if (!outcome.ok) {
      throw outcome.messageRef === undefined ? new Error(outcome.message) : new ReferencedError(outcome.messageRef.key, outcome.messageRef.params);
    }
    return outcome.value;
  } finally {
    signIns.cancel(project, manifest.id);
    server.closeAllConnections();
    server.close();
  }
}

/** The page the browser shows after the callback: plain text, nothing the provider sent echoed back. */
/**
 * Puts bytes that are not UTF-8 text (an image an app made) at `absolute`
 * whole: staged beside it under the write protocol's temporary name, so the
 * project watcher ignores the staging file, then renamed into place. Text never
 * comes here: it goes through the document actors. The actor disk's own
 * primitives stay its own (singleWriter.test.ts), and they also refuse a file
 * that does not exist yet, which an app's new image is.
 */
function writeAppBinary(absolute: string, bytes: Uint8Array): void {
  assert(path.isAbsolute(absolute), 'An app writes a resolved project path');
  const temporary = path.join(path.dirname(absolute), `.stacki-write-${randomUUID()}.tmp`);
  assert(isAtomicTemporary(temporary), 'The staging file is one the project watcher ignores');
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx' });
    fs.renameSync(temporary, absolute);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function callbackPage(outcome: FlowOutcome): string {
  const message = outcome.ok ? 'Signed in. You can close this window and return to Stacki.' : 'The sign-in did not finish. Return to Stacki to see why.';
  return `<!doctype html><meta charset="utf-8"><title>Stacki</title><p style="font:16px system-ui;margin:3em">${message}</p>`;
}

// The renderer hears an app's file change as it hears one on disk: the files, and the panels they concern.
function announceFileChanges(host: Pick<MainHost, 'noteAppWrite' | 'send'>, project: string, paths: readonly string[]): void {
  const files = paths.map((relative) => path.join(project, relative));
  host.noteAppWrite();
  host.send('fs:changed', { files });
  if (paths.some((relative) => /\.(css|astro)$/i.test(relative))) {
    host.send('css:changed', {});
  }
  if (paths.some((relative) => relative.startsWith('public/') || /\.(png|jpe?g|gif|webp|avif|svg|mp4|webm|mp3|pdf)$/i.test(relative))) {
    host.send('assets:changed', {});
  }
  if (paths.some((relative) => /\.(json|ya?ml|md|mdx|toml|csv)$/i.test(relative))) {
    host.send('cms:changed', {});
  }
}

function withApp<T>(project: string, id: string, run: (project: string, manifest: AppManifest) => T): AppsResult<T> {
  try {
    return { ok: true, value: run(project, installedManifest(project, id)) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, ...appsFailure(error) };
  }
}

async function withAppAsync<T>(project: string, id: string, run: (manifest: AppManifest) => Promise<T>): Promise<AppsResult<T>> {
  try {
    return { ok: true, value: await run(installedManifest(project, id)) };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('Assertion failed')) {
      throw error;
    }
    return { ok: false, ...appsFailure(error) };
  }
}

function installedManifest(project: string, id: string): AppManifest {
  const app = listInstalledApps(project).find((summary) => summary.manifest.id === id);
  if (app === undefined) {
    throw new Error(`The app "${id}" is not installed.`);
  }
  assert(app.manifest.auth.length <= APP_AUTH_LIMITS.providersMax, 'Providers are bounded by the manifest parser');
  return app.manifest;
}
