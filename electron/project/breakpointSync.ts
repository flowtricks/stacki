// Syncing a changed breakpoint into the project's `@media` queries (Settings > Breakpoints).
//
// `scanBreakpointSync` reads the project's stylesheets and the `<style>` blocks of its pages, components and HTML, finds the width
// bounds that equal the breakpoint's OLD value (shared/properties/mediaBreakpointSync.ts), and answers what each would become.
// It writes nothing. `applyBreakpointSync` writes the places the person kept checked: every file is checked against the digest
// the scan read, every replacement against the token it expects, the result is read back (bounds counted, the CSS parsed) before
// it is written, the files go through the same witnessed document writer the Style panel uses, and any failure puts back the files
// already written. What was unchecked is remembered in `.stacki/breakpoint-sync.json` (shared/properties/breakpointSyncRecord.ts).
// `restoreBreakpointSync` is that apply's Undo and Redo, from a bounded in-memory journal.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import postcss from 'postcss';
import { assert } from '../../shared/core/assert';
import { createSliceClock } from '../lib/slicedWork';
import { err, ok, type Result } from '../../shared/core/result';
import { readAstroSheet } from '../documents/astroStyleBlocks';
import { writeProjectText } from '../documents/documentWrites';
import { readLengthUnit } from './lengthUnitMarkers';
import { readProjectMetadata, writeProjectMetadata } from './projectMetadata';
import {
  EMPTY_SYNC_RECORD,
  entryOf,
  canonicalRefs,
  parseBreakpointSyncSource,
  recordsEqual,
  serializeBreakpointSyncRecord,
  withEntry,
  type BreakpointSyncRecord,
  type SyncRef,
} from '../../shared/properties/breakpointSyncRecord';
import type {
  BreakpointSyncApplied,
  BreakpointSyncApply,
  BreakpointSyncScan,
  SyncFile,
  SyncFileKind,
  SyncOccurrence,
  SyncRestoreDirection,
} from '../../shared/properties/breakpointSyncPlan';
import {
  applyReplacements,
  classifyBound,
  findWidthBounds,
  previewAround,
  replacementText,
  type CssSyntax,
  type TextReplacement,
  type WidthBound,
} from '../../shared/properties/mediaBreakpointSync';
import { BREAKPOINT_LIMITS, boundaryPx, checkedSetting, type Breakpoint, type BreakpointSetting } from '../../shared/properties/projectBreakpoints';

// No size limit (owner requirement): a project of any number of files, files of
// any size and any number of places are scanned in full. What remains here is how
// the scan is paced and what it caches: files read at once, the journal's depth
// for Undo, and the bytes the usage cache keeps between scans.
export const SYNC_SCAN_LIMITS = {
  /** Files read at once. */
  concurrency: 16,
  /** Syncs the journal keeps for Undo and Redo. */
  journalMax: 8,
  /** Text the usage cache keeps between scans, in UTF-16 units. A cache size:
   * a file that does not fit is read again by the next scan, never skipped. */
  usageCacheCharsMax: 32 * 1024 * 1024,
} as const satisfies Record<string, number>;

const STYLESHEETS = /\.(css|scss|sass|less|pcss|postcss)$/i;
const MARKUP = /\.(astro|html|htm)$/i;
// Dependencies, build output, caches and version control are not the project's own text; every dotted folder is skipped too.
const SKIPPED = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', '.astro', '.git', '.stacki', '.vercel', '.netlify', '.cache']);

interface IgnoreRules {
  readonly folders: ReadonlySet<string>;
  readonly suffixes: readonly string[];
}

