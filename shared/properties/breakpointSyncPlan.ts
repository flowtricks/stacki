// The plan a breakpoint sync shows and the request that applies it (Settings > Breakpoints). The scan (Desktop's main process)
// answers a `BreakpointSyncScan`; the dialog turns the checked places into a `BreakpointSyncApply`; main checks every file is
// still what the scan read before it writes one byte (electron/project/breakpointSync.ts).
import { boolean, count, list, object, optional, pathText, text, type Parsed } from '../core/boundary';
import { BREAKPOINT_LIMITS } from './projectBreakpoints';
import { MEDIA_SYNC_LIMITS } from './mediaBreakpointSync';
import { SYNC_RECORD_LIMITS, isProjectPath } from './breakpointSyncRecord';

export const SYNC_PLAN_LIMITS = {
  /** Files in one apply: as many as a scan lists. */
  filesMax: 2_000,
  /** Edits in one file. */
  editsPerFileMax: 2_000,
  /** Places the dialog may leave unchecked and have remembered. */
  uncheckedMax: SYNC_RECORD_LIMITS.refsMax,
  /** Characters in one token being replaced or written (`63.9375rem`). */
  tokenCharsMax: 24,
} as const satisfies Record<string, number>;

/** What kind of file a place is in, for the pill. */
export type SyncFileKind = 'css' | 'style' | 'page' | 'component';

/** Why a place is listed: `exact` is the old boundary, `inclusive` the old boundary less 1px in the form that includes its edge, `exclusive` an `up` breakpoint written `width > X`. */
export type SyncReason = 'exact' | 'inclusive' | 'exclusive';

export interface SyncOccurrence {
  readonly locator: string;
  readonly start: number;
  readonly end: number;
  readonly line: number;
  /** The token now, and what it becomes. */
  readonly before: string;
  readonly after: string;
  /** The query around the token, now and after. */
  readonly beforeText: string;
  readonly afterText: string;
  readonly reason: SyncReason;
  /** Unchecked earlier and remembered in `.stacki/breakpoint-sync.json`: listed as "Not synced". */
  readonly excluded: boolean;
  /** Whether it starts checked: exact and not excluded. */
  readonly checked: boolean;
}

export interface SyncFile {
  readonly rel: string;
  readonly kind: SyncFileKind;
  /** The file's content digest at scan time; an apply is refused for a file that no longer has it. */
  readonly digest: string;
  readonly occurrences: readonly SyncOccurrence[];
}

export interface BreakpointSyncScan {
  /** The breakpoint's id. */
  readonly key: string;
  readonly files: readonly SyncFile[];
  /** The project writes rem only: replacements are rem. */
  readonly lumos: boolean;
  /** A limit was hit while scanning: some files were not read. */
  readonly truncated: boolean;
  /** Files too large to read. */
  readonly skipped: number;
  /** Why `.stacki/breakpoint-sync.json` could not be used, when it could not; nothing is remembered then. */
  readonly recordProblem: string | undefined;
}

const key = (input: unknown): string => {
  const value = text(input);
  if (value.length === 0 || value.length > BREAKPOINT_LIMITS.idCharsMax || !/^[a-z][a-z0-9-]*$/.test(value)) {
    throw new Error('Unknown breakpoint');
  }
  return value;
};

const direction = (input: unknown): 'down' | 'up' => {
  const value = text(input);
  if (value !== 'down' && value !== 'up') {
    throw new Error('Expected down or up');
  }
  return value;
};

const relative = (input: unknown): string => {
  const value = pathText(input);
  if (!isProjectPath(value)) {
    throw new Error('Expected a project-relative path');
  }
  return value;
};

const token = (input: unknown): string => {
  const value = text(input);
  if (value.length === 0 || value.length > SYNC_PLAN_LIMITS.tokenCharsMax || !/^[0-9.]+(?:px|rem)$/i.test(value)) {
    throw new Error('Expected a number with px or rem');
  }
  return value;
};

const place = (input: unknown): number => {
  const value = count(input);
  if (value > MEDIA_SYNC_LIMITS.textCharsMax) {
    throw new Error('A position is outside the text bound');
  }
  return value;
};

const parseEdit = object({ locator: text, start: place, end: place, before: token, after: token });
const parseFile = object({ rel: relative, digest: text, edits: list(parseEdit) });
const parseRef = object({ file: relative, locator: text });

