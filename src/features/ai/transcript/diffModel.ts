// The pure side of the diff view: what rows a file's change has, which of them are shown, which
// words inside a changed line changed, and how many lines were added and removed. DiffView.tsx
// only draws what this module decides, so every rule here is testable without a DOM.
//
// Everything is bounded (AGENTS.md section 10): rows come from `diffRows` (itself bounded by the
// alignment table), the rows drawn are capped by DIFF_VIEW_LIMITS, and the word comparison is
// capped in lines per view, tokens per line and characters per line.
import { assert } from '../../../../shared/core/assert';
import type { CodeLine, CodeTokenStyle } from '../../../ui/codeHighlight';
import { diffRows, type DiffRow } from '../lineDiff';

export const DIFF_VIEW_LIMITS = {
  /** Unchanged lines kept on each side of a change. */
  contextLines: 3,
  /** An unchanged stretch this short is drawn: a "Show 1 line" button would take as much room as the line. */
  gapInlineMax: 2,
  /** Lines one "Show N lines" press brings back. */
  revealStep: 40,
  /** Rows (changed lines, context and gap rows) drawn before "Show full diff". */
  rowsCompactMax: 400,
  /** Rows drawn after "Show full diff"; a longer diff says where it stops. */
  rowsFullMax: 4_000,
  /** Both sides together; past this the file is shown uncoloured so a huge file never stalls the panel. */
  highlightCharsMax: 300_000,
  /** Changed-line pairs given a word comparison per view. */
  wordPairsMax: 300,
  /** A line with more tokens or characters than this is not compared word by word. */
  wordTokensMax: 160,
  wordLineCharsMax: 400,
  /** Below this share of shared text two lines are different lines, not an edit of one. */
  wordSimilarityMin: 0.4,
} as const satisfies Record<string, number>;

/** A half-open character range [start, end) inside one line. */
export type CharRange = readonly [start: number, end: number];

export type FileDiff =
  /** A NUL byte in either side: not text, so no rows. */
  | { readonly kind: 'binary' }
  /** Nothing differs once line endings and the final newline are set aside. */
  | { readonly kind: 'same'; readonly lineEndingsChanged: boolean }
  | {
      readonly kind: 'text';
      /** Deletions before additions inside each changed run, the order a unified diff reads in. */
      readonly rows: readonly DiffRow[];
      readonly added: number;
      readonly removed: number;
      /** False for a change too large to align: the changed region reads as removed then added. */
      readonly exact: boolean;
      /** Both sides as the rows were made from them (line endings normalised): the text to colour. */
      readonly oldText: string;
      readonly newText: string;
    };

export interface ChangeCounts {
  readonly added: number;
  readonly removed: number;
}

export type DiffBlock =
  | { readonly kind: 'row'; readonly index: number; readonly row: DiffRow }
  /** `key` names the gap for `revealed`; `hidden` lines are still folded; one press shows `step` of them. */
  | { readonly kind: 'gap'; readonly key: number; readonly hidden: number; readonly step: number };

export interface VisibleDiff {
  readonly blocks: readonly DiffBlock[];
  /** Blocks left out by the row cap. */
  readonly cut: number;
  /** Blocks in all, before the cap. */
  readonly total: number;
}

/** Lines made of the text with one line ending and no final break: the shape both the rows and the colouring split on. */
export function normalizeDiffText(text: string): string {
  const unified = text.replace(/\r\n?/g, '\n');
  return unified.endsWith('\n') ? unified.slice(0, -1) : unified;
}

/** The comparison of one file. `undefined` on a side is an absent file (a created or deleted one). */
export function buildFileDiff(oldText: string | undefined, newText: string | undefined): FileDiff {
  if ((oldText?.includes('\u0000') ?? false) || (newText?.includes('\u0000') ?? false)) {
    return { kind: 'binary' };
  }
  const oldNormal = normalizeDiffText(oldText ?? '');
  const newNormal = normalizeDiffText(newText ?? '');
  // A created empty file or an emptied one still changes the file's existence, but there is nothing to draw.
  if (oldNormal === newNormal) {
    return { kind: 'same', lineEndingsChanged: (oldText ?? '') !== (newText ?? '') };
  }
  const result = diffRows(oldNormal, newNormal);
  const rows = deletionsFirst(result.rows);
  const counts = countRows(rows);
  assert(counts.added + counts.removed > 0, 'buildFileDiff: different texts have at least one changed row');
  return { kind: 'text', rows, added: counts.added, removed: counts.removed, exact: result.exact, oldText: oldNormal, newText: newNormal };
}

/** Added and removed line counts of rows. */
export function countRows(rows: readonly DiffRow[]): ChangeCounts {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'added') {
      added += 1;
    } else if (row.kind === 'deleted') {
      removed += 1;
    }
  }
  return { added, removed };
}

