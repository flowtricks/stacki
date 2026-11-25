// `stacki components rename|move|duplicate|delete`: the Components panel's own planner, driven from the command line.
//
// Nothing is re-implemented. A rename or move is planned by `planComponentRenameWork` and written by `applyComponentRename` (witnessed leased writes
// through the document actors, the file moved last, every text put back on a failure); a duplicate is planned by `planDuplicateTarget` and written by
// `writeCopy`; a delete is planned by `planRemoveTarget` (which refuses a component still used: "Used in N places") and its `.stacki` cleanup is the
// app's own `MetadataChange`s. This file only turns those plans into CLI effects (data the undo journal can hold, cliEffects.ts) and registers them.
//
// Deleting from the command line cannot reach the operating system's Trash (that is Electron's `shell.trashItem`), so a deletion is kept in the CLI
// undo journal, text for text; `stacki undo <id>` writes every file back through the actors, and the cleaned `.stacki` settings are put back only
// while they still read as the deletion left them (the file-change check of every journalled text).
import fs from 'node:fs';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { toArray, toRecord } from '../../shared/core/record';
import type { ComponentOpTarget } from '../../shared/properties/componentOps';
import { fileSchemaById } from '../../shared/properties/cli/stackiFiles';
import type { CliError, PlannedFile } from '../../shared/properties/cli/stackiOutput';
import { createProjectText } from '../documents/documentWrites';
import { runSync } from '../lib/slicedWork';
import { desktopRenameWriter } from '../project/pageRenameDesktop';
import type { RenameWriter } from '../project/pageRenameWrite';
import { registerEffectKind, type EffectRecord } from '../project/cli/cliEffects';
import { registerCommandHandler } from '../project/cli/cliRun';
import type { CommandContext, Outcome } from '../project/cli/cliCommands';
import type { Edit } from '../project/cli/cliPlan';
import { planDuplicateTarget, planRemoveTarget, writeCopy, type MetadataChange, type TargetFile } from './componentOps';
import { applyComponentRename } from './componentRenameApply';
import { planComponentRenameWork, projectNamingStyle, type ComponentRenamePlan } from './componentRenamePlan';
import { isComponentFileName, normalizeComponentName } from '../../shared/properties/componentNaming';

export const COMPONENT_EFFECT_LIMITS = {
  /** Files one component effect lists (a folder copy or delete is bounded by COMPONENT_OP_LIMITS; a rename by the project). */
  filesMax: 200_000,
} as const satisfies Record<string, number>;

interface TextFile {
  readonly file: string;
  readonly text: string;
}
interface RenameText {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}
interface RenameRecord {
  readonly from: string;
  readonly to: string;
  readonly texts: readonly RenameText[];
  readonly witnesses: readonly { readonly file: string; readonly digest: string }[];
}
interface CopyRecord {
  readonly source: string;
  readonly destination: string;
  readonly folder: 'folder' | 'file';
  readonly files: readonly TextFile[];
}
interface FilesRecord {
  readonly files: readonly TextFile[];
  readonly directories: readonly string[];
}

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });

// ----- reading records at the journal boundary -----

function strings(input: unknown, max: number): readonly string[] | undefined {
  const list = toArray(input);
  return list !== undefined && list.length <= max && list.every((item) => typeof item === 'string') ? list.map(String) : undefined;
}

function textFiles(input: unknown): readonly TextFile[] | undefined {
  const list = toArray(input);
  if (list === undefined || list.length > COMPONENT_EFFECT_LIMITS.filesMax) {
    return undefined;
  }
  const files: TextFile[] = [];
  for (const item of list) {
    const entry = toRecord(item);
    if (typeof entry?.['file'] !== 'string' || typeof entry['text'] !== 'string' || !safeRelative(entry['file'])) {
      return undefined;
    }
    files.push({ file: entry['file'], text: entry['text'] });
  }
  return files;
}

