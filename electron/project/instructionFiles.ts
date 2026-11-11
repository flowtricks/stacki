// The project's Markdown for the Instructions panel (shared/properties/instructions.ts):
// a bounded walk that lists every file outside build output and hidden paths,
// a bounded read, and writes that go through the files' document actors
// (documentWrites.ts) like every other write of project text. A write names the
// text it was edited from and is refused when the file no longer holds it, so
// an outside edit is never overwritten without the person choosing to.
//
// Paths cross the boundary project-relative; each is resolved here and refused
// unless it, and the nearest folder that exists above it, is inside the project
// once links are followed, and outside the folders the walk never opens.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import {
  INSTRUCTION_LIMITS,
  INSTRUCTIONS_FILE,
  RULE_FOLDERS,
  SKIPPED_DIRECTORIES,
  classifyInstruction,
  hiddenMatcher,
  inRuleFolder,
  isInstructionFileName,
  parseSkillMeta,
  readInstructionSettingsSource,
  splitFrontmatter,
  type InstructionEntry,
  type InstructionListing,
  type InstructionWriteFailure,
  type InstructionWriteResult,
  type SkillMeta,
} from '../../shared/properties/instructions';
import { digestOf } from '../documents/atomicWrite';
import { describeWriteReport, documentHost } from '../documents/documentWrites';

/** Directory entries the walk reads in all, so a folder of a million files cannot stall the panel. */
const ENTRIES_MAX = 200_000;

/** Every Markdown file the panel lists, with the folders inside rule folders. Total: a bound cuts the walk short and says so. */
export function listInstructions(root: string): InstructionListing {
  assert(path.isAbsolute(root), 'listInstructions: the project root is absolute');
  const hidden = hiddenMatcher(readHiddenPatterns(root));
  const files: InstructionEntry[] = [];
  const folders: string[] = [];
  const queue: { readonly relative: string; readonly depth: number }[] = [{ relative: '', depth: 0 }];
  let opened = 0;
  let entries = 0;
  let truncated = false;
  // Breadth first, so a cut-short walk keeps the files nearest the root: the ones agents read.
  while (queue.length > 0) {
    const next = queue.shift();
    assert(next !== undefined, 'The queue had an item');
    if (opened >= INSTRUCTION_LIMITS.directoriesMax || entries >= ENTRIES_MAX) {
      truncated = true;
      break;
    }
    opened += 1;
    const children = readFolder(path.join(root, next.relative));
    entries += children.length;
    for (const child of children) {
      const relative = next.relative === '' ? child.name : `${next.relative}/${child.name}`;
      if (relative.length > INSTRUCTION_LIMITS.pathCharsMax || hidden(relative)) {
        continue;
      }
      if (child.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(child.name)) {
          continue;
        }
        if (next.depth + 1 > INSTRUCTION_LIMITS.depthMax) {
          truncated = true;
          continue;
        }
        if (inRuleFolder(`${relative}/`) && folders.length < INSTRUCTION_LIMITS.foldersMax) {
          folders.push(relative);
        }
        queue.push({ relative, depth: next.depth + 1 });
      } else if (child.isFile() && isInstructionFileName(child.name, next.relative)) {
        if (files.length >= INSTRUCTION_LIMITS.filesMax) {
          truncated = true;
          continue;
        }
        files.push(entryFor(root, relative));
      }
    }
  }
  files.sort((left, right) => compareText(left.path, right.path));
  folders.sort(compareText);
  assert(files.length <= INSTRUCTION_LIMITS.filesMax, 'The listing holds its file bound');
  assert(folders.length <= INSTRUCTION_LIMITS.foldersMax, 'The listing holds its folder bound');
  return { files, folders, truncated };
}