/** Scans the project for the bounds that equal `old`. Writes nothing. */
export async function scanBreakpointSync(
  projectPath: string,
  request: { readonly key: string; readonly old: Pick<Breakpoint, 'direction' | 'setting'>; readonly next: BreakpointSetting },
): Promise<BreakpointSyncScan> {
  assert(path.isAbsolute(projectPath), 'scanBreakpointSync: the project path is absolute');
  const lumos = readLengthUnit(projectPath).kind === 'rem';
  const record = readRecord(projectPath);
  const entry = entryOf(record.record, request.key);
  const excluded = new Set(entry.excluded.map((ref) => `${ref.file}\0${ref.locator}`));
  const linked = new Set(entry.linked.map((ref) => `${ref.file}\0${ref.locator}`));
  const clock = createSliceClock();
  const listing = await listCandidates(projectPath, clock);
  const files: SyncFile[] = [];
  for (let from = 0; from < listing.length; from += SYNC_SCAN_LIMITS.concurrency) {
    const batch = listing.slice(from, from + SYNC_SCAN_LIMITS.concurrency);
    const reads = await Promise.all(batch.map((abs) => readCandidate(abs)));
    for (const [index, read] of reads.entries()) {
      const abs = batch[index];
      assert(abs !== undefined, 'scanBreakpointSync: a batch entry exists');
      if (read.kind === 'unreadable') {
        continue;
      }
      const rel = toRelative(projectPath, abs);
      const found = occurrencesIn(rel, read.text, { ...request, lumos, excluded, linked, includeUnchanged: false });
      if (found.length > 0) {
        files.push({ rel, kind: kindOf(rel), digest: digestOf(read.text), occurrences: found });
      }
      // One file's CSS can be tens of megabytes: hand the thread back between files.
      await clock.yieldIfDue();
    }
  }
  // Nothing is skipped or cut off any more; the wire shape still carries both
  // fields for the dialog that used to warn about them.
  return { key: request.key, files, lumos, truncated: false, skipped: 0, recordProblem: record.problem };
}

/** The places in one file's text, as the dialog lists them. */
export function occurrencesIn(
  rel: string,
  text: string,
  request: {
    readonly old: Pick<Breakpoint, 'direction' | 'setting'>;
    readonly next: BreakpointSetting;
    readonly lumos: boolean;
    readonly excluded: ReadonlySet<string>;
    /** Places the person checked that are not exact matches (inclusive and exclusive forms start unchecked). */
    readonly linked: ReadonlySet<string>;
    /** List places whose text would not change (the usage view shows what is there now, not what a change would do). */
    readonly includeUnchanged: boolean;
  },
): readonly SyncOccurrence[] {
  const view = cssView(rel, text);
  if (view === undefined) {
    return [];
  }
  const found: SyncOccurrence[] = [];
  let line = 1;
  let counted = 0;
  for (const bound of findWidthBounds(view, syntaxOf(rel))) {
    const wasExcluded = request.excluded.has(`${rel}\0${bound.locator}`);
    const match = classifyBound(bound, request.old);
    if (match === undefined && !wasExcluded) {
      continue;
    }
    // An excluded place that no longer holds the old value is still listed, as "Not synced", and is written as an exact one.
    const reason = match ?? 'exact';
    const after = replacementText(reason, bound, request.next, { lumos: request.lumos });
    const before = text.slice(bound.start, bound.end);
    if (before === after && !request.includeUnchanged) {
      continue;
    }
    for (let index = counted; index < bound.start; index += 1) {
      if (text.charCodeAt(index) === 10) {
        line += 1;
      }
    }
    counted = bound.start;
    found.push({
      locator: bound.locator,
      start: bound.start,
      end: bound.end,
      line,
      before,
      after,
      beforeText: previewAround(view, bound, before),
      afterText: previewAround(view, bound, after),
      reason,
      excluded: wasExcluded,
      checked: !wasExcluded && (reason === 'exact' || request.linked.has(`${rel}\0${bound.locator}`)),
    });
  }
  return found;
}

interface JournalEntry {
  readonly project: string;
  readonly files: ReadonlyArray<{ readonly abs: string; readonly before: string; readonly after: string }>;
  readonly recordBefore: string | undefined;
  readonly recordAfter: string | undefined;
}

const journal = new Map<string, JournalEntry>();

/** One file a sync would write: its text now and after the checked places are replaced (read back and verified). */
export interface PlannedSyncText {
  readonly abs: string;
  readonly rel: string;
  readonly before: string;
  readonly after: string;
  readonly places: number;
}

export interface PlannedSyncTexts {
  readonly planned: readonly PlannedSyncText[];
  readonly skipped: ReadonlyArray<{ readonly rel: string; readonly reason: 'stale' | 'mismatch' | 'verify' }>;
}

