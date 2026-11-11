// App storage and the person, from the renderer (docs/apps.md, "Storage" and
// "The person"): Desktop asks the main process, which keeps the files
// (electron/handlers/appDataHandlers.ts). Every reply is parsed before an app
// sees it. A main process older than this renderer (no method, no handler)
// answers with a reason to restart rather than a crash, so a renderer reloaded
// mid-session keeps working.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseAppsResult } from '../../shared/properties/apps';
import {
  APP_RPC_LIMITS,
  parseAppMembers,
  parseAppPerson,
  type AppEditOutcome,
  type AppMember,
  type AppPerson,
  type AppSnapshotOutcome,
} from '../../shared/properties/appsRpc';
import {
  APP_STORAGE_LIMITS,
  parseAppStorageChange,
  parseAppStorageKey,
  parseAppStorageValue,
  type AppStorageChange,
  type AppStorageScope,
} from '../../shared/properties/appStorage';
import { record } from '../../shared/core/boundary';
import { toArray } from '../../shared/core/record';

const RESTART = 'Restart Stacki to use app storage.';

/** This window's writer token: a change notice carrying it is this window's own write. */
export const DESKTOP_STORAGE_WRITER = writerToken();

export async function readAppStorage(projectPath: string, appId: string, scope: AppStorageScope, key: string): Promise<string | undefined> {
  const input = parseIpcPayload('apps:storageGet', { projectPath, id: appId, scope, key });
  const answer = parseAppsResult(await invoke(() => window.avb.appStorageGet(input)), (value) => {
    const raw = record(value)['value'];
    return { value: raw === undefined ? undefined : parseAppStorageValue(raw) };
  });
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value.value;
}

export async function writeAppStorage(
  projectPath: string,
  appId: string,
  scope: AppStorageScope,
  key: string,
  value: string | undefined,
): Promise<AppEditOutcome> {
  const input = parseIpcPayload('apps:storageSet', { projectPath, id: appId, scope, key, value, writer: DESKTOP_STORAGE_WRITER });
  const answer = parseAppsResult(await invoke(() => window.avb.appStorageSet(input)), parseOutcome);
  return answer.ok ? answer.value : { applied: false, reason: answer.message };
}

export async function listAppStorageKeys(projectPath: string, appId: string, scope: AppStorageScope): Promise<readonly string[]> {
  const input = parseIpcPayload('apps:storageKeys', { projectPath, id: appId, scope });
  const answer = parseAppsResult(await invoke(() => window.avb.appStorageKeys(input)), (value) => {
    const items = toArray(value);
    if (items === undefined || items.length > APP_STORAGE_LIMITS.keysMax) {
      throw new Error(`Storage keys are a list of at most ${APP_STORAGE_LIMITS.keysMax}`);
    }
    return items.map(parseAppStorageKey);
  });
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

/** Starts main watching the project's stored values and hears every change; returns the stop. */
export function watchAppStorage(projectPath: string, listener: (change: AppStorageChange) => void): () => void {
  if (typeof window.avb.onAppStorageChanged !== 'function' || typeof window.avb.watchAppStorage !== 'function') {
    return () => undefined; // An older preload: nothing to hear until Stacki restarts.
  }
  const stop = window.avb.onAppStorageChanged((data) => {
    let change: AppStorageChange;
    try {
      change = parseAppStorageChange(data);
    } catch {
      return; // A notice this renderer cannot read is dropped; the next read finds the values.
    }
    listener(change);
  });
  void Promise.resolve(window.avb.watchAppStorage(parseIpcPayload('apps:storageWatch', { projectPath }))).catch(() => undefined);
  return stop;
}

export async function readAppPerson(projectPath: string): Promise<AppPerson> {
  const input = parseIpcPayload('apps:person', { projectPath });
  const answer = parseAppsResult(await invoke(() => window.avb.appPerson(input)), parseAppPerson);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

/** The people an app may mention (`people.list`), as main reads them; a main process too old to say answers none. */
export async function readAppPeople(projectPath: string): Promise<readonly AppMember[]> {
  if (typeof window.avb.appPeople !== 'function') {
    return [];
  }
  const input = parseIpcPayload('apps:people', { projectPath });
  const answer = parseAppsResult(await invoke(() => window.avb.appPeople(input)), parseAppMembers);
  if (!answer.ok) {
    throw new Error(answer.message);
  }
  return answer.value;
}

/** This Stacki's version, for `app.info`; a main process too old to say answers `unknown`. */
export async function readHostVersion(): Promise<string> {
  if (typeof window.avb.appHostVersion !== 'function') {
    return 'unknown';
  }
  try {
    const version = record(await window.avb.appHostVersion(parseIpcPayload('apps:hostVersion', undefined)))['version'];
    return typeof version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(version) ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Hears the person hiding or showing their details; returns the stop. */
export function onAppPersonChanged(listener: () => void): () => void {
  if (typeof window.avb.onAppPersonChanged !== 'function') {
    return () => undefined;
  }
  return window.avb.onAppPersonChanged(listener);
}

async function invoke(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error: unknown) {
    if (error instanceof TypeError || String(error).includes('No handler registered')) {
      return { ok: false, message: RESTART };
    }
    throw error;
  }
}

function parseOutcome(input: unknown): AppEditOutcome {
  const value = record(input);
  if (value['applied'] === true) {
    return { applied: true };
  }
  const reason = value['reason'];
  if (value['applied'] === false && typeof reason === 'string' && reason.length > 0) {
    return { applied: false, reason: reason.slice(0, 500) };
  }
  throw new Error('A storage write answers applied, or not with a reason');
}

function writerToken(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `desktop-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** `canvas.snapshot` on Desktop: main photographs this region of the window (window CSS pixels) as a PNG data URL. */
export async function captureCanvasSnapshot(
  rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  widthMax: number,
): Promise<AppSnapshotOutcome> {
  if (typeof window.avb.appCanvasSnapshot !== 'function') {
    return { applied: false, reason: 'Restart Stacki to take canvas snapshots' };
  }
  const input = parseIpcPayload('apps:canvasSnapshot', { rect, widthMax });
  const answer = parseAppsResult(await invoke(() => window.avb.appCanvasSnapshot(input)), parseSnapshotReply);
  return answer.ok ? { applied: true, ...answer.value } : { applied: false, reason: answer.message };
}

// Main's PNG, checked as any reply: a data URL within the byte bound (base64 grows bytes by 4/3), and a positive size.
function parseSnapshotReply(value: unknown): { readonly url: string; readonly width: number; readonly height: number } {
  const reply = record(value);
  const url = reply['url'];
  const width = reply['width'];
  const height = reply['height'];
  const charsMax = Math.ceil((APP_RPC_LIMITS.snapshotBytesMax * 4) / 3) + 32;
  if (typeof url !== 'string' || !url.startsWith('data:image/png;base64,') || url.length > charsMax) {
    throw new Error('A snapshot is a PNG data URL within its bound');
  }
  if (typeof width !== 'number' || !Number.isSafeInteger(width) || width < 1) {
    throw new Error('A snapshot has a width');
  }
  if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('A snapshot has a height');
  }
  return { url, width, height };
}
