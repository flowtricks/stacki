// Applying a staged plan: all files or none, with the undo journal.
//
// The order: take the CLI project lock; check every file still holds the text the plan read (a changed file is a `conflict`, nothing written);
// write each file through the app's actor-backed path; on the first failure put every file already written back (the actor witnesses the bytes it
// replaces, so a rollback also refuses to overwrite a change someone made in between); then record one journal entry, which `stacki undo <id>`
// replays. The journal is the CLI's own: Desktop's in-memory undo stack cannot be fed from outside the process, so git remains the app's durable history.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { err, ok, type Result } from '../../../shared/core/result';
import { toArray, toRecord } from '../../../shared/core/record';
import type { CliError } from '../../../shared/properties/cli/stackiOutput';
import { fileSchemaByPath } from '../../../shared/properties/cli/stackiFiles';
import type { FileSchema } from '../../../shared/properties/cli/stackiSchema';
import { readFileState, removeFile, writeFileText } from './cliFiles';
import { acquireProjectLock } from './cliLock';
import type { StagedFile } from './cliPlan';

export const JOURNAL_LIMITS = {
  /** Applies whose undo is kept; the oldest is forgotten past this. */
  entriesMax: 16,
} as const satisfies Record<string, number>;

/** The file operations an apply uses; tests replace it to inject a failure. */
export interface FileWriter {
  readonly write: (root: string, schema: FileSchema, source: string, base: string | undefined) => Result<void, CliError>;
  readonly remove: (root: string, schema: FileSchema) => Result<void, CliError>;
}

export const DEFAULT_WRITER: FileWriter = { write: writeFileText, remove: removeFile };

export interface ApplyOptions {
  readonly waitSeconds: number;
  readonly writer: FileWriter;
}

export async function applyStaged(
  root: string,
  command: string,
  files: readonly StagedFile[],
  options: ApplyOptions,
): Promise<Result<{ readonly undoId: string }, CliError>> {
  const lock = await acquireProjectLock(root, { waitSeconds: options.waitSeconds });
  if (!lock.ok) {
    return lock;
  }
  try {
    const stale = firstChanged(root, files);
    if (stale !== undefined) {
      return err({ code: 'conflict', message: `${stale} changed since the plan was made; nothing was written. Plan again.` });
    }
    const written: StagedFile[] = [];
    for (const file of files) {
      const result = file.after === undefined ? options.writer.remove(root, file.schema) : options.writer.write(root, file.schema, file.after, file.before);
      if (!result.ok) {
        const failed = rollback(root, written, options.writer);
        const suffix =
          failed.length === 0 ? 'Every file already written was put back.' : `These files could not be put back and need attention: ${failed.join(', ')}.`;
        return err({
          code: result.error.code === 'locked' || result.error.code === 'conflict' ? result.error.code : 'write-failed',
          message: `${result.error.message} ${suffix}`,
        });
      }
      written.push(file);
    }
    return ok({ undoId: remember(root, command, files) });
  } finally {
    lock.value.release();
  }
}

function firstChanged(root: string, files: readonly StagedFile[]): string | undefined {
  for (const file of files) {
    const state = readFileState(root, file.schema);
    if (!state.ok || state.value.source !== file.before) {
      return file.schema.file;
    }
  }
  return undefined;
}

/** Puts back files in reverse order; returns the files that could not be put back. */
function rollback(root: string, written: readonly StagedFile[], writer: FileWriter): readonly string[] {
  const failed: string[] = [];
  for (const file of [...written].reverse()) {
    const result = file.before === undefined ? writer.remove(root, file.schema) : writer.write(root, file.schema, file.before, file.after);
    if (!result.ok) {
      failed.push(file.schema.file);
    }
  }
  return failed;
}

function journalDirectory(root: string): string {
  return path.join(root, '.stacki', 'io', 'cli-journal');
}

function remember(root: string, command: string, files: readonly StagedFile[]): string {
  const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const directory = journalDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const entry = {
    version: 1,
    id,
    command,
    at: new Date().toISOString(),
    files: files.map((file) => ({ file: file.schema.file, ...(file.before === undefined ? {} : { before: file.before }), after: file.after })),
  };
  const temporary = path.join(directory, `${id}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(entry, undefined, 2)}\n`);
  fs.renameSync(temporary, path.join(directory, `${id}.json`));
  const names = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - JOURNAL_LIMITS.entriesMax))) {
    fs.rmSync(path.join(directory, name), { force: true });
  }
  return id;
}

interface JournalFile {
  readonly schema: FileSchema;
  readonly before: string | undefined;
  readonly after: string;
}

function readJournal(root: string, id: string): Result<{ readonly command: string; readonly files: readonly JournalFile[] }, CliError> {
  if (!/^[a-z0-9]{8,40}$/.test(id)) {
    return err({ code: 'usage', message: 'An undo id is the letters and digits "stacki" printed after an apply.' });
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(journalDirectory(root), `${id}.json`), 'utf8'));
    const entry = toRecord(parsed);
    const list = toArray(entry?.['files']);
    if (entry === undefined || list === undefined || typeof entry['command'] !== 'string') {
      return err({ code: 'refused', message: 'That undo entry is not readable.' });
    }
    const files: JournalFile[] = [];
    for (const item of list) {
      const record = toRecord(item);
      const schema = typeof record?.['file'] === 'string' ? fileSchemaByPath(record['file']) : undefined;
      if (
        record === undefined ||
        schema === undefined ||
        typeof record['after'] !== 'string' ||
        (record['before'] !== undefined && typeof record['before'] !== 'string')
      ) {
        return err({ code: 'refused', message: 'That undo entry names a file the CLI does not manage.' });
      }
      files.push({ schema, before: typeof record['before'] === 'string' ? record['before'] : undefined, after: record['after'] });
    }
    return ok({ command: entry['command'], files });
  } catch {
    return err({ code: 'missing', message: `There is no undo entry ${id}; only the last ${JOURNAL_LIMITS.entriesMax} applies are kept.` });
  }
}

/** The files `stacki undo` would put back, or why it cannot: a file changed since the apply is never overwritten. */
export function planUndo(root: string, id: string): Result<readonly StagedFile[], CliError> {
  const entry = readJournal(root, id);
  if (!entry.ok) {
    return entry;
  }
  const staged: StagedFile[] = [];
  for (const file of entry.value.files) {
    const state = readFileState(root, file.schema);
    if (!state.ok) {
      return state;
    }
    if (state.value.source !== file.after) {
      return err({ code: 'conflict', message: `${file.schema.file} changed since "${entry.value.command}" was applied, so it is not put back.` });
    }
    staged.push({ schema: file.schema, before: file.after, after: file.before });
  }
  return ok(staged);
}
