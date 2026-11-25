import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { MAX_SOURCE, string } from '../../shared/validation';

// Stacki's synchronous CSS engine operates only on this request's bounded snapshot.
// It cannot touch disk; validated changes are committed through Studio's rooms.
export const VARIABLE_ROOT = '/studio';
// The whole snapshot's bound, which one file in it cannot pass.
const SNAPSHOT_FILE_CHARS_MAX = 32_000_000;
export const MAIN_LIMITS = { cssVariableFileBytesMax: MAX_SOURCE };
const workspace = new AsyncLocalStorage<Map<string, string>>();
export function withVariableWorkspace<T>(files: Map<string, string>, run: () => T): T {
  return workspace.run(files, run);
}
function files() {
  const current = workspace.getStore();
  if (!current) {
    throw new Error('Variable operation requires a draft snapshot');
  }
  return current;
}
// Only the snapshot's own keys are ever read or replaced; which of them may be saved is decided before the commit
// (variableServer.ts). Refusing a name here would make the engine skip that file, and a rename miss it.
function relative(absolute: string) {
  return path.relative(VARIABLE_ROOT, absolute).split(path.sep).join('/');
}
function readFileSync(absolute: string, _encoding: 'utf8') {
  const text = files().get(relative(absolute));
  if (text === undefined) {
    throw new Error('Source is outside this draft snapshot');
  }
  return text;
}
export function writeProjectText(absolute: string, text: string) {
  const file = relative(absolute);
  if (!files().has(file)) {
    throw new Error('Variables can only edit existing project source');
  }
  files().set(file, string(text, SNAPSHOT_FILE_CHARS_MAX));
}
export interface VariableEntry {
  readonly name: string;
  readonly isDirectory: () => boolean;
}
function readdirSync(directory: string, _options: { withFileTypes: true }): VariableEntry[] {
  const prefix = path.relative(VARIABLE_ROOT, directory).split(path.sep).join('/');
  if (prefix && !/^(src|public)(\/|$)/.test(prefix)) {
    return [];
  }
  const start = prefix ? prefix + '/' : '';
  const entries = new Map<string, boolean>();
  for (const file of files().keys()) {
    if (!file.startsWith(start)) {
      continue;
    }
    const parts = file.slice(start.length).split('/');
    const name = parts[0];
    if (name) {
      entries.set(name, parts.length > 1);
    }
  }
  return [...entries].map(([name, directory]) => ({ name, isDirectory: () => directory }));
}
export const variableFiles = {
  readFileSync,
  readdirSync,
  statSync: (absolute: string) => ({ size: Buffer.byteLength(readFileSync(absolute, 'utf8')) }),
};