/**
 * The texts an apply would write, without writing: each file checked against the digest its scan read, each replacement against the token it
 * expects, and the result read back (bounds counted, the CSS parsed). Settings > Breakpoints writes these through `applyBreakpointSync`; the CLI
 * (`stacki breakpoints sync`) turns them into a plan, so both write the same text.
 */
export function planBreakpointSyncTexts(projectPath: string, request: Pick<BreakpointSyncApply, 'files'>): PlannedSyncTexts {
  assert(path.isAbsolute(projectPath), 'planBreakpointSyncTexts: the project path is absolute');
  const skipped: Array<{ rel: string; reason: 'stale' | 'mismatch' | 'verify' }> = [];
  const planned: PlannedSyncText[] = [];
  for (const file of request.files) {
    const abs = path.join(projectPath, ...file.rel.split('/'));
    const text = readIfReadable(abs);
    if (text === undefined || digestOf(text) !== file.digest) {
      skipped.push({ rel: file.rel, reason: 'stale' });
      continue;
    }
    const changed = rewritten(file.rel, text, file.edits);
    if (changed === 'mismatch' || changed === 'verify') {
      skipped.push({ rel: file.rel, reason: changed });
      continue;
    }
    planned.push({ abs, rel: file.rel, before: text, after: changed, places: file.edits.length });
  }
  assert(planned.length + skipped.length === request.files.length, 'planBreakpointSyncTexts: every file is planned or skipped');
  return { planned, skipped };
}

