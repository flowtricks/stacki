// The text of one rule as the CSS Code editor shows it, and back.
//
// A rule inside an Astro <style> block carries the block's indentation: its
// selector sits after `raws.before`, but every later line (declarations and
// the closing brace) holds the file's own leading whitespace. Shown as is, a
// rule in an indented block read `.a {\n        color: red;\n    }`. The editor
// therefore shows the rule flush left with two spaces per level, and a save
// puts the block's indentation and the file's own indent unit back, so the
// source keeps its style and no other rule is touched.
//
// A selector list (or an at-rule prelude) that spans lines is not nesting: its
// later lines belong at the level of its first line, whatever extra indentation
// the file gives them. Those continuation lines are therefore shown at their
// first line's level, and a save gives them back the indentation the file used
// for them, so an unchanged rule writes its original bytes.

import type { AtRule, Rule } from 'postcss';
import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';

/** The indent unit the editor shows: two spaces per nesting level. */
export const EDITOR_INDENT_UNIT = '  ';

/**
 * How a rule is laid out in its file: the indentation of its own line, the step
 * one level deeper adds, and, for each prelude that spans lines in source order,
 * the indentation its continuation lines add past its first line.
 */
export type RuleLayout = { readonly base: string; readonly unit: string; readonly continuations: readonly string[] };

/** The rule's text for the editor: flush left, two spaces per level. */
export function ruleEditorText(node: Rule | AtRule): string {
  const source = node.toString();
  const text = editorTextFromSource(source, ruleLayout(node));
  assert(!text.includes('\r'), 'ruleEditorText: lines split on \\n only');
  return text;
}

/** The rule's layout in its file, read from its own line and its body. */
export function ruleLayout(node: Rule | AtRule): RuleLayout {
  const base = lineIndent(node.raws.before);
  const lines = splitLines(node.toString());
  const starts = preludeStarts(lines);
  const unit = bodyUnit(lines, starts, base);
  assert(unit.length > 0, 'ruleLayout: an indent unit is never empty');
  const continuations = continuationOffsets(lines, starts, base);
  assert(continuations.length <= lines.length, 'ruleLayout: at most one continuation offset per line');
  return { base, unit, continuations };
}

/**
 * Source text with `layout.base` stripped and each level of `layout.unit` shown
 * as two spaces. A prelude's continuation lines sit at its first line's level.
 */
export function editorTextFromSource(source: string, layout: RuleLayout): string {
  assert(layout.unit.length > 0, 'editorTextFromSource: an indent unit is never empty');
  const lines = splitLines(source);
  const starts = preludeStarts(lines);
  const prefixes = continuationPrefixes(lines, starts);
  const shown: string[] = [];
  for (const [index, line] of lines.entries()) {
    const start = starts[index];
    if (index === 0) {
      shown.push(line);
    } else if (start === undefined) {
      shown.push(reindentLine(stripBase(line, layout.base), layout.unit, EDITOR_INDENT_UNIT, ''));
    } else {
      // The prelude's first line is earlier, so it is already shown.
      assert(start < index, 'editorTextFromSource: a prelude starts before its continuation');
      const startShown = shown[start];
      assert(startShown !== undefined, 'editorTextFromSource: the prelude start line is shown');
      shown.push(rebaseLine(line, prefixes.get(start) ?? '', leadingWhitespace(startShown)));
    }
  }
  assert(shown.length === lines.length, 'editorTextFromSource: one shown line per source line');
  return shown.join('\n');
}

/**
 * Editor text with the block's indentation and the file's indent unit put back,
 * ready to splice into the file. A prelude's continuation lines take its first
 * line's indentation plus the offset the file used for that prelude, or the
 * file's first such offset for a new prelude, or none when the file has none.
 */