function safeRelative(file: string): boolean {
  return file.length > 0 && !file.startsWith('/') && !file.includes('\\') && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function readRename(data: unknown): Result<RenameRecord, CliError> {
  const value = toRecord(data);
  const texts = toArray(value?.['texts']);
  const witnesses = toArray(value?.['witnesses']);
  if (
    typeof value?.['from'] !== 'string' ||
    typeof value['to'] !== 'string' ||
    !safeRelative(value['from']) ||
    !safeRelative(value['to']) ||
    texts === undefined ||
    witnesses === undefined
  ) {
    return refused('That rename record is not readable.');
  }
  const readTexts: RenameText[] = [];
  for (const item of texts) {
    const entry = toRecord(item);
    if (typeof entry?.['file'] !== 'string' || typeof entry['before'] !== 'string' || typeof entry['after'] !== 'string' || !safeRelative(entry['file'])) {
      return refused('That rename record names a text it cannot read.');
    }
    readTexts.push({ file: entry['file'], before: entry['before'], after: entry['after'] });
  }
  const readWitnesses: { file: string; digest: string }[] = [];
  for (const item of witnesses) {
    const entry = toRecord(item);
    if (typeof entry?.['file'] !== 'string' || typeof entry['digest'] !== 'string') {
      return refused('That rename record names a witness it cannot read.');
    }
    readWitnesses.push({ file: entry['file'], digest: entry['digest'] });
  }
  return ok({ from: value['from'], to: value['to'], texts: readTexts, witnesses: readWitnesses });
}

function readFilesRecord(data: unknown): Result<FilesRecord, CliError> {
  const value = toRecord(data);
  const files = textFiles(value?.['files']);
  const directories = strings(value?.['directories'], COMPONENT_EFFECT_LIMITS.filesMax);
  if (files === undefined || directories === undefined || !directories.every(safeRelative)) {
    return refused('That component record is not readable.');
  }
  return ok({ files, directories });
}

function readCopy(data: unknown): Result<CopyRecord, CliError> {
  const value = toRecord(data);
  const files = textFiles(value?.['files']);
  if (
    typeof value?.['source'] !== 'string' ||
    typeof value['destination'] !== 'string' ||
    !safeRelative(value['source']) ||
    !safeRelative(value['destination']) ||
    files === undefined
  ) {
    return refused('That copy record is not readable.');
  }
  return ok({ source: value['source'], destination: value['destination'], folder: value['folder'] === 'folder' ? 'folder' : 'file', files });
}

// ----- appliers -----

/** The writer a rename uses; tests replace it (with the actor writer wrapped to fail) through `setRenameWriter`. */
let renameWriter: () => RenameWriter = desktopRenameWriter;

export function setRenameWriter(writer: () => RenameWriter): void {
  renameWriter = writer;
}

function applyRename(root: string, record: RenameRecord): Result<void, CliError> {
  const plan: ComponentRenamePlan = {
    root,
    change: { from: record.from, to: record.to },
    texts: record.texts,
    witnesses: record.witnesses,
    summary: { from: record.from, to: record.to, files: [], notices: [] },
  };
  const applied = applyComponentRename(plan, renameWriter());
  if (applied.ok) {
    return ok(undefined);
  }
  return err({ code: applied.error.code === 'conflict' ? 'conflict' : 'write-failed', message: applied.error.message });
}

function absolute(root: string, file: string): string {
  return path.join(root, ...file.split('/'));
}

function applyCopy(root: string, record: CopyRecord): Result<void, CliError> {
  const files: TargetFile[] = record.files.map((entry) => ({ rel: entry.file, absolute: absolute(root, entry.file), text: entry.text }));
  const written = writeCopy(absolute(root, record.source), absolute(root, record.destination), files);
  return written.ok ? ok(undefined) : err({ code: 'write-failed', message: written.error.message });
}

function applyRemove(root: string, record: FilesRecord): Result<void, CliError> {
  for (const entry of record.files) {
    const file = absolute(root, entry.file);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== entry.text) {
      return err({ code: 'conflict', message: `${entry.file} is not what was recorded (changed or missing), so it is not removed.` });
    }
  }
  for (const entry of record.files) {
    fs.rmSync(absolute(root, entry.file), { force: true });
  }
  for (const directory of [...record.directories].sort((first, second) => second.length - first.length)) {
    const folder = absolute(root, directory);
    if (fs.existsSync(folder) && fs.readdirSync(folder).length === 0) {
      fs.rmdirSync(folder);
    }
  }
  return ok(undefined);
}