/** The counts of a file's change; undefined when it has none to count (binary, or the same text). */
export function countsOf(diff: FileDiff): ChangeCounts | undefined {
  return diff.kind === 'text' ? { added: diff.added, removed: diff.removed } : undefined;
}

/**
 * Inside each run of changed rows the aligner may interleave additions and deletions; a unified diff
 * reads better (and pairs words better) with the run's deletions first, each side in its own order.
 */
function deletionsFirst(rows: readonly DiffRow[]): readonly DiffRow[] {
  const out: DiffRow[] = [];
  let deleted: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = (): void => {
    out.push(...deleted, ...added);
    deleted = [];
    added = [];
  };
  for (const row of rows) {
    if (row.kind === 'context') {
      flush();
      out.push(row);
    } else if (row.kind === 'deleted') {
      deleted.push(row);
    } else {
      added.push(row);
    }
  }
  flush();
  assert(out.length === rows.length, 'deletionsFirst: no row is lost or repeated');
  return out;
}

/**
 * The rows to draw: every changed row, `context` unchanged rows around each, and a gap in place of
 * each longer unchanged stretch. `revealed` maps a gap's key (the index of its first hidden row) to
 * how many of its lines the person asked for: from the end nearest the change, so the lines next to
 * a change come first. The row cap keeps the DOM bounded; `cut` says how many blocks it dropped.
 */
export function visibleBlocks(
  rows: readonly DiffRow[],
  options: { readonly context: number; readonly revealed: ReadonlyMap<number, number>; readonly rowsMax: number },
): VisibleDiff {
  assert(options.context >= 0, 'visibleBlocks: context is a count');
  assert(options.rowsMax > 0, 'visibleBlocks: the row cap is positive');
  const near = new Uint8Array(rows.length);
  rows.forEach((row, index) => {
    if (row.kind === 'context') {
      return;
    }
    const first = Math.max(0, index - options.context);
    const last = Math.min(rows.length - 1, index + options.context);
    for (let at = first; at <= last; at++) {
      near[at] = 1;
    }
  });
  const blocks: DiffBlock[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (row === undefined) {
      break;
    }
    if (near[index] === 1) {
      blocks.push({ kind: 'row', index, row });
      index += 1;
    } else {
      const start = index;
      while (index < rows.length && near[index] === 0) {
        index += 1;
      }
      if (index - start <= DIFF_VIEW_LIMITS.gapInlineMax) {
        pushRows(blocks, rows, start, index);
      } else {
        pushGap(blocks, rows, { start, end: index }, options.revealed.get(start) ?? 0);
      }
    }
  }
  const total = blocks.length;
  return { blocks: blocks.slice(0, options.rowsMax), cut: Math.max(0, total - options.rowsMax), total };
}

function pushRows(blocks: DiffBlock[], rows: readonly DiffRow[], from: number, to: number): void {
  for (let at = from; at < to; at++) {
    const row = rows[at];
    if (row !== undefined) {
      blocks.push({ kind: 'row', index: at, row });
    }
  }
}

function pushGap(blocks: DiffBlock[], rows: readonly DiffRow[], run: { readonly start: number; readonly end: number }, requested: number): void {
  const length = run.end - run.start;
  const shown = Math.min(requested, length);
  const hidden = length - shown;
  // A stretch before the first change reveals from its bottom edge; every other from its top edge: always the side touching a change.
  const leading = run.start === 0;
  const gap: DiffBlock = { kind: 'gap', key: run.start, hidden, step: Math.min(hidden, DIFF_VIEW_LIMITS.revealStep) };
  if (hidden > 0 && leading) {
    blocks.push(gap);
    pushRows(blocks, rows, run.end - shown, run.end);
  } else if (hidden > 0) {
    pushRows(blocks, rows, run.start, run.start + shown);
    blocks.push(gap);
  } else {
    pushRows(blocks, rows, run.start, run.end);
  }
}

// ---------------------------------------------------------------------------
// Word-level highlights
// ---------------------------------------------------------------------------

/** The characters that changed inside a deleted line and the added line it was edited into. */
export interface WordChange {
  readonly oldRanges: readonly CharRange[];
  readonly newRanges: readonly CharRange[];
}