export function sourceTextFromEditor(editorText: string, layout: RuleLayout): string {
  assert(layout.unit.length > 0, 'sourceTextFromEditor: an indent unit is never empty');
  const lines = splitLines(editorText.replace(/\r\n?/g, '\n'));
  const starts = preludeStarts(lines);
  const ordinals = preludeOrdinals(starts);
  const written: string[] = [];
  for (const [index, line] of lines.entries()) {
    const start = starts[index];
    if (index === 0) {
      written.push(line.trimStart());
    } else if (start === undefined) {
      written.push(reindentLine(line, EDITOR_INDENT_UNIT, layout.unit, layout.base));
    } else {
      assert(start < index, 'sourceTextFromEditor: a prelude starts before its continuation');
      const startEditor = lines[start];
      const startWritten = written[start];
      assert(startEditor !== undefined, 'sourceTextFromEditor: the prelude start line exists');
      assert(startWritten !== undefined, 'sourceTextFromEditor: the prelude start line is written');
      // The first line is written without the block's indentation (the rule's
      // leading raws carry it), so its indentation in the file is the base.
      const startIndent = start === 0 ? layout.base : leadingWhitespace(startWritten);
      const ordinal = ordinals.get(start) ?? 0;
      const offset = layout.continuations[ordinal] ?? layout.continuations[0] ?? '';
      written.push(rebaseLine(line, leadingWhitespace(startEditor), startIndent + offset));
    }
  }
  assert(written.length === lines.length, 'sourceTextFromEditor: one written line per editor line');
  return written.join('\n');
}

// The whitespace after the last line break of a node's leading raws; empty when
// the node does not start a line.
function lineIndent(raw: string | undefined): string {
  if (raw === undefined) {
    return '';
  }
  const lineStart = raw.lastIndexOf('\n');
  if (lineStart < 0) {
    return '';
  }
  return raw.slice(lineStart + 1).replace(/\S/g, '');
}

// The smallest indentation a body line adds past the block's own: the file's
// step for one level. Two spaces when the rule has no indented body line. A
// prelude's continuation lines are not body lines: their indentation is not a
// nesting level, and counting it could halve the unit.
function bodyUnit(lines: readonly string[], starts: readonly (number | undefined)[], base: string): string {
  assert(starts.length === lines.length, 'bodyUnit: one prelude entry per line');
  let unit: string | undefined;
  for (const [index, line] of lines.entries()) {
    if (index === 0 || starts[index] !== undefined) {
      continue;
    }
    const rest = stripBase(line, base);
    const leading = leadingWhitespace(rest);
    if (leading.length > 0 && leading.length < rest.length) {
      if (unit === undefined || leading.length < unit.length) {
        unit = leading;
      }
    }
  }
  return unit ?? EDITOR_INDENT_UNIT;
}

// Re-express a line's leading whitespace, counted in `fromUnit` levels, as the
// same number of `toUnit` levels after `prefix`. Whitespace that is not a whole
// level is kept as spaces so a hand-aligned continuation line keeps its offset.
// A blank line stays empty, so no trailing whitespace is written.
function reindentLine(line: string, fromUnit: string, toUnit: string, prefix: string): string {
  const leading = leadingWhitespace(line);
  const content = line.slice(leading.length);
  if (content.length === 0) {
    return '';
  }
  const width = leading.replace(/\t/g, fromUnit).length;
  const levels = Math.floor(width / fromUnit.length);
  const spareCount = width - levels * fromUnit.length;
  assert(spareCount >= 0, 'reindentLine: whole levels never exceed the width');
  assert(spareCount < fromUnit.length, 'reindentLine: the spare part is less than a level');
  return prefix + toUnit.repeat(levels) + ' '.repeat(spareCount) + content;
}

