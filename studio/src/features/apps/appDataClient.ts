// App storage and the person in Studio (docs/apps.md, "Storage" and "The
// person"): the same calls as Desktop's bridge (src/ipc/appDataBridge.ts), over
// HTTP to the Studio server (appsServer.ts appDataAction), and its change
// stream. Every reply is parsed before an app sees it.
//
// Hiding the person's details is this browser's preference, kept with Studio's
// other per-person choices (the sound switch, soundPreference.ts) in the
// browser's storage and switched from the account menu. The server always
// answers the whole person; this module keeps only the id when hidden, so no
// detail reaches an app either way.
import { parseAppsResult } from '../../../vendor/stacki/shared/properties/apps';
import { parseAppMembers, parseAppPerson, type AppEditOutcome, type AppMember, type AppPerson } from '../../../vendor/stacki/shared/properties/appsRpc';
import {
  APP_STORAGE_LIMITS,
  parseAppStorageChange,
  parseAppStorageKey,
  parseAppStorageValue,
  type AppStorageChange,
  type AppStorageScope,
} from '../../../vendor/stacki/shared/properties/appStorage';
import { record } from '../../shared/validation';
import { request } from '../project/projectClient';

/** This tab's writer token: a change notice carrying it is this tab's own write. */
export const STUDIO_STORAGE_WRITER = writerToken();

const HIDDEN_KEY = 'studio-apps-person-hidden';
const personListeners = new Set<() => void>();
let memoryHidden = false;

async function post(url: string, body: unknown): Promise<unknown> {
  return request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

export async function readStudioAppStorage(appId: string, scope: AppStorageScope, key: string): Promise<string | undefined> {
  const answer = parseAppsResult(await post('/studio/api/apps/storage/get', { id: appId, scope, key }), (value) => {
    const raw = record(value)['value'];
    return raw === undefined ? undefined : parseAppStorageValue(raw);
  });
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

export async function writeStudioAppStorage(appId: string, scope: AppStorageScope, key: string, value: string | undefined): Promise<AppEditOutcome> {
  const answer = parseAppsResult(await post('/studio/api/apps/storage/set', { id: appId, scope, key, value, writer: STUDIO_STORAGE_WRITER }), (input) => {
    const outcome = record(input);
    if (outcome['applied'] === true) {
      return { applied: true } as const;
    }
    const reason = outcome['reason'];
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new Error('A storage write answers applied, or not with a reason');
    }
    return { applied: false, reason: reason.slice(0, 500) } as const;
  });
  return answer.ok ? answer.value : { applied: false, reason: answer.message };
}

export async function listStudioAppStorageKeys(appId: string, scope: AppStorageScope): Promise<readonly string[]> {
  const answer = parseAppsResult(await post('/studio/api/apps/storage/keys', { id: appId, scope }), (value) => {
    if (!Array.isArray(value) || value.length > APP_STORAGE_LIMITS.keysMax) {
      throw new Error(`Storage keys are a list of at most ${APP_STORAGE_LIMITS.keysMax}`);
    }
    return value.map(parseAppStorageKey);
  });
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

/** Hears the server's storage changes for this project (and this person's local ones); returns the stop. */
export function watchStudioAppStorage(listener: (change: AppStorageChange) => void): () => void {
  if (typeof EventSource === 'undefined') {
    return () => undefined;
  }
  const events = new EventSource('/studio/api/apps/storage/events');
  events.addEventListener('storage-change', (event: MessageEvent<unknown>) => {
    if (typeof event.data !== 'string') {
      return;
    }
    let change: AppStorageChange;
    try {
      change = parseAppStorageChange(JSON.parse(event.data) as unknown);
    } catch {
      return; // A notice this client cannot read is dropped; the next read finds the values.
    }
    listener(change);
  });
  return () => events.close();
}

/** This Studio's version, for `app.info`; a server too old to say answers `unknown`. */
export async function readStudioHostVersion(): Promise<string> {
  try {
    const answer = parseAppsResult(await post('/studio/api/apps/host', {}), (value) => {
      const version = record(value)['version'];
      if (typeof version !== 'string' || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) {
        throw new Error('A version is a short version string');
      }
      return version;
    });
    return answer.ok ? answer.value : 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function readStudioAppPerson(): Promise<AppPerson> {
  const answer = parseAppsResult(await post('/studio/api/apps/person', {}), parseAppPerson);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return studioPersonHidden() ? { id: answer.value.id, name: undefined, email: undefined, github: undefined } : answer.value;
}

/** `people.list`: the server's list, narrowed to logins and pictures while this person hides details from apps. */
export async function readStudioAppPeople(): Promise<readonly AppMember[]> {
  const answer = parseAppsResult(await post('/studio/api/apps/people', {}), parseAppMembers);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  if (!studioPersonHidden()) {
    return answer.value;
  }
  return answer.value.flatMap((member) =>
    member.login === undefined ? [] : [{ login: member.login, name: undefined, email: undefined, avatarURL: member.avatarURL }],
  );
}

/** Whether this person hides their details from apps; a tab without browser storage remembers the choice itself. */
export function studioPersonHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === 'true';
  } catch {
    return memoryHidden;
  }
}

export function setStudioPersonHidden(hidden: boolean): void {
  memoryHidden = hidden;
  try {
    localStorage.setItem(HIDDEN_KEY, String(hidden));
  } catch {
    // Without browser storage the choice lasts for this tab: it still applies now.
  }
  for (const listener of [...personListeners]) {
    listener();
  }
}

/** Hears the person hiding or showing their details; returns the stop. */
export function onStudioPersonChange(listener: () => void): () => void {
  personListeners.add(listener);
  return () => {
    personListeners.delete(listener);
  };
}

function writerToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `studio-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
