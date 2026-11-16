// Effects: the changes a plan cannot express as the text of a settings file: moving a component, creating or deleting component files, creating
// or deleting an installed app's folder.
//
// An effect is DATA (a kind and a JSON record that says everything needed to do it, to do the opposite, and to show it in a plan), never a closure.
// That is what lets the undo journal hold it and `stacki undo` run its opposite after the process is gone, and why a test can inject a failing
// applier. Each kind registers four functions: read the record at the boundary, apply it (all or nothing by itself), name its opposite, and say what
// it changes. The byte-file kinds live here; the component kinds register from electron/handlers (cliComponentCommands.ts), where the app's
// component planner lives, so this folder never imports upward.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, ok, type Result } from '../../../shared/core/result';
import { toArray, toRecord } from '../../../shared/core/record';
import type { CliError, PlannedFile } from '../../../shared/properties/cli/stackiOutput';

export const EFFECT_LIMITS = {
  /** Files in one effect: a component folder or an app bundle. */
  filesMax: 50_000,
  /** Effects in one command. */
  effectsMax: 16,
} as const satisfies Record<string, number>;

/** One effect as it is journalled: its kind and the record that kind reads. */
export interface EffectRecord {
  readonly kind: string;
  readonly data: unknown;
}

/** What a kind knows how to do. `data` is whatever `read` returned: the kind's own typed record. */
export interface EffectKind {
  readonly read: (data: unknown) => Result<unknown, CliError>;
  readonly apply: (root: string, data: unknown) => Result<void, CliError>;
  /** The record of the effect that undoes this one. */
  readonly reverse: (data: unknown) => EffectRecord;
  readonly describe: (data: unknown) => readonly PlannedFile[];
}

// The one piece of module state of the CLI: the kinds registered at startup (here, and by cliComponentCommands.ts). A registry is what lets the
// component kinds live where the planner lives without this folder importing upward; it is only written at load.
const kinds = new Map<string, EffectKind>();

export function registerEffectKind(kind: string, implementation: EffectKind): void {
  kinds.set(kind, implementation);
}

export function effectKind(kind: string): EffectKind | undefined {
  return kinds.get(kind);
}

/** The applier a run uses; tests replace it to inject a failure or a failing writer. */
export interface EffectApplier {
  readonly apply: (root: string, record: EffectRecord) => Result<void, CliError>;
}

export const DEFAULT_EFFECTS: EffectApplier = {
  apply: (root, record) => {
    const kind = kinds.get(record.kind);
    if (kind === undefined) {
      return err({ code: 'internal', message: `No effect named "${record.kind}" is registered.` });
    }
    const data = kind.read(record.data);
    return data.ok ? kind.apply(root, data.value) : data;
  },
};

export function reverseEffect(record: EffectRecord): Result<EffectRecord, CliError> {
  const kind = kinds.get(record.kind);
  if (kind === undefined) {
    return err({ code: 'refused', message: `That undo entry holds an effect ("${record.kind}") this build does not know.` });
  }
  const data = kind.read(record.data);
  return data.ok ? ok(kind.reverse(data.value)) : data;
}

export function describeEffect(record: EffectRecord): readonly PlannedFile[] {
  const kind = kinds.get(record.kind);
  const data = kind?.read(record.data);
  return kind === undefined || data === undefined || !data.ok ? [] : kind.describe(data.value);
}

/** A journalled effect read back: the kind must be one this build knows, the record one it accepts. */
export function parseEffectRecord(input: unknown): Result<EffectRecord, CliError> {
  const value = toRecord(input);
  const kind = typeof value?.['kind'] === 'string' ? kinds.get(value['kind']) : undefined;
  if (value === undefined || kind === undefined || typeof value['kind'] !== 'string') {
    return err({ code: 'refused', message: 'That undo entry holds an effect this build does not know.' });
  }
  const data = kind.read(value['data']);
  return data.ok ? ok({ kind: value['kind'], data: value['data'] }) : data;
}

// ----- byte files: an installed app's folder -----

