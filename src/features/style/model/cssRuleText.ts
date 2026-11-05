// The text of one rule as the CSS Code editor shows it, and back.
//
// A rule inside an Astro <style> block carries the block's indentation: its
// selector sits after `raws.before`, but every later line (declarations and
// the closing brace) holds the file's own leading whitespace. Shown as is, a
// rule in an indented block read `.a {\n        color: red;\n    }`. The editor
// therefore shows the rule flush left with two spaces per level, and a save
// puts the block's indentation and the file's own indent unit back, so the
// source keeps its style and no other rule is touched.

import type { AtRule, Rule } from 'postcss';
import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';

/** The indent unit the editor shows: two spaces per nesting level. */
export const EDITOR_INDENT_UNIT = '  ';

/** How a rule is laid out in its file: the indentation of its own line, and the step one level deeper adds. */
export type RuleLayout = { readonly base: string; readonly unit: string };

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
  const unit = bodyUnit(node.toString(), base);
  assert(unit.length > 0, 'ruleLayout: an indent unit is never empty');
  return { base, unit };
}

/** Source text with `layout.base` stripped and each level of `layout.unit` shown as two spaces. */
export function editorTextFromSource(source: string, layout: RuleLayout): string {
  assert(layout.unit.length > 0, 'editorTextFromSource: an indent unit is never empty');
  const lines = splitLines(source);
  return lines.map((line, index) => (index === 0 ? line : reindentLine(stripBase(line, layout.base), layout.unit, EDITOR_INDENT_UNIT, ''))).join('\n');
}

/** Editor text with the block's indentation and the file's indent unit put back, ready to splice into the file. */
export function sourceTextFromEditor(editorText: string, layout: RuleLayout): string {
  assert(layout.unit.length > 0, 'sourceTextFromEditor: an indent unit is never empty');
  const lines = splitLines(editorText.replace(/\r\n?/g, '\n'));
  return lines.map((line, index) => (index === 0 ? line.trimStart() : reindentLine(line, EDITOR_INDENT_UNIT, layout.unit, layout.base))).join('\n');
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
// step for one level. Two spaces when the rule has no indented body line.
function bodyUnit(source: string, base: string): string {
  let unit: string | undefined;
  for (const [index, line] of splitLines(source).entries()) {
    if (index === 0) {
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