/** A skill's name and description from its file's text. */
export function readSkillMeta(source: string): SkillMeta {
  const split = splitFrontmatter(source);
  if (split.raw === '') {
    return parseSkillMeta(undefined);
  }
  let parsed: unknown;
  try {
    const value: unknown = YAML.parse(split.yaml, { maxAliasCount: 0, prettyErrors: false });
    parsed = value;
  } catch (failure: unknown) {
    return { kind: 'invalid', message: `The frontmatter is not valid YAML: ${failure instanceof Error ? failure.message.split('\n')[0] : String(failure)}` };
  }
  return parseSkillMeta(parsed);
}

/** A listed file's text. */
export function readInstruction(root: string, relative: string): Result<string, { readonly code: InstructionWriteFailure; readonly message: string }> {
  const target = instructionPath(root, relative);
  if (!target.ok) {
    return target;
  }
  try {
    const size = fs.statSync(target.value).size;
    if (size > INSTRUCTION_LIMITS.fileBytesMax) {
      return failure('too-large', `${relative} is larger than ${Math.floor(INSTRUCTION_LIMITS.fileBytesMax / 1024 / 1024)} MB.`);
    }
    const source = fs.readFileSync(target.value, 'utf8');
    if (source.length > INSTRUCTION_LIMITS.fileBytesMax) {
      return failure('too-large', `${relative} grew past the size limit while it was read.`);
    }
    return ok(source);
  } catch (error: unknown) {
    return failure('invalid', error instanceof Error ? error.message : String(error));
  }
}

/** Write a file the person edited from `base`; refused, without writing, when the file no longer holds `base`. */
export function writeInstruction(root: string, relative: string, source: string, base: string): InstructionWriteResult {
  if (source.length > INSTRUCTION_LIMITS.fileBytesMax) {
    return failure('too-large', 'This file is too large to save from the Instructions panel.');
  }
  const current = readInstruction(root, relative);
  if (!current.ok) {
    return current;
  }
  if (current.value !== base) {
    return failure('conflict', `${relative} changed on disk while you were editing.`);
  }
  if (source === base) {
    return ok({ source });
  }
  const target = instructionPath(root, relative);
  assert(target.ok, 'A file just read resolves again');
  const host = documentHost();
  host.noteWrite(target.value);
  const report = host.documents.writeText(target.value, source, digestOf(base));
  if (report.tag !== 'applied') {
    return failure(
      report.tag === 'rejected' && report.reason === 'region-externally-modified' ? 'conflict' : 'write-failed',
      describeWriteReport(relative, report),
    );
  }
  return readBack(root, relative, source);
}

/** Create a new file; never overwrites one that exists. Its folders are created as needed. */
export function createInstruction(root: string, relative: string, source: string): InstructionWriteResult {
  if (source.length > INSTRUCTION_LIMITS.fileBytesMax) {
    return failure('too-large', 'This file is too large to create.');
  }
  const target = instructionPath(root, relative);
  if (!target.ok) {
    return target;
  }
  if (fs.existsSync(target.value)) {
    return failure('exists', `${relative} already exists.`);
  }
  try {
    fs.mkdirSync(path.dirname(target.value), { recursive: true });
  } catch (error: unknown) {
    return failure('write-failed', error instanceof Error ? error.message : String(error));
  }
  const host = documentHost();
  host.noteWrite(target.value);
  const created = host.documents.create(target.value, source);
  if (!created.ok) {
    return failure(created.error.code === 'exists' ? 'exists' : 'write-failed', created.error.message);
  }
  return readBack(root, relative, source);
}

/** Create a folder for rules or docs; one that exists already is refused, so a typo never lands in it silently. */
export function createInstructionFolder(root: string, relative: string): InstructionWriteResult {
  const target = instructionPath(root, relative);
  if (!target.ok) {
    return target;
  }
  if (fs.existsSync(target.value)) {
    return failure('exists', `${relative} already exists.`);
  }
  try {
    fs.mkdirSync(target.value, { recursive: true });
  } catch (error: unknown) {
    return failure('write-failed', error instanceof Error ? error.message : String(error));
  }
  assert(fs.statSync(target.value).isDirectory(), 'A created folder is a folder');
  return ok({ source: '' });
}

