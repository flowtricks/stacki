// App storage and the person on the Studio server (docs/apps.md, "Storage" and
// "The person"): the same store and person as Desktop's main process
// (vendor/stacki/electron/project/appStorageStore.ts and appPerson.ts), over
// HTTP for appDataClient.ts.
//
// Who the person is: behind the Cloudflare worker, the GitHub login it verified
// (`x-studio-user`, trusted only with its token, as serverAccess.ts reads it);
// a local Studio has one person, its user. Their name and email are Git's only
// in a local Studio: a hosted container's Git identity is the deployment's,
// not the person's, so a hosted Studio answers the GitHub account alone.
//
// Where values live: project values in the project's `.stacki/app-data/`, as on
// Desktop; local values in the user's home folder, `~/.stacki/studio-app-storage/`,
// beside Studio's app secrets (appSettingsVault.ts), one folder per project and
// person. A hosted container's disk does not outlive a deployment, so there
// local values last until the next one (docs/apps.md says so).
//
// Changes: the project's data folder is watched for as long as the server runs,
// and every change goes to the subscribed editors as a `storage-change` event;
// a local change goes only to that person's editors.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { parseGitHubLogin } from '../../../vendor/stacki/shared/properties/projectRoles';
import { appAccessFeature } from '../../../vendor/stacki/shared/properties/appsRpc';
import { parseAppId } from '../../../vendor/stacki/shared/properties/apps';
import {
  parseAppStorageKey,
  parseAppStorageScope,
  parseAppStorageValue,
  parseAppStorageWriter,
  type AppStorageChange,
  type AppStorageScope,
} from '../../../vendor/stacki/shared/properties/appStorage';
import { createAppStorageStore, localAppStorageDirectory, type AppStorageTarget } from '../../../vendor/stacki/electron/project/appStorageStore';
import { appPerson, appProjectKey, readGitAuthors, readGitPerson } from '../../../vendor/stacki/electron/project/appPerson';
import { appMembers, type AppMember } from '../../../vendor/stacki/shared/properties/appsRpc';
import { githubLoginAvatar } from '../../../vendor/stacki/shared/ipc/commitAvatars';
import { parseProjectRolesSource } from '../../../vendor/stacki/shared/properties/projectRoles';
import { readMetadataSource } from '../settings/projectMetadata';
import { requestRole } from '../roles/serverAccess';
import { record } from '../../shared/validation';

const APP_DATA_LIMITS = {
  /** Editors one server streams storage changes to. */
  subscribersMax: 100,
  /** How often an idle stream says it is alive, so proxies keep it open. */
  heartbeatMs: 15_000,
} as const satisfies Record<string, number>;

/** The person of a local Studio, which has no sign-in. */
const LOCAL_PERSON = 'local';

type AppDataAction = 'storage/get' | 'storage/set' | 'storage/keys' | 'person' | 'people' | 'host';

interface Subscriber {
  readonly response: ServerResponse;
  readonly person: string;
}

/** The person a request comes from: the verified GitHub login behind the worker, else the local user. */
export function studioPersonKey(request: Pick<IncomingMessage, 'headers'>): string {
  if (!process.env['STUDIO_CONTAINER_TOKEN']) {
    return LOCAL_PERSON;
  }
  const header = request.headers['x-studio-user'];
  return `github:${parseGitHubLogin(typeof header === 'string' ? header : '').toLowerCase()}`;
}

/** This person's local app values for the project, in the user's home folder. */
export function studioLocalStorageDirectory(root: string, person: string, home: string = os.homedir()): string {
  return localAppStorageDirectory(path.join(home, '.stacki', 'studio-app-storage'), path.resolve(root), person);
}