/** Writes the checked places. All or nothing for the files it writes; files that moved since the scan are skipped and reported. */
export function applyBreakpointSync(projectPath: string, request: BreakpointSyncApply): BreakpointSyncApplied {
  assert(path.isAbsolute(projectPath), 'applyBreakpointSync: the project path is absolute');
  const { planned, skipped: skippedFiles } = planBreakpointSyncTexts(projectPath, request);
  const skipped = [...skippedFiles];
  const written: PlannedSyncText[] = [];
  for (const target of planned) {
    try {
      writeProjectText(target.abs, target.after, target.before);
      written.push(target);
    } catch (error: unknown) {
      for (const done of written.reverse()) {
        try {
          writeProjectText(done.abs, done.before, done.after);
        } catch {
          // The file moved again; leaving it as the person's latest edit is the safe outcome.
        }
      }
      return { ok: false, places: 0, files: 0, skipped, journalId: undefined, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const saved = saveRecord(projectPath, request, written);
  if (written.length === 0 && saved === undefined) {
    return { ok: true, places: 0, files: 0, skipped, journalId: undefined, error: undefined };
  }
  const journalId = remember({
    project: projectPath,
    files: written.map(({ abs, before, after }) => ({ abs, before, after })),
    recordBefore: saved?.before,
    recordAfter: saved?.after,
  });
  const places = written.reduce((sum, target) => sum + target.places, 0);
  return { ok: true, places, files: written.length, skipped, journalId, error: undefined };
}

/** Puts a journalled sync back (undo) or forward again (redo). Files edited since are left as they are and counted. */
export function restoreBreakpointSync(
  projectPath: string,
  request: { readonly journalId: string; readonly direction: SyncRestoreDirection },
): Result<{ readonly restored: number; readonly skipped: number; readonly paths: readonly string[] }> {
  const entry = journal.get(request.journalId);
  if (entry === undefined || entry.project !== projectPath) {
    return err({ code: 'breakpoint-sync-journal', message: 'This sync can no longer be undone.' });
  }
  const undo = request.direction === 'undo';
  let restored = 0;
  let skipped = 0;
  const paths: string[] = [];
  for (const file of entry.files) {
    try {
      writeProjectText(file.abs, undo ? file.before : file.after, undo ? file.after : file.before);
      restored += 1;
      paths.push(file.abs);
    } catch {
      skipped += 1;
    }
  }
  const target = undo ? entry.recordBefore : entry.recordAfter;
  const current = readProjectMetadata(projectPath, 'breakpointSync');
  const base = current.ok ? current.value.source : undefined;
  const wanted = target ?? serializeBreakpointSyncRecord(EMPTY_SYNC_RECORD);
  if (base !== wanted && (base !== undefined || target !== undefined)) {
    writeProjectMetadata(projectPath, { kind: 'breakpointSync', source: wanted, ...(base === undefined ? {} : { base }) });
  }
  return ok({ restored, skipped, paths });
}

// The text of each edit applied, then checked: bounds counted, edited places found again, CSS parsed.
function rewritten(rel: string, text: string, edits: BreakpointSyncApply['files'][number]['edits']): string | 'mismatch' | 'verify' {
  if (edits.length === 0) {
    return text;
  }
  const replacements: TextReplacement[] = [];
  for (const edit of edits) {
    if (edit.end > text.length || text.slice(edit.start, edit.end) !== edit.before) {
      return 'mismatch';
    }
    replacements.push({ start: edit.start, end: edit.end, text: edit.after });
  }
  const view = cssView(rel, text);
  if (view === undefined) {
    return 'mismatch';
  }
  const known = new Set(findWidthBounds(view, syntaxOf(rel)).map((bound) => `${bound.start}:${bound.end}:${bound.locator}`));
  if (!edits.every((edit) => known.has(`${edit.start}:${edit.end}:${edit.locator}`))) {
    return 'mismatch';
  }
  const after = applyReplacements(text, replacements);
  return verified(rel, text, after, edits) ? after : 'verify';
}

function verified(rel: string, before: string, after: string, edits: BreakpointSyncApply['files'][number]['edits']): boolean {
  const beforeView = cssView(rel, before);
  const afterView = cssView(rel, after);
  if (beforeView === undefined || afterView === undefined) {
    return false;
  }
  const beforeBounds = findWidthBounds(beforeView, syntaxOf(rel));
  const afterBounds = findWidthBounds(afterView, syntaxOf(rel));
  if (beforeBounds.length !== afterBounds.length) {
    return false;
  }
  const byLocator = new Map<string, WidthBound>(afterBounds.map((bound) => [bound.locator, bound]));
  for (const edit of edits) {
    const bound: WidthBound | undefined = byLocator.get(edit.locator);
    if (bound === undefined || after.slice(bound.start, bound.end) !== edit.after) {
      return false;
    }
  }
  try {
    postcss.parse(afterView);
  } catch {
    return false;
  }
  return true;
}

// Where the `.stacki/breakpoint-sync.json` record changes: unchecked places are remembered, checked ones become linked, and the
// previous record goes in the journal. Nothing is written when the record would not change.
function saveRecord(
  projectPath: string,
  request: BreakpointSyncApply,
  written: ReadonlyArray<{ readonly rel: string }>,
): { readonly before: string | undefined; readonly after: string } | undefined {
  const current = readProjectMetadata(projectPath, 'breakpointSync');
  if (!current.ok) {
    return undefined;
  }
  const source = syncRecordAfter(current.value.source, request, written);
  if (source === undefined) {
    return undefined;
  }
  const saved = writeProjectMetadata(projectPath, {
    kind: 'breakpointSync',
    source,
    ...(current.value.source === undefined ? {} : { base: current.value.source }),
  });
  return saved.ok ? { before: current.value.source, after: source } : undefined;
}

/**
 * The text `.stacki/breakpoint-sync.json` holds after a sync that wrote `written`: unchecked places are remembered as "Not synced", written ones
 * become linked. Undefined when the record would not change, or when the current text cannot be read (a file that cannot be read is never written
 * over). Pure, so Settings and the CLI remember the same choices.
 */
export function syncRecordAfter(
  currentSource: string | undefined,
  request: Pick<BreakpointSyncApply, 'key' | 'files' | 'unchecked'>,
  written: ReadonlyArray<{ readonly rel: string }>,
): string | undefined {
  assert(request.key.length > 0, 'syncRecordAfter: a sync names its breakpoint');
  const parsed = parseBreakpointSyncSource(currentSource);
  if (!parsed.ok) {
    return undefined;
  }
  const entry = entryOf(parsed.value, request.key);
  const writtenFiles = new Set(written.map((file) => file.rel));
  const applied: SyncRef[] = request.files.flatMap((file) =>
    writtenFiles.has(file.rel) ? file.edits.map((edit) => ({ file: file.rel, locator: edit.locator })) : [],
  );
  const appliedKeys = new Set(applied.map((ref) => `${ref.file}\0${ref.locator}`));
  const unchecked = request.unchecked.slice(0, SYNC_RECORD_BOUND);
  const uncheckedKeys = new Set(unchecked.map((ref) => `${ref.file}\0${ref.locator}`));
  const excluded = canonicalRefs([...entry.excluded.filter((ref) => !appliedKeys.has(`${ref.file}\0${ref.locator}`)), ...unchecked]);
  const linked = canonicalRefs([...entry.linked.filter((ref) => !uncheckedKeys.has(`${ref.file}\0${ref.locator}`)), ...applied]);
  const appliedAt = applied.length > 0 ? new Date().toISOString() : entry.appliedAt;
  const next: BreakpointSyncRecord = withEntry(parsed.value, request.key, { excluded, linked, appliedAt });
  if (recordsEqual(next, parsed.value)) {
    return undefined;
  }
  const source = serializeBreakpointSyncRecord(next);
  assert(parseBreakpointSyncSource(source).ok, 'syncRecordAfter: the record written reads back');
  return source;
}

const SYNC_RECORD_BOUND = 2_000;

function readRecord(projectPath: string): { readonly record: BreakpointSyncRecord; readonly problem: string | undefined } {
  const current = readProjectMetadata(projectPath, 'breakpointSync');
  if (!current.ok) {
    return { record: EMPTY_SYNC_RECORD, problem: current.error.message };
  }
  const parsed = parseBreakpointSyncSource(current.value.source);
  return parsed.ok ? { record: parsed.value, problem: undefined } : { record: EMPTY_SYNC_RECORD, problem: parsed.error.message };
}

function remember(entry: JournalEntry): string {
  const id = createHash('sha256').update(`${Date.now()}:${Math.random()}:${entry.files.length}`).digest('hex').slice(0, 16);
  journal.set(id, entry);
  for (const key of journal.keys()) {
    if (journal.size <= SYNC_SCAN_LIMITS.journalMax) {
      break;
    }
    journal.delete(key);
  }
  return id;
}

function syntaxOf(rel: string): CssSyntax {
  return { lineComments: /\.(scss|sass|less)$/i.test(rel) };
}

function kindOf(rel: string): SyncFileKind {
  if (STYLESHEETS.test(rel)) {
    return 'css';
  }
  if (/\.astro$/i.test(rel)) {
    return rel.startsWith('src/pages/') ? 'page' : 'component';
  }
  return 'style';
}

// The file's CSS as one text: a stylesheet is itself; a page, component or HTML file is its `<style>` blocks with everything else
// blanked (newlines kept), so every offset is the file's own and a comment or string outside a style tag cannot be read as CSS.
function cssView(rel: string, text: string): string | undefined {
  if (STYLESHEETS.test(rel)) {
    return text;
  }
  if (!/@media/i.test(text)) {
    return '';
  }
  const sections = /\.astro$/i.test(rel) ? astroSections(rel, text) : htmlSections(text);
  const blank = (part: string): string => part.replace(/[^\n]/g, ' ');
  let view = '';
  let cursor = 0;
  for (const section of sections) {
    view += blank(text.slice(cursor, section.start)) + text.slice(section.start, section.end);
    cursor = section.end;
  }
  view += blank(text.slice(cursor));
  assert(view.length === text.length, 'cssView: blanking keeps the length');
  return view;
}

// An Astro file's readable `<style>` blocks, from the editor's own parser; a block inside an expression is left out.
function astroSections(rel: string, text: string): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const sheet = readAstroSheet(rel, text);
  return sheet.regions.filter((region) => !region.conditional).map((region) => ({ start: region.start, end: region.start + region.text.length }));
}

function htmlSections(text: string): ReadonlyArray<{ readonly start: number; readonly end: number }> {
  const sections: Array<{ start: number; end: number }> = [];
  const lower = text.toLowerCase();
  let index = 0;
  // Each pass moves `index` past a closing tag, so the loop ends within the text's own length.
  for (let pass = 0; pass <= lower.length; pass++) {
    const open = lower.indexOf('<style', index);
    if (open === -1) {
      break;
    }
    const tagEnd = lower.indexOf('>', open);
    const close = tagEnd === -1 ? -1 : lower.indexOf('</style', tagEnd);
    if (tagEnd === -1 || close === -1) {
      break;
    }
    sections.push({ start: tagEnd + 1, end: close });
    index = close;
  }
  return sections;
}

type Candidate = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'unreadable' };

// A file the platform cannot hold as one string (past 2^29 units) is unreadable
// like any other read failure: the only size at which a read can fail.
async function readCandidate(abs: string): Promise<Candidate> {
  try {
    return { kind: 'text', text: await fs.promises.readFile(abs, 'utf8') };
  } catch {
    return { kind: 'unreadable' };
  }
}

function readIfReadable(abs: string): string | undefined {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return undefined;
  }
}

