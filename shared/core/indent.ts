// The indentation Stacki writes, and how to read the indentation a file already
// has. Code Stacki writes on its own is tab-indented. Code it adds to a file the
// user owns follows that file when the file clearly indents with spaces, so a new
// line never sits in a different style from the lines around it.

import { assert } from './assert';

/** One level of indentation in every Stacki editor and in the code Stacki writes. */
export const CODE_INDENT_UNIT = '\t';

/** The columns a tab takes in an editor, the width the editors showed before tabs. */
export const CODE_TAB_WIDTH = 2;

/** An indent unit, and how many columns one level of it takes. */
export interface MeasuredIndent {
  readonly unit: string;
  readonly unitWidth: number;
}

/** The whitespace a line starts with. */
export function leadingIndent(line: string): string {
  const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
  assert(line.startsWith(indent), 'leadingIndent: the indent is the start of the line');
  assert(indent.trim().length === 0, 'leadingIndent: an indent is only whitespace');
  return indent;
}

/**
 * The indent a text uses: spaces when more of its indented lines start with a
 * space than with a tab, otherwise a tab, which is also what a text with no
 * indented line gets. A tab measures as wide as the text's space step, so lines
 * of both kinds compare level for level.
 */
export function measuredIndent(lines: readonly string[]): MeasuredIndent {
  let spaced = 0;
  let tabbed = 0;
  for (const line of lines) {
    if (line.startsWith(' ')) {
      spaced += 1;
    } else if (line.startsWith('\t')) {
      tabbed += 1;
    }
  }
  const step = commonSpaceStep(lines);
  const unitWidth = step ?? CODE_TAB_WIDTH;
  assert(unitWidth > 0, 'measuredIndent: an indent step is positive');
  assert(spaced + tabbed <= lines.length, 'measuredIndent: each line counts once');
  return { unit: spaced > tabbed ? ' '.repeat(unitWidth) : CODE_INDENT_UNIT, unitWidth };
}

/** The indent unit of `text`, for code being added to it. */
export function indentUnitOf(text: string): string {
  const { unit } = measuredIndent(text.split('\n'));
  assert(unit.length > 0, 'indentUnitOf: a unit is never empty');
  assert(unit.trim().length === 0, 'indentUnitOf: a unit is only whitespace');
  return unit;
}

/** Tab-indented text, with each leading tab rewritten as `unit`. */
export function withIndentUnit(text: string, unit: string): string {
  assert(unit.length > 0, 'withIndentUnit: a unit is never empty');
  assert(unit.trim().length === 0, 'withIndentUnit: a unit is only whitespace');
  return text.replace(/^\t+/gm, (tabs) => unit.repeat(tabs.length));
}

// The step between neighbouring space-indented lines that occurs most often, the
// smaller on a tie. Reading steps rather than the smallest indent keeps a block's
// own base out of it. One column is alignment, not a level.
function commonSpaceStep(lines: readonly string[]): number | undefined {
  const steps = new Map<number, number>();
  let previous: number | undefined;
  for (const line of lines) {
    if (line.trim().length > 0) {
      const indent = leadingIndent(line);
      const width = indent.includes('\t') ? undefined : indent.length;
      if (width !== undefined && previous !== undefined) {
        const step = Math.abs(width - previous);
        if (step > 1) {
          steps.set(step, (steps.get(step) ?? 0) + 1);
        }
      }
      previous = width;
    }
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [step, count] of steps) {
    if (count > bestCount) {
      best = step;
      bestCount = count;
    } else if (count === bestCount && best !== undefined && step < best) {
      best = step;
    }
  }
  assert(best === undefined || best > 1, 'commonSpaceStep: one column is not a level');
  assert(bestCount <= lines.length, 'commonSpaceStep: a step occurs at most once per line');
  return best;
}
