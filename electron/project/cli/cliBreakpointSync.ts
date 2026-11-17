// `stacki breakpoints sync <id> --value <number> [--unit rem|px] [--from <length>] [--places checked|all]`: move a breakpoint's boundary and every
// media query that still holds the old one, the way Settings > Breakpoints does after a number is saved.
//
// Nothing is re-implemented. The places come from the app's scan (`scanBreakpointSync`), which ones change from the dialog's own first choice
// (`initialChecked`: exact matches the person has not unchecked before; `--places all` checks every place, as ticking every box would), the request
// from the dialog's `applyRequest`, the new texts from `planBreakpointSyncTexts` (checked against the scan's digests, read back and CSS-parsed), and the
// remembered "Not synced" places from `syncRecordAfter`. This file turns them into one CLI plan: the stylesheet and markup texts as an effect (data
// the undo journal holds), `.stacki/breakpoints.json` and `.stacki/breakpoint-sync.json` as settings edits. A dry run prints the plan; `--apply` writes
// all of it or none, and `stacki undo <id>` puts it back.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { toArray, toRecord } from '../../../shared/core/record';
import { err, ok, type Result } from '../../../shared/core/result';
import { fileSchemaById } from '../../../shared/properties/cli/stackiFiles';
import type { CliError, PlannedFile } from '../../../shared/properties/cli/stackiOutput';
import { allPlaces, applyRequest, initialChecked, placeKey } from '../../../shared/properties/breakpointSyncSelection';
import {
  BREAKPOINT_DEFAULT_CONFIG,
  checkedConfig,
  checkedSetting,
  conflictAt,
  parseBreakpointsSource,
  serializeBreakpoints,
  withSettingInPlace,
  type BreakpointConfig,
  type BreakpointSetting,
} from '../../../shared/properties/projectBreakpoints';
import { writeProjectText } from '../../documents/documentWrites';
import { planBreakpointSyncTexts, scanBreakpointSync, syncRecordAfter } from '../breakpointSync';
import { registerEffectKind } from './cliEffects';
import { readFileState } from './cliFiles';
import type { Edit } from './cliPlan';
import type { CommandContext, Outcome } from './cliCommands';

export const SYNC_EFFECT_LIMITS = {
  /** Files one sync effect may list when it is read back from the undo journal: a bound on the record, not on the project (a sync writes every file it found). */
  filesMax: 200_000,
} as const satisfies Record<string, number>;

/** The texts a sync writes, file by file: what each holds now and what it will hold. */
interface SyncTextsRecord {
  readonly files: ReadonlyArray<{ readonly file: string; readonly before: string; readonly after: string }>;
}

const refused = (message: string, code: CliError['code'] = 'refused'): Result<never, CliError> => err({ code, message });

// ----- the effect: rewriting stylesheet and markup texts -----