// Every stylesheet and markup file under the project, by an iterative walk of any size, handing the thread back between folders. The
// root `.gitignore` is honoured for plain folder names (`dist/`, `/out`) and `*.ext` file patterns; anything fancier is not interpreted.
// Links are not followed (a Dirent for a link is neither a directory nor a file), so no cycle can make the walk endless; the walk
// ends within the number of folders it discovers, which `visited` is held to.
async function listCandidates(projectPath: string, clock: { readonly yieldIfDue: () => Promise<void> }): Promise<readonly string[]> {
  const ignore = readIgnore(projectPath);
  const files: string[] = [];
  const queue: string[] = [projectPath];
  for (let visited = 0; visited < queue.length; visited++) {
    const directory = queue[visited];
    assert(directory !== undefined, 'listCandidates: the walk stays inside its queue');
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((first, second) => (first.name < second.name ? -1 : 1))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const skip = entry.name.startsWith('.') || SKIPPED.has(entry.name) || ignore.folders.has(entry.name);
        if (!skip) {
          queue.push(full);
        }
      } else if ((STYLESHEETS.test(entry.name) || MARKUP.test(entry.name)) && !ignore.suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        files.push(full);
      }
    }
    await clock.yieldIfDue();
  }
  return files;
}

function readIgnore(projectPath: string): IgnoreRules {
  const folders = new Set<string>();
  const suffixes: string[] = [];
  let source = '';
  try {
    source = fs.readFileSync(path.join(projectPath, '.gitignore'), 'utf8');
  } catch {
    return { folders, suffixes };
  }
  for (const raw of source.split('\n')) {
    const line = raw.trim().replace(/\r$/, '');
    if (line === '' || line.startsWith('#') || line.startsWith('!')) {
      continue;
    }
    if (/^\*\.[A-Za-z0-9]+$/.test(line)) {
      suffixes.push(line.slice(1));
    } else {
      const name = line.replace(/^\//, '').replace(/\/$/, '');
      if (/^[A-Za-z0-9._-]+$/.test(name)) {
        folders.add(name);
      }
    }
  }
  return { folders, suffixes };
}

const toRelative = (projectPath: string, abs: string): string => path.relative(projectPath, abs).split(path.sep).join('/');

const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');

// The unit a typed boundary is read in is not needed here; the dialog's numbers come from `replacementText`.
export function validSetting(input: { readonly value: number; readonly unit: string }): Result<BreakpointSetting> {
  const checked = checkedSetting(input);
  if (checked.ok) {
    assert(boundaryPx(checked.value) >= BREAKPOINT_LIMITS.boundaryPxMin, 'validSetting: within the canvas bounds');
  }
  return checked;
}

/** One breakpoint's places in the project, as they stand now. */
export interface BreakpointUsageEntry {
  readonly id: string;
  readonly files: readonly SyncFile[];
}

export interface BreakpointUsageResult {
  readonly entries: readonly BreakpointUsageEntry[];
  readonly lumos: boolean;
  readonly truncated: boolean;
  readonly skipped: number;
  readonly recordProblem: string | undefined;
}

// What the usage scan remembers of a file between scans, so a rescan reads only what changed: its text when it has `@media` in it
// (the only files that can hold a place), keyed by when it was last written and how big it is. A cache, bounded by count and by
// the text it holds: oldest dropped first, and a file too big to keep is read again each scan, never skipped.
const usageCache = new Map<string, { readonly stamp: string; readonly text: string | undefined; readonly digest: string }>();
const USAGE_CACHE_MAX = 4_000;
let usageCacheChars = 0;

/**
 * Where each breakpoint is used: the places in the project that equal its CURRENT value, per file, with the person's remembered
 * choices applied. One pass over the project for all breakpoints, cached by file time and size. Writes nothing.
 */
export async function scanBreakpointUsage(
  projectPath: string,
  breakpoints: ReadonlyArray<Pick<Breakpoint, 'id' | 'direction' | 'setting'>>,
): Promise<BreakpointUsageResult> {
  assert(path.isAbsolute(projectPath), 'scanBreakpointUsage: the project path is absolute');
  const lumos = readLengthUnit(projectPath).kind === 'rem';
  const record = readRecord(projectPath);
  const clock = createSliceClock();
  const listing = await listCandidates(projectPath, clock);
  const found = new Map<string, SyncFile[]>(breakpoints.map((breakpoint) => [breakpoint.id, []]));
  for (let from = 0; from < listing.length; from += SYNC_SCAN_LIMITS.concurrency) {
    const batch = listing.slice(from, from + SYNC_SCAN_LIMITS.concurrency);
    const reads = await Promise.all(batch.map((abs) => readForUsage(abs)));
    for (const [index, read] of reads.entries()) {
      const abs = batch[index];
      assert(abs !== undefined, 'scanBreakpointUsage: a batch entry exists');
      if (read.kind === 'unreadable' || read.text === undefined) {
        continue;
      }
      const rel = toRelative(projectPath, abs);
      for (const breakpoint of breakpoints) {
        const entry = entryOf(record.record, breakpoint.id);
        const occurrences = occurrencesIn(rel, read.text, {
          old: breakpoint,
          next: breakpoint.setting,
          lumos,
          excluded: new Set(entry.excluded.map((ref) => `${ref.file}\0${ref.locator}`)),
          linked: new Set(entry.linked.map((ref) => `${ref.file}\0${ref.locator}`)),
          includeUnchanged: true,
        });
        if (occurrences.length > 0) {
          found.get(breakpoint.id)?.push({ rel, kind: kindOf(rel), digest: read.digest, occurrences });
        }
      }
      await clock.yieldIfDue();
    }
  }
  trimUsageCache();
  const entries = breakpoints.map((breakpoint) => ({ id: breakpoint.id, files: found.get(breakpoint.id) ?? [] }));
  return { entries, lumos, truncated: false, skipped: 0, recordProblem: record.problem };
}

type UsageRead = { readonly kind: 'text'; readonly text: string | undefined; readonly digest: string } | { readonly kind: 'unreadable' };

function trimUsageCache(): void {
  // Each pass drops one entry, so the loop ends within the cache's own size.
  for (let pass = usageCache.size; pass > 0; pass--) {
    if (usageCache.size <= USAGE_CACHE_MAX && usageCacheChars <= SYNC_SCAN_LIMITS.usageCacheCharsMax) {
      return;
    }
    const oldest = usageCache.entries().next().value;
    if (oldest === undefined) {
      return;
    }
    usageCache.delete(oldest[0]);
    usageCacheChars -= oldest[1].text?.length ?? 0;
  }
  assert(usageCache.size === 0, 'trimUsageCache: a full pass empties the cache');
  assert(usageCacheChars === 0, 'trimUsageCache: an empty cache holds no text');
}

async function readForUsage(abs: string): Promise<UsageRead> {
  try {
    const stat = await fs.promises.stat(abs);
    const stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = usageCache.get(abs);
    if (cached !== undefined && cached.stamp === stamp) {
      return { kind: 'text', text: cached.text, digest: cached.digest };
    }
    const text = await fs.promises.readFile(abs, 'utf8');
    const digest = digestOf(text);
    // Only a file with `@media` can hold a place; the rest is not kept.
    const kept = /@media/i.test(text) ? text : undefined;
    const previous = usageCache.get(abs);
    usageCacheChars -= previous?.text?.length ?? 0;
    usageCache.delete(abs);
    if (kept === undefined || kept.length <= SYNC_SCAN_LIMITS.usageCacheCharsMax) {
      usageCache.set(abs, { stamp, text: kept, digest });
      usageCacheChars += kept?.length ?? 0;
    }
    return { kind: 'text', text: kept, digest };
  } catch {
    return { kind: 'unreadable' };
  }
}
