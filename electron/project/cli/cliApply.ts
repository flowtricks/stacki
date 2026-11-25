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
import { DEFAULT_EFFECTS, EFFECT_LIMITS, parseEffectRecord, reverseEffect, type EffectApplier, type EffectRecord } from './cliEffects';

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
  /** Runs effects; tests replace it to inject a failure. */
  readonly effects?: EffectApplier;
}

export async function applyStaged(
  root: string,
  command: string,
  files: readonly StagedFile[],
  effects: readonly EffectRecord[],
  options: ApplyOptions,
): Promise<Result<{ readonly undoId: string }, CliError>> {
  const applier = options.effects ?? DEFAULT_EFFECTS;
  const lock = await acquireProjectLock(root, { waitSeconds: options.waitSeconds });
  if (!lock.ok) {
    return lock;
  }
  try {
    const stale = firstChanged(root, files);
    if (stale !== undefined) {
      return err({ code: 'conflict', message: `${stale} changed since the plan was made; nothing was written. Plan again.` });
    }
    // Effects first: each is all-or-nothing by itself, and the settings files that name what they made or removed are written after them.
    const done: EffectRecord[] = [];
    for (const record of effects) {
      const result = applier.apply(root, record);
      if (!result.ok) {
        const failed = undoEffects(root, done, applier);
        return err({
          code: result.error.code === 'locked' || result.error.code === 'conflict' ? result.error.code : 'write-failed',
          message: `${result.error.message} ${putBackText(failed)}`,
        });
      }
      done.push(record);
    }
    const written: StagedFile[] = [];
    for (const file of files) {
      const result = file.after === undefined ? options.writer.remove(root, file.schema) : options.writer.write(root, file.schema, file.after, file.before);
      if (!result.ok) {
        const failed = [...rollback(root, written, options.writer), ...undoEffects(root, done, applier)];
        return err({
          code: result.error.code === 'locked' || result.error.code === 'conflict' ? result.error.code : 'write-failed',
          message: `${result.error.message} ${putBackText(failed)}`,
        });
      }
      written.push(file);
    }
    return ok({ undoId: remember(root, command, files, effects) });
  } finally {
    lock.value.release();
  }
}

function putBackText(failed: readonly string[]): string {
  return failed.length === 0 ? 'Every file already written was put back.' : `These could not be put back and need attention: ${failed.join(', ')}.`;
}

/** Runs the opposite of each applied effect, newest first; returns what could not be put back. */
function undoEffects(root: string, done: readonly EffectRecord[], applier: EffectApplier): readonly string[] {
  const failed: string[] = [];
  for (const record of [...done].reverse()) {
    const opposite = reverseEffect(record);
    const result = opposite.ok ? applier.apply(root, opposite.value) : opposite;
    if (!result.ok) {
      failed.push(`${record.kind} (${result.error.message})`);
    }
  }
  return failed;
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

function remember(root: string, command: string, files: readonly StagedFile[], effects: readonly EffectRecord[]): string {
  const id = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
  const directory = journalDirectory(root);
  fs.mkdirSync(directory, { recursive: true });
  const entry = {
    version: 1,
    id,
    command,
    at: new Date().toISOString(),
    effects,
    files: files.map((file) => ({
      file: file.schema.file,
      ...(file.before === undefined ? {} : { before: file.before }),
      ...(file.after === undefined ? {} : { after: file.after }),
    })),
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
  readonly after: string | undefined;
}

function readJournal(
  root: string,
  id: string,
): Result<{ readonly command: string; readonly files: readonly JournalFile[]; readonly effects: readonly EffectRecord[] }, CliError> {
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
        (record['after'] !== undefined && typeof record['after'] !== 'string') ||
        (record['before'] !== undefined && typeof record['before'] !== 'string')
      ) {
        return err({ code: 'refused', message: 'That undo entry names a file the CLI does not manage.' });
      }
      files.push({
        schema,
        before: typeof record['before'] === 'string' ? record['before'] : undefined,
        after: typeof record['after'] === 'string' ? record['after'] : undefined,
      });
    }
    const recorded = toArray(entry['effects']) ?? [];
    if (recorded.length > EFFECT_LIMITS.effectsMax) {
      return err({ code: 'refused', message: 'That undo entry lists too many effects.' });
    }
    const effects: EffectRecord[] = [];
    for (const item of recorded) {
      const parsed = parseEffectRecord(item);
      if (!parsed.ok) {
        return parsed;
      }
      effects.push(parsed.value);
    }
    return ok({ command: entry['command'], files, effects });
  } catch {
    return err({ code: 'missing', message: `There is no undo entry ${id}; only the last ${JOURNAL_LIMITS.entriesMax} applies are kept.` });
  }
}

/** The files `stacki undo` would put back, or why it cannot: a file changed since the apply is never overwritten. */
export function planUndo(root: string, id: string): Result<{ readonly files: readonly StagedFile[]; readonly effects: readonly EffectRecord[] }, CliError> {
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
  // The opposite of each effect, in the opposite order.
  const effects: EffectRecord[] = [];
  for (const record of [...entry.value.effects].reverse()) {
    const opposite = reverseEffect(record);
    if (!opposite.ok) {
      return opposite;
    }
    effects.push(opposite.value);
  }
  return ok({ files: staged, effects });
}