export function studioAppData(root: string) {
  const subscribers = new Set<Subscriber>();
  const broadcast = (change: AppStorageChange, person: string | undefined): void => {
    const event = `event: storage-change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const subscriber of [...subscribers]) {
      // A local change is its person's alone.
      if (person !== undefined && subscriber.person !== person) {
        continue;
      }
      if (!subscriber.response.write(event)) {
        subscriber.response.end();
        subscribers.delete(subscriber);
      }
    }
  };
  const projectStore = createAppStorageStore({ projectRoot: root, notify: (change) => broadcast(change, undefined) });
  const stopWatching = projectStore.watch();
  // A local write's notice goes to its person only: a store per write, whose notices name that person.
  const localStore = (person: string) => createAppStorageStore({ projectRoot: root, notify: (change) => broadcast(change, person) });
  const storeFor = (scope: AppStorageScope, person: string) => (scope === 'project' ? projectStore : localStore(person));
  const target = (scope: AppStorageScope, person: string): AppStorageTarget =>
    scope === 'project' ? { scope } : { scope, directory: studioLocalStorageDirectory(root, person) };
  return {
    stop: stopWatching,
    subscribe: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (subscribers.size >= APP_DATA_LIMITS.subscribersMax) {
        response.writeHead(503).end('Too many storage subscriptions');
        return;
      }
      const role = await requestRole(root, request);
      if (!can(role, 'panel:apps')) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Accel-Buffering': 'no',
      });
      response.write('retry: 1000\n\n');
      const subscriber: Subscriber = { response, person: studioPersonKey(request) };
      subscribers.add(subscriber);
      assert(subscribers.size <= APP_DATA_LIMITS.subscribersMax, 'Storage subscribers are bounded');
      const heartbeat = setInterval(() => {
        if (!response.write(': keepalive\n\n')) {
          response.end();
        }
      }, APP_DATA_LIMITS.heartbeatMs);
      response.once('close', () => {
        clearInterval(heartbeat);
        subscribers.delete(subscriber);
      });
    },
    answer: async (action: AppDataAction, request: IncomingMessage, readBody: () => Promise<string>): Promise<unknown> => {
      try {
        const input = record(JSON.parse((await readBody()) || '{}') as unknown);
        const role = await requestRole(root, request);
        if (!can(role, 'panel:apps')) {
          return { ok: false, message: 'Your role cannot use apps.' };
        }
        const person = studioPersonKey(request);
        if (action === 'host') {
          return { ok: true, value: { version: studioVersion() } };
        }
        if (action === 'person') {
          return { ok: true, value: await studioPerson(root, request, person) };
        }
        if (action === 'people') {
          return { ok: true, value: await studioPeople(root) };
        }
        const id = parseAppId(input['id']);
        if (!can(role, appAccessFeature(id))) {
          return { ok: false, message: `The ${role.name} role cannot use this app.` };
        }
        const scope = parseAppStorageScope(input['scope']);
        const store = storeFor(scope, person);
        switch (action) {
          case 'storage/get':
            return { ok: true, value: { value: store.get(id, target(scope, person), parseAppStorageKey(input['key'])) } };
          case 'storage/keys':
            return { ok: true, value: store.keys(id, target(scope, person)) };
          case 'storage/set': {
            const value = input['value'] === undefined ? undefined : parseAppStorageValue(input['value']);
            const writer = parseAppStorageWriter(input['writer']);
            return { ok: true, value: store.set(id, target(scope, person), parseAppStorageKey(input['key']), value, writer) };
          }
          default: {
            const exhaustive: never = action;
            return exhaustive;
          }
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.message.startsWith('Assertion failed')) {
          throw error;
        }
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// The person: a local Studio's Git identity, or a hosted one's GitHub login alone (see the header).
async function studioPerson(root: string, request: IncomingMessage, person: string) {
  const projectKey = await appProjectKey(root);
  if (person === LOCAL_PERSON) {
    return appPerson(projectKey, { ...(await readGitPerson(root)), github: undefined }, `studio:${os.hostname()}`, { hidden: false });
  }
  const header = request.headers['x-studio-user'];
  const github = parseGitHubLogin(typeof header === 'string' ? header : '');
  return appPerson(projectKey, { name: undefined, email: undefined, github }, person, { hidden: false });
}

// `people.list`: the role members and recent commit authors in full. Hiding details is this browser's
// choice in Studio, so the client (appDataClient.ts) narrows the list, as it narrows `person.get`.
async function studioPeople(root: string): Promise<readonly AppMember[]> {
  const stored = await readMetadataSource(root, 'roles');
  let roleMembers: readonly string[] = [];
  try {
    roleMembers = stored.source === undefined ? [] : parseProjectRolesSource(stored.source).roles.flatMap((role) => role.members);
  } catch {
    roleMembers = []; // A broken roles file lists no members; the commit authors still answer.
  }
  return appMembers({ roleMembers, authors: await readGitAuthors(root), hidden: false, avatar: githubLoginAvatar });
}

/** Studio's own version, from its package file: the one `npm run assemble` stamps on the shared source. */
export function studioVersion(): string {
  try {
    const version = record(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as unknown)['version'];
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