/** Files by project-relative path, their bytes as base64: an app's images are not text. */
export interface ByteFilesRecord {
  readonly files: readonly { readonly file: string; readonly base64: string }[];
}

const SAFE_PATH = /^\.stacki\/apps\/[a-z0-9][a-z0-9-]*\/[A-Za-z0-9._/-]+$/;

function readByteFiles(data: unknown): Result<ByteFilesRecord, CliError> {
  const list = toArray(toRecord(data)?.['files']);
  if (list === undefined || list.length > EFFECT_LIMITS.filesMax) {
    return err({ code: 'refused', message: 'An app folder record lists its files.' });
  }
  const files: { file: string; base64: string }[] = [];
  for (const item of list) {
    const entry = toRecord(item);
    const file = entry?.['file'];
    const base64 = entry?.['base64'];
    if (
      typeof file !== 'string' ||
      typeof base64 !== 'string' ||
      !SAFE_PATH.test(file) ||
      file.split('/').some((part) => part === '..' || part === '.' || part === '')
    ) {
      return err({ code: 'refused', message: 'An app folder record names a file outside .stacki/apps/<id>/.' });
    }
    files.push({ file, base64 });
  }
  return ok({ files });
}

function absoluteOf(root: string, file: string): string {
  return path.join(root, ...file.split('/'));
}

function writeBytes(root: string, data: ByteFilesRecord): Result<void, CliError> {
  const made: string[] = [];
  try {
    for (const entry of data.files) {
      const absolute = absoluteOf(root, entry.file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, Buffer.from(entry.base64, 'base64'), { flag: 'wx' });
      made.push(absolute);
    }
    return ok(undefined);
  } catch (error: unknown) {
    for (const absolute of made) {
      fs.rmSync(absolute, { force: true });
    }
    removeEmptyDirectories(root, data);
    return err({ code: 'write-failed', message: `The app files could not be written: ${error instanceof Error ? error.message : String(error)}` });
  }
}

function deleteBytes(root: string, data: ByteFilesRecord): Result<void, CliError> {
  for (const entry of data.files) {
    const absolute = absoluteOf(root, entry.file);
    if (!fs.existsSync(absolute) || !Buffer.from(entry.base64, 'base64').equals(fs.readFileSync(absolute))) {
      return err({ code: 'conflict', message: `${entry.file} is not what was installed (changed or missing), so the folder is not removed.` });
    }
  }
  for (const entry of data.files) {
    fs.rmSync(absoluteOf(root, entry.file), { force: true });
  }
  removeEmptyDirectories(root, data);
  return ok(undefined);
}

// Removes the folders the files lived in, deepest first, while they are empty.
function removeEmptyDirectories(root: string, data: ByteFilesRecord): void {
  const directories = new Set<string>();
  for (const entry of data.files) {
    let directory = path.dirname(entry.file);
    for (let depth = 0; depth < 16 && directory.startsWith('.stacki/apps/') && directory.split('/').length >= 3; depth += 1) {
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  for (const directory of [...directories].sort((first, second) => second.length - first.length)) {
    const absolute = absoluteOf(root, directory);
    if (fs.existsSync(absolute) && fs.readdirSync(absolute).length === 0) {
      fs.rmdirSync(absolute);
    }
  }
}

function describeBytes(action: 'create' | 'delete', data: ByteFilesRecord): readonly PlannedFile[] {
  return data.files.map((entry) => ({ file: entry.file, action, changes: [] }));
}

registerEffectKind('files-write', {
  read: readByteFiles,
  apply: (root, data) => writeBytes(root, readOrEmpty(data)),
  reverse: (data) => ({ kind: 'files-delete', data }),
  describe: (data) => describeBytes('create', readOrEmpty(data)),
});

registerEffectKind('files-delete', {
  read: readByteFiles,
  apply: (root, data) => deleteBytes(root, readOrEmpty(data)),
  reverse: (data) => ({ kind: 'files-write', data }),
  describe: (data) => describeBytes('delete', readOrEmpty(data)),
});

function readOrEmpty(data: unknown): ByteFilesRecord {
  const read = readByteFiles(data);
  return read.ok ? read.value : { files: [] };
}
