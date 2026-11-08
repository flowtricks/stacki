// The one indentation setting every CodeMirror editor in Stacki and Studio shares.
// A tab per level, shown two columns wide, and the Tab key puts a tab at the
// caret (with a selection it indents the selected lines, and Shift-Tab always
// outdents). Each setting is stated here rather than left to CodeMirror's or the
// react-codemirror basic setup's defaults, which could change between versions.

import { indentLess, indentMore, insertTab } from '@codemirror/commands';
import { indentUnit } from '@codemirror/language';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { CODE_INDENT_UNIT, CODE_TAB_WIDTH } from '../../shared/core/indent';

/** Tabs everywhere, but for a format that forbids them. */
export type CodeIndentStyle = 'spaces' | 'tabs';

const SPACE_INDENT_UNIT = ' '.repeat(CODE_TAB_WIDTH);

/** The style a file's editor uses. YAML forbids tabs in indentation, so a tab there would break the file. */
export function codeIndentStyleFor(path: string): CodeIndentStyle {
  return /\.ya?ml$/i.test(path) ? 'spaces' : 'tabs';
}

/** Tab width and indent unit: what shows, and what auto-indent inserts. */
export function codeIndentSettings(style: CodeIndentStyle = 'tabs'): readonly Extension[] {
  return [EditorState.tabSize.of(CODE_TAB_WIDTH), indentUnit.of(style === 'spaces' ? SPACE_INDENT_UNIT : CODE_INDENT_UNIT)];
}

/** The settings plus the Tab key, for an editor where Tab belongs to the code. */
export function codeIndentExtensions(style: CodeIndentStyle = 'tabs'): readonly Extension[] {
  const tabKey = style === 'spaces' ? { key: 'Tab', run: indentMore, shift: indentLess } : { key: 'Tab', run: insertTab, shift: indentLess };
  return [...codeIndentSettings(style), Prec.high(keymap.of([tabKey]))];
}