/**
 * A project-relative path as an absolute one inside the project, or why not:
 * outside it once links are followed, through a folder the walk skips, or a link itself.
 */
export function instructionPath(root: string, relative: string): Result<string, { readonly code: InstructionWriteFailure; readonly message: string }> {
  assert(path.isAbsolute(root), 'instructionPath: the project root is absolute');
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return failure('invalid', `${relative} is not a path inside the project.`);
  }
  if (segments.slice(0, -1).some((segment) => SKIPPED_DIRECTORIES.has(segment))) {
    return failure('invalid', `${relative} is inside a folder the Instructions panel does not list.`);
  }
  const canonical = fs.realpathSync(root);
  const target = path.join(canonical, ...segments);
  const existing = nearestExisting(target);
  const real = fs.realpathSync(existing);
  const inside = path.relative(canonical, real);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return failure('invalid', `${relative} leads outside the project.`);
  }
  if (existing === target && fs.lstatSync(target).isSymbolicLink()) {
    return failure('invalid', `${relative} is a link; open the file it points to instead.`);
  }
  return ok(target);
}

/** The rule folders the project already has, so a new rule goes beside the others. */
export function ruleFoldersPresent(root: string): readonly string[] {
  return RULE_FOLDERS.filter((folder) => fs.existsSync(path.join(root, ...folder.split('/'))));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHiddenPatterns(root: string): readonly string[] {
  const file = path.join(root, ...INSTRUCTIONS_FILE.split('/'));
  let source: string | undefined;
  try {
    source = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  } catch {
    // An unreadable settings file hides nothing; the Settings tab reports it when opened.
    source = undefined;
  }
  const settings = readInstructionSettingsSource(source);
  return settings.ok ? settings.value.hidden : [];
}

function readFolder(folder: string): readonly fs.Dirent[] {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    // A folder that vanished or cannot be read mid-walk lists nothing; the next change event lists again.
    return [];
  }
}

function entryFor(root: string, relative: string): InstructionEntry {
  const absolute = path.join(root, ...relative.split('/'));
  const section = classifyInstruction(relative);
  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(absolute).size;
  } catch {
    sizeBytes = 0;
  }
  return { path: relative, section, sizeBytes, skill: section === 'skills' ? skillOf(absolute, sizeBytes) : undefined };
}

// Only the head of a skill file is read: the frontmatter is bounded, the body is not needed.
function skillOf(absolute: string, sizeBytes: number): SkillMeta {
  if (sizeBytes > INSTRUCTION_LIMITS.fileBytesMax) {
    return { kind: 'invalid', message: 'This skill file is too large to read.' };
  }
  let head: string;
  try {
    const descriptor = fs.openSync(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(sizeBytes, INSTRUCTION_LIMITS.frontmatterCharsMax));
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error: unknown) {
    return { kind: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
  return readSkillMeta(head);
}

function nearestExisting(target: string): string {
  let current = target;
  for (let step = 0; step < INSTRUCTION_LIMITS.depthMax * 4; step += 1) {
    if (fs.existsSync(current)) {
      return current;
    }
    const parent = path.dirname(current);
    assert(parent !== current || fs.existsSync(parent), 'The filesystem root exists');
    current = parent;
  }
  throw new Error('instructionPath: a path deeper than any project was given');
}

function readBack(root: string, relative: string, source: string): InstructionWriteResult {
  const saved = readInstruction(root, relative);
  if (!saved.ok) {
    return saved;
  }
  if (saved.value !== source) {
    return failure('conflict', `${relative} changed again while it was saved.`);
  }
  return ok({ source: saved.value });
}

function failure(code: InstructionWriteFailure, message: string): Result<never, { readonly code: InstructionWriteFailure; readonly message: string }> {
  assert(message.length > 0, 'A failure says why');
  return err({ code, message });
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true });
}