function applyRestore(root: string, record: FilesRecord): Result<void, CliError> {
  const made: string[] = [];
  try {
    for (const directory of record.directories) {
      fs.mkdirSync(absolute(root, directory), { recursive: true });
    }
    for (const entry of record.files) {
      const file = absolute(root, entry.file);
      if (fs.existsSync(file)) {
        throw new Error(`${entry.file} already exists`);
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      createProjectText(file, entry.text);
      made.push(file);
    }
    return ok(undefined);
  } catch (error: unknown) {
    for (const file of made) {
      fs.rmSync(file, { force: true });
    }
    return err({ code: 'write-failed', message: `The component files could not be written back: ${error instanceof Error ? error.message : String(error)}` });
  }
}

// ----- effect kinds -----

function copiedFiles(record: CopyRecord): readonly TextFile[] {
  return record.files.map((entry) => ({
    file: record.folder === 'folder' ? `${record.destination}/${entry.file.slice(record.source.length + 1)}` : record.destination,
    text: entry.text,
  }));
}

function copiedDirectories(record: CopyRecord): readonly string[] {
  if (record.folder === 'file') {
    return [];
  }
  const directories = new Set<string>([record.destination]);
  for (const entry of copiedFiles(record)) {
    let directory = path.posix.dirname(entry.file);
    for (let depth = 0; depth < 16 && directory.startsWith(`${record.destination}/`); depth += 1) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return [...directories];
}

const created = (files: readonly TextFile[]): readonly PlannedFile[] => files.map((entry) => ({ file: entry.file, action: 'create', changes: [] }));

registerEffectKind('component-rename', {
  read: readRename,
  apply: (root, data) => {
    const record = readRename(data);
    return record.ok ? applyRename(root, record.value) : record;
  },
  reverse: (data) => {
    const record = readRename(data);
    const value = record.ok ? record.value : { from: '', to: '', texts: [], witnesses: [] };
    const texts = value.texts.map((entry) => ({ file: entry.file === value.from ? value.to : entry.file, before: entry.after, after: entry.before }));
    return { kind: 'component-rename', data: { from: value.to, to: value.from, texts, witnesses: [] } };
  },
  describe: (data) => {
    const record = readRename(data);
    return record.ok
      ? [
          ...record.value.texts.map((entry): PlannedFile => ({ file: entry.file, action: 'modify', changes: [] })),
          { file: record.value.to, action: 'move', from: record.value.from, changes: [] },
        ]
      : [];
  },
});

registerEffectKind('component-copy', {
  read: readCopy,
  apply: (root, data) => {
    const record = readCopy(data);
    return record.ok ? applyCopy(root, record.value) : record;
  },
  reverse: (data) => {
    const record = readCopy(data);
    const value = record.ok ? record.value : { source: '', destination: '', folder: 'file' as const, files: [] };
    return { kind: 'component-remove', data: { files: copiedFiles(value), directories: copiedDirectories(value) } };
  },
  describe: (data) => {
    const record = readCopy(data);
    return record.ok ? created(copiedFiles(record.value)) : [];
  },
});

registerEffectKind('component-remove', {
  read: readFilesRecord,
  apply: (root, data) => {
    const record = readFilesRecord(data);
    return record.ok ? applyRemove(root, record.value) : record;
  },
  reverse: (data) => ({ kind: 'component-restore', data }),
  describe: (data) => {
    const record = readFilesRecord(data);
    return record.ok ? record.value.files.map((entry): PlannedFile => ({ file: entry.file, action: 'delete', changes: [] })) : [];
  },
});

registerEffectKind('component-restore', {
  read: readFilesRecord,
  apply: (root, data) => {
    const record = readFilesRecord(data);
    return record.ok ? applyRestore(root, record.value) : record;
  },
  reverse: (data) => ({ kind: 'component-remove', data }),
  describe: (data) => {
    const record = readFilesRecord(data);
    return record.ok ? created(record.value.files) : [];
  },
});

// ----- commands -----

function textOf(context: CommandContext, name: string): string {
  const value = context.args[name];
  return typeof value === 'string' ? value : '';
}

function targetOf(path: string): ComponentOpTarget {
  return { kind: path.endsWith('.astro') ? 'component' : 'folder', path };
}

function planRename(context: CommandContext, to: string, extraNotes: readonly string[] = []): Result<Outcome, CliError> {
  const from = textOf(context, 'path');
  const plan = runSync(planComponentRenameWork(context.root, { from, to }));
  if (!plan.ok) {
    return refused(plan.error.message, plan.error.code === 'invalid' || plan.error.code === 'missing' ? 'invalid-value' : 'refused');
  }
  const record: EffectRecord = { kind: 'component-rename', data: { from, to, texts: plan.value.texts, witnesses: plan.value.witnesses } };
  const reported = plan.value.summary.notices.map((notice) => `Not changed (${notice.kind}): ${notice.file}`);
  return ok({
    kind: 'write',
    edits: [],
    effects: [record],
    summary: `Rename ${from} to ${to}: ${plan.value.summary.files.length} files will be updated.`,
    notes: [
      `${plan.value.summary.files.length} files will be updated: ${plan.value.summary.files.map((file) => file.file).join(', ') || 'none besides the move'}.`,
      ...extraNotes,
      ...reported,
    ],
  });
}

function rename(context: CommandContext): Result<Outcome, CliError> {
  const from = textOf(context, 'path');
  const typed = textOf(context, 'name')
    .trim()
    .replace(/\.astro$/, '');
  // The same normalizer as the Rename dialog: "Accordion Cards" is AccordionCards (or accordion-cards in a dashed project).
  const normalized = normalizeComponentName(typed, projectNamingStyle(context.root));
  const stray = normalized.rejected[0];
  if (stray !== undefined) {
    return refused(`"${stray}" cannot be used in a component name.`, 'invalid-value');
  }
  if (!isComponentFileName(normalized.fileName)) {
    return refused(`"${typed}" is not a component name: letters and digits, not starting with a digit, not reserved.`, 'invalid-value');
  }
  const notes = normalized.fileName === typed ? [] : [`normalized from "${typed}" to ${normalized.fileName}`];
  return planRename(context, `${path.posix.dirname(from)}/${normalized.fileName}.astro`, notes);
}

function move(context: CommandContext): Result<Outcome, CliError> {
  const from = textOf(context, 'path');
  const folder = textOf(context, 'folder').replace(/\/$/, '');
  return planRename(context, `${folder}/${path.posix.basename(from)}`);
}

function duplicate(context: CommandContext): Result<Outcome, CliError> {
  const planned = planDuplicateTarget(context.root, targetOf(textOf(context, 'path')));
  if (!planned.ok) {
    return refused(planned.error.message, 'refused');
  }
  const { resolved, destination, name } = planned.value;
  const rel = (file: string): string => path.relative(context.root, file).split(path.sep).join('/');
  const record: CopyRecord = {
    source: rel(resolved.absolute),
    destination: rel(destination),
    folder: resolved.target.kind === 'folder' ? 'folder' : 'file',
    files: resolved.files.map((file) => ({ file: file.rel, text: file.text })),
  };
  return ok({
    kind: 'write',
    edits: [],
    effects: [{ kind: 'component-copy', data: record }],
    summary: `Duplicate ${record.source} as ${name} (${record.files.length} files).`,
  });
}

function metadataEdit(change: MetadataChange): Edit | undefined {
  // Each metadata kind a deletion cleans has the file id of the same name (components, roles, componentCanvas).
  const schema = fileSchemaById(change.kind);
  if (schema === undefined) {
    return undefined;
  }
  return {
    schema,
    produce: (state) =>
      state.source === change.before ? ok(change.after) : refused(`${schema.file} changed since the plan was made. Plan again.`, 'conflict'),
  };
}

function remove(context: CommandContext): Result<Outcome, CliError> {
  const planned = planRemoveTarget(context.root, targetOf(textOf(context, 'path')), 'refuse');
  if (!planned.ok) {
    return refused(planned.error.message, 'refused');
  }
  const { resolved, changes } = planned.value;
  const rel = (file: string): string => path.relative(context.root, file).split(path.sep).join('/');
  const record: FilesRecord = { files: resolved.files.map((file) => ({ file: file.rel, text: file.text })), directories: resolved.directories.map(rel) };
  const edits = changes.flatMap((change) => metadataEdit(change) ?? []);
  return ok({
    kind: 'write',
    edits,
    effects: [{ kind: 'component-remove', data: record }],
    summary: `Delete ${resolved.target.path} (${record.files.length} files) and the settings that name it.`,
    notes: [
      'Deleted files are kept in the CLI undo journal, not the operating system Trash (which only the app can reach): "stacki undo <id>" writes them back.',
    ],
  });
}

registerCommandHandler('components rename', rename);
registerCommandHandler('components move', move);
registerCommandHandler('components duplicate', duplicate);
registerCommandHandler('components delete', remove);
