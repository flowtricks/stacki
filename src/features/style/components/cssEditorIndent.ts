// How the CSS code editor indents as the author types: Enter inside a rule
// starts the line two spaces past the rule's own, and a `}` typed on a line of
// its own moves back to the rule's column. The unit matches the text the panel
// shows (cssRuleText.ts), so a typed line lines up with the lines around it.
// Each setting is stated here rather than left to CodeMirror's or the
// react-codemirror basic setup's defaults, which could change between versions.

import { css } from '@codemirror/lang-css';
import { indentOnInput, indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EDITOR_INDENT_UNIT } from '../model/cssRuleText';

/** CSS language support plus the indentation rules above. */
export function cssEditorIndentExtensions(): readonly Extension[] {
  return [css(), indentUnit.of(EDITOR_INDENT_UNIT), EditorState.tabSize.of(EDITOR_INDENT_UNIT.length), indentOnInput()];
}