// For each line, the line that starts the multi-line prelude (selector list or
// at-rule prelude) it continues; undefined for every other line. A statement
// runs from its first character outside a comment to the next `{`, `;` or `}`
// outside a string or comment, and only one that ends in `{` is a prelude: a
// declaration whose value spans lines keeps its hand alignment as body text.
function preludeStarts(lines: readonly string[]): readonly (number | undefined)[] {
  const starts: (number | undefined)[] = lines.map(() => undefined);
  let quote: string | undefined;
  let comment = false;
  let statementStart: number | undefined;
  for (const [index, line] of lines.entries()) {
    let previous = '';
    for (const character of line) {
      const pair = previous + character;
      previous = character;
      if (comment) {
        if (pair === '*/') {
          comment = false;
          previous = '';
        }
      } else if (quote !== undefined) {
        if (pair === '\\' + character) {
          // An escaped character never closes the string; forget the backslash so `\\` does not escape what follows.
          previous = '';
        } else if (character === quote) {
          quote = undefined;
        }
      } else if (pair === '/*') {
        comment = true;
        previous = '';
      } else if (character === '"' || character === "'") {
        quote = character;
        statementStart ??= index;
      } else if (character === '{') {
        if (statementStart !== undefined) {
          // The lines after the prelude's first, up to the `{`, continue it.
          assert(statementStart <= index, 'preludeStarts: a prelude ends at or after its start');
          starts.fill(statementStart, statementStart + 1, index + 1);
        }
        statementStart = undefined;
      } else if (character === ';' || character === '}') {
        statementStart = undefined;
      } else if (character.trim().length > 0 && character !== '/') {
        // A lone `/` may open a comment with the next character, so it does not start a statement yet.
        statementStart ??= index;
      }
    }
  }
  assert(starts.length === lines.length, 'preludeStarts: one entry per line');
  return starts;
}

// The leading whitespace every non-blank continuation line of each prelude
// shares, keyed by the prelude's start line. What lies past it (an `:is(`
// argument indented by hand) is the selector's own layout and is kept.
function continuationPrefixes(lines: readonly string[], starts: readonly (number | undefined)[]): ReadonlyMap<number, string> {
  assert(starts.length === lines.length, 'continuationPrefixes: one prelude entry per line');
  const prefixes = new Map<number, string>();
  for (const [index, line] of lines.entries()) {
    const start = starts[index];
    if (start === undefined || line.trim().length === 0) {
      continue;
    }
    const leading = leadingWhitespace(line);
    const known = prefixes.get(start);
    prefixes.set(start, known === undefined ? leading : commonPrefix(known, leading));
  }
  assert(prefixes.size <= lines.length, 'continuationPrefixes: at most one prefix per line');
  return prefixes;
}

// Per multi-line prelude, in source order: the indentation its continuation
// lines add past its first line. Empty when they sit at or before it.
function continuationOffsets(lines: readonly string[], starts: readonly (number | undefined)[], base: string): readonly string[] {
  const offsets: string[] = [];
  for (const [start, prefix] of continuationPrefixes(lines, starts)) {
    const line = lines[start];
    assert(line !== undefined, 'continuationOffsets: a prelude start is a line');
    const startIndent = start === 0 ? base : leadingWhitespace(line);
    offsets.push(prefix.startsWith(startIndent) ? prefix.slice(startIndent.length) : '');
  }
  return offsets;
}

// Each prelude start line's position among the multi-line preludes, in order.
function preludeOrdinals(starts: readonly (number | undefined)[]): ReadonlyMap<number, number> {
  const ordinals = new Map<number, number>();
  for (const start of starts) {
    if (start !== undefined && !ordinals.has(start)) {
      ordinals.set(start, ordinals.size);
    }
  }
  assert(ordinals.size <= starts.length, 'preludeOrdinals: at most one ordinal per line');
  return ordinals;
}

// A continuation line moved from `fromPrefix` to `toPrefix`. A line that does
// not carry the whole prefix loses only what it has. A blank line stays empty.
function rebaseLine(line: string, fromPrefix: string, toPrefix: string): string {
  const content = line.trimStart();
  if (content.length === 0) {
    return '';
  }
  const rest = line.startsWith(fromPrefix) ? line.slice(fromPrefix.length) : content;
  return toPrefix + rest;
}

function commonPrefix(first: string, second: string): string {
  let length = 0;
  const lengthMax = Math.min(first.length, second.length);
  while (length < lengthMax && first[length] === second[length]) {
    length += 1;
  }
  assert(length <= lengthMax, 'commonPrefix: never longer than the shorter string');
  return first.slice(0, length);
}

// A body line without the block's indentation. A line indented less than the
// block (a value continued at column 0) loses only what it has.
function stripBase(line: string, base: string): string {
  if (line.startsWith(base)) {
    return line.slice(base.length);
  }
  return line.trimStart();
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

function splitLines(text: string): readonly string[] {
  const lines = text.split('\n');
  assert(lines.length <= LIMITS.treeNodesMax, 'splitLines: a rule spans a bounded number of lines');
  return lines;
}