function safeRelative(file: string): boolean {
  return file.length > 0 && !file.startsWith('/') && !file.includes('\\') && file.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A sync record read back at the journal boundary: project-relative paths only, outside `.stacki/` (settings go through their own writer). */
export function readSyncTexts(data: unknown): Result<SyncTextsRecord, CliError> {
  const list = toArray(toRecord(data)?.['files']);
  if (list === undefined || list.length > SYNC_EFFECT_LIMITS.filesMax) {
    return refused('That breakpoint sync record is not readable.');
  }
  const files: Array<{ file: string; before: string; after: string }> = [];
  for (const item of list) {
    const entry = toRecord(item);
    const file = entry?.['file'];
    const before = entry?.['before'];
    const after = entry?.['after'];
    if (typeof file !== 'string' || typeof before !== 'string' || typeof after !== 'string') {
      return refused('That breakpoint sync record names a text it cannot read.');
    }
    if (!safeRelative(file) || file.startsWith('.stacki/')) {
      return refused(`That breakpoint sync record names a file it may not write: ${file}.`);
    }
    files.push({ file, before, after });
  }
  return ok({ files });
}

// Every file must still hold the text the plan read; then each is written through the app's document actors, and a failure puts back the ones
// already written (newest first).
function applySyncTexts(root: string, record: SyncTextsRecord): Result<void, CliError> {
  assert(path.isAbsolute(root), 'applySyncTexts: the project path is absolute');
  const absolute = (file: string): string => path.join(root, ...file.split('/'));
  for (const entry of record.files) {
    let current: string;
    try {
      current = fs.readFileSync(absolute(entry.file), 'utf8');
    } catch {
      return refused(`${entry.file} is missing; nothing was written. Plan again.`, 'conflict');
    }
    if (current !== entry.before) {
      return refused(`${entry.file} changed since the plan was made; nothing was written. Plan again.`, 'conflict');
    }
  }
  const written: Array<{ file: string; before: string; after: string }> = [];
  for (const entry of record.files) {
    try {
      writeProjectText(absolute(entry.file), entry.after, entry.before);
      written.push(entry);
    } catch (error: unknown) {
      for (const done of written.reverse()) {
        try {
          writeProjectText(absolute(done.file), done.before, done.after);
        } catch {
          // The file moved again; leaving it as the person's latest edit is the safe outcome, and the apply reports the failure.
        }
      }
      return refused(`${entry.file} could not be written: ${error instanceof Error ? error.message : String(error)}`, 'write-failed');
    }
  }
  assert(written.length === record.files.length, 'applySyncTexts: every file was written');
  return ok(undefined);
}

registerEffectKind('breakpoint-sync-texts', {
  read: readSyncTexts,
  apply: (root, data) => {
    const record = readSyncTexts(data);
    return record.ok ? applySyncTexts(root, record.value) : record;
  },
  reverse: (data) => {
    const record = readSyncTexts(data);
    const files = record.ok ? record.value.files.map((entry) => ({ file: entry.file, before: entry.after, after: entry.before })) : [];
    return { kind: 'breakpoint-sync-texts', data: { files } };
  },
  describe: (data) => {
    const record = readSyncTexts(data);
    return record.ok ? record.value.files.map((entry): PlannedFile => ({ file: entry.file, action: 'modify', changes: [] })) : [];
  },
});

// ----- the command -----

/** `--from 64rem`: the boundary the media queries still hold, when `.stacki/breakpoints.json` already has the new one. */
export function parseBoundaryLength(input: string): Result<BreakpointSetting, CliError> {
  const match = /^(\d+(?:\.\d+)?)(px|rem)$/.exec(input.trim());
  if (match === null) {
    return refused(`"${input}" is not a boundary: write a number and its unit, such as 64rem or 1024px.`, 'invalid-value');
  }
  const setting = checkedSetting({ value: Number(match[1]), unit: match[2] });
  return setting.ok ? ok(setting.value) : refused(setting.error.message, 'invalid-value');
}

function sameSetting(first: BreakpointSetting, second: BreakpointSetting): boolean {
  return first.value === second.value && first.unit === second.unit;
}

const lengthOf = (setting: BreakpointSetting): string => `${setting.value}${setting.unit}`;

function storedConfig(root: string): Result<{ readonly config: BreakpointConfig; readonly exists: boolean }, CliError> {
  const schema = fileSchemaById('breakpoints');
  if (schema === undefined) {
    return refused('The breakpoints registry is missing.', 'internal');
  }
  const state = readFileState(root, schema);
  if (!state.ok) {
    return state;
  }
  if (state.value.source === undefined) {
    return ok({ config: BREAKPOINT_DEFAULT_CONFIG, exists: false });
  }
  const parsed = parseBreakpointsSource(state.value.source);
  return parsed.ok ? ok({ config: parsed.value, exists: true }) : refused(parsed.error.message, 'invalid-file');
}

export async function breakpointsSync(context: CommandContext): Promise<Result<Outcome, CliError>> {
  const id = typeof context.args['id'] === 'string' ? context.args['id'] : '';
  assert(id.length > 0, 'breakpoints sync: the parser requires an id');
  if (id === 'desktop') {
    return refused('Desktop is the widest canvas, not a media query boundary: set it with "stacki breakpoints set desktop --value <n>".', 'invalid-value');
  }
  const stored = storedConfig(context.root);
  if (!stored.ok) {
    return stored;
  }
  const breakpoint = stored.value.config.list.find((entry) => entry.id === id);
  if (breakpoint === undefined) {
    return refused(`There is no breakpoint "${id}" (ids: ${stored.value.config.list.map((entry) => entry.id).join(', ')}).`, 'missing');
  }
  const next = checkedSetting({ value: context.args['value'], unit: context.args['unit'] ?? breakpoint.setting.unit });
  if (!next.ok) {
    return refused(next.error.message, 'invalid-value');
  }
  const fromText = typeof context.args['from'] === 'string' ? context.args['from'] : undefined;
  const from = fromText === undefined ? ok(breakpoint.setting) : parseBoundaryLength(fromText);
  if (!from.ok) {
    return from;
  }
  if (sameSetting(from.value, next.value)) {
    // Running the same sync again is a no-op that succeeds (exit 0), so a script can repeat it safely.
    return ok({
      kind: 'write',
      edits: [],
      summary: `"${id}" is already ${lengthOf(next.value)}: nothing to move.`,
      notes: [`If media queries still hold an older boundary, name it with --from <length>, such as --from 64rem.`],
    });
  }
  const config = withSettingInPlace(stored.value.config, id, next.value);
  const conflict = conflictAt(config, id);
  if (conflict !== undefined) {
    return refused(`"${id}" must stay ${conflict.relation} than "${conflict.against.id}".`, 'invalid-value');
  }
  const scan = await scanBreakpointSync(context.root, { key: id, old: { direction: breakpoint.direction, setting: from.value }, next: next.value });
  const places = context.args['places'] === 'all' ? allPlaces(scan) : initialChecked(scan);
  const request = applyRequest(context.root, id, scan, places);
  const texts = planBreakpointSyncTexts(context.root, request);
  const edits = syncEdits(stored.value.config, config, request, texts.planned);
  if (!edits.ok) {
    return edits;
  }
  const changed = texts.planned.reduce((sum, file) => sum + file.places, 0);
  const found = scan.files.reduce((sum, file) => sum + file.occurrences.length, 0);
  return ok({
    kind: 'write',
    edits: edits.value,
    effects:
      texts.planned.length === 0
        ? []
        : [{ kind: 'breakpoint-sync-texts', data: { files: texts.planned.map(({ rel, before, after }) => ({ file: rel, before, after })) } }],
    summary: `Move breakpoint ${id} from ${lengthOf(from.value)} to ${lengthOf(next.value)}: ${changed} of ${found} places in ${texts.planned.length} files.`,
    notes: notesOf(scan, found - changed, texts.skipped),
    result: {
      id,
      from: from.value,
      to: next.value,
      lumos: scan.lumos,
      places: scan.files.map((file) => ({
        file: file.rel,
        kind: file.kind,
        places: file.occurrences.map((place) => ({
          line: place.line,
          before: place.beforeText,
          after: place.afterText,
          reason: place.reason,
          synced: places.has(placeKey(file.rel, place.locator)),
        })),
      })),
      skipped: texts.skipped,
    },
  });
}

// `.stacki/breakpoints.json` takes the new boundary (unless it already has it); `.stacki/breakpoint-sync.json` remembers the places left alone.
function syncEdits(
  before: BreakpointConfig,
  after: BreakpointConfig,
  request: ReturnType<typeof applyRequest>,
  planned: ReadonlyArray<{ readonly rel: string }>,
): Result<readonly Edit[], CliError> {
  const breakpointsSchema = fileSchemaById('breakpoints');
  const syncSchema = fileSchemaById('breakpointSync');
  if (breakpointsSchema === undefined || syncSchema === undefined) {
    return refused('The breakpoints registry is missing.', 'internal');
  }
  const checked = checkedConfig(after);
  if (!checked.ok) {
    return refused(checked.error.message, 'invalid-value');
  }
  const unchanged = JSON.stringify(before) === JSON.stringify(checked.value);
  const breakpoints: Edit = { schema: breakpointsSchema, produce: () => ok(unchanged ? undefined : serializeBreakpoints(checked.value)) };
  const record: Edit = { schema: syncSchema, produce: (state) => ok(syncRecordAfter(state.source, request, planned)) };
  return ok([breakpoints, record]);
}

function notesOf(
  scan: { readonly recordProblem: string | undefined; readonly lumos: boolean },
  leftAlone: number,
  skipped: ReadonlyArray<{ readonly rel: string; readonly reason: string }>,
): readonly string[] {
  const notes: string[] = [];
  if (leftAlone > 0) {
    notes.push(
      `${leftAlone} places are left as they are (inclusive or exclusive forms, or remembered as "Not synced"); they are remembered in .stacki/breakpoint-sync.json. Add --places all to change them too.`,
    );
  }
  for (const file of skipped) {
    notes.push(`Not changed (${file.reason}): ${file.rel}`);
  }
  if (scan.recordProblem !== undefined) {
    notes.push(`.stacki/breakpoint-sync.json could not be read, so it is left as it is: ${scan.recordProblem}`);
  }
  if (scan.lumos) {
    notes.push('This project writes rem (Lumos), so the media queries are written in rem.');
  }
  return notes;
}