const WORD_PATTERN = /[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g;

/**
 * Which characters differ between two versions of one line, by token (a word, a run of spaces or a
 * single symbol). Undefined when the lines are too long to compare cheaply or too different to be
 * one edit: marking every character of an unrelated pair would be noise, not a highlight.
 */
export function wordChange(oldLine: string, newLine: string): WordChange | undefined {
  if (oldLine.length > DIFF_VIEW_LIMITS.wordLineCharsMax || newLine.length > DIFF_VIEW_LIMITS.wordLineCharsMax) {
    return undefined;
  }
  const oldTokens = oldLine.match(WORD_PATTERN) ?? [];
  const newTokens = newLine.match(WORD_PATTERN) ?? [];
  if (oldTokens.length > DIFF_VIEW_LIMITS.wordTokensMax || newTokens.length > DIFF_VIEW_LIMITS.wordTokensMax) {
    return undefined;
  }
  const width = newTokens.length + 1;
  const table = new Uint16Array((oldTokens.length + 1) * width);
  for (let i = oldTokens.length - 1; i >= 0; i--) {
    for (let j = newTokens.length - 1; j >= 0; j--) {
      table[i * width + j] =
        oldTokens[i] === newTokens[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const oldKeep = new Uint8Array(oldTokens.length);
  const newKeep = new Uint8Array(newTokens.length);
  let i = 0;
  let j = 0;
  let sharedChars = 0;
  while (i < oldTokens.length && j < newTokens.length) {
    if (oldTokens[i] === newTokens[j]) {
      oldKeep[i] = 1;
      newKeep[j] = 1;
      sharedChars += oldTokens[i]?.length ?? 0;
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  const longest = Math.max(oldLine.length, newLine.length);
  if (longest === 0 || sharedChars / longest < DIFF_VIEW_LIMITS.wordSimilarityMin) {
    return undefined;
  }
  return { oldRanges: rangesOf(oldTokens, oldKeep), newRanges: rangesOf(newTokens, newKeep) };
}

/** The merged character ranges of the tokens not kept. */
function rangesOf(tokens: readonly string[], keep: Uint8Array): readonly CharRange[] {
  const ranges: [number, number][] = [];
  let offset = 0;
  tokens.forEach((token, index) => {
    const end = offset + token.length;
    if (keep[index] === 0) {
      const last = ranges[ranges.length - 1];
      if (last !== undefined && last[1] === offset) {
        last[1] = end;
      } else {
        ranges.push([offset, end]);
      }
    }
    offset = end;
  });
  return ranges;
}

/**
 * Word highlights for the rows of `rows`, keyed by row index. A run of deletions followed by a run
 * of additions pairs its k-th deletion with its k-th addition. Pairs are taken in file order up to
 * `wordPairsMax`, so a huge rewrite spends a bounded effort.
 */
export function wordRangesByRow(rows: readonly DiffRow[]): ReadonlyMap<number, readonly CharRange[]> {
  const byRow = new Map<number, readonly CharRange[]>();
  let pairs = 0;
  let index = 0;
  while (index < rows.length && pairs < DIFF_VIEW_LIMITS.wordPairsMax) {
    if (rows[index]?.kind !== 'deleted') {
      index += 1;
      continue;
    }
    const deletedStart = index;
    while (rows[index]?.kind === 'deleted') {
      index += 1;
    }
    const addedStart = index;
    while (rows[index]?.kind === 'added') {
      index += 1;
    }
    const pairCount = Math.min(addedStart - deletedStart, index - addedStart);
    for (let offset = 0; offset < pairCount && pairs < DIFF_VIEW_LIMITS.wordPairsMax; offset++) {
      const deleted = rows[deletedStart + offset];
      const added = rows[addedStart + offset];
      if (deleted !== undefined && added !== undefined) {
        pairs += 1;
        const change = wordChange(deleted.text, added.text);
        if (change !== undefined) {
          byRow.set(deletedStart + offset, change.oldRanges);
          byRow.set(addedStart + offset, change.newRanges);
        }
      }
    }
  }
  return byRow;
}

/** One stretch of a coloured line: its colour, and whether the word comparison marked it. */
export interface MarkedToken {
  readonly text: string;
  readonly style: CodeTokenStyle | undefined;
  readonly marked: 'changed' | 'same';
}

/** A coloured line cut at the edges of `ranges`, so a marked word keeps the colour of its token. */
export function markTokens(line: CodeLine, ranges: readonly CharRange[]): readonly MarkedToken[] {
  const out: MarkedToken[] = [];
  let offset = 0;
  for (const token of line) {
    let position = 0;
    while (position < token.text.length) {
      const start = offset + position;
      const range = ranges.find((candidate) => start < candidate[1]);
      const inside = range !== undefined && range[0] <= start;
      const edge = range === undefined ? Infinity : inside ? range[1] : range[0];
      const length = Math.min(token.text.length - position, edge - start);
      assert(length > 0, 'markTokens: every cut advances');
      out.push({ text: token.text.slice(position, position + length), style: token.style, marked: inside ? 'changed' : 'same' });
      position += length;
    }
    offset += token.text.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "+3 −1" for a change count; the minus sign is U+2212, the one the diff gutter draws. */
export function countsLabel(counts: ChangeCounts): string {
  return `+${counts.added} −${counts.removed}`;
}