/** The request Apply sends: the checked places by file, and the unchecked ones to remember. */
export const parseSyncApply = object({
  projectPath: pathText,
  key,
  files: list(parseFile),
  unchecked: list(parseRef),
});
export type BreakpointSyncApply = Parsed<typeof parseSyncApply>;

/** The request that scans: which breakpoint, from what it was, to what it is now. */
export const parseSyncScan = object({
  projectPath: pathText,
  id: key,
  old: object({ direction, value: count, unit: text }),
  next: object({ direction, value: count, unit: text }),
});
export type BreakpointSyncScanRequest = Parsed<typeof parseSyncScan>;

export interface BreakpointSyncApplied {
  readonly ok: boolean;
  /** Places written, files written. */
  readonly places: number;
  readonly files: number;
  /** Files left alone, with why: the file changed since the scan, or a check failed. */
  readonly skipped: ReadonlyArray<{ readonly rel: string; readonly reason: 'stale' | 'mismatch' | 'verify' }>;
  /** Names the sync in main's journal, so Undo and Redo can put it back. */
  readonly journalId: string | undefined;
  readonly error: string | undefined;
}

export type SyncRestoreDirection = 'undo' | 'redo';

export const parseSyncRestore = object({
  projectPath: pathText,
  journalId: text,
  direction: (input: unknown): SyncRestoreDirection => {
    const value = text(input);
    if (value !== 'undo' && value !== 'redo') {
      throw new Error('Expected undo or redo');
    }
    return value;
  },
});

// The answers, parsed where they cross from main: nothing the dialog draws is cast.
const kindOf = (input: unknown): SyncFileKind => {
  const value = text(input);
  if (value === 'css' || value === 'style' || value === 'page' || value === 'component') {
    return value;
  }
  throw new Error('Unknown file kind');
};
const reasonOf = (input: unknown): SyncReason => {
  const value = text(input);
  if (value === 'exact' || value === 'inclusive' || value === 'exclusive') {
    return value;
  }
  throw new Error('Unknown reason');
};
const parseOccurrence = object({
  locator: text,
  start: count,
  end: count,
  line: count,
  before: text,
  after: text,
  beforeText: text,
  afterText: text,
  reason: reasonOf,
  excluded: boolean,
  checked: boolean,
});
const parseScan = object({
  key,
  files: list(object({ rel: text, kind: kindOf, digest: text, occurrences: list(parseOccurrence) })),
  lumos: boolean,
  truncated: boolean,
  skipped: count,
  recordProblem: optional(text),
});
const parseScanAnswerShape = object({ ok: boolean, scan: optional(parseScan), error: optional(text) });

export type BreakpointSyncScanAnswer = { readonly ok: true; readonly scan: BreakpointSyncScan } | { readonly ok: false; readonly error: string };

export function parseSyncScanAnswer(input: unknown): BreakpointSyncScanAnswer {
  const answer = parseScanAnswerShape(input);
  if (answer.ok && answer.scan !== undefined) {
    return { ok: true, scan: { ...answer.scan, recordProblem: answer.scan.recordProblem } };
  }
  return { ok: false, error: answer.error ?? 'The scan failed.' };
}

const parseAppliedShape = object({
  ok: boolean,
  places: count,
  files: count,
  skipped: list(
    object({
      rel: text,
      reason: (input: unknown): 'stale' | 'mismatch' | 'verify' => {
        const value = text(input);
        if (value === 'stale' || value === 'mismatch' || value === 'verify') {
          return value;
        }
        throw new Error('Unknown skip reason');
      },
    }),
  ),
  journalId: optional(text),
  error: optional(text),
});

export function parseSyncApplied(input: unknown): BreakpointSyncApplied {
  const value = parseAppliedShape(input);
  return { ok: value.ok, places: value.places, files: value.files, skipped: value.skipped, journalId: value.journalId, error: value.error };
}

const parseRestoredShape = object({ ok: boolean, restored: optional(count), skipped: optional(count), error: optional(text) });

export function parseSyncRestored(input: unknown): { readonly ok: boolean; readonly skipped: number; readonly error: string | undefined } {
  const value = parseRestoredShape(input);
  return { ok: value.ok, skipped: value.skipped ?? 0, error: value.error };
}
