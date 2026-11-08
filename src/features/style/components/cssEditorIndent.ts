// How the CSS code editor indents as the author types: Enter inside a rule
// starts the line a tab past the rule's own, and a `}` typed on a line of its
// own moves back to the rule's column. The unit is the one every editor shares
// (codeEditorIndent.ts), and the text the panel shows (cssRuleText.ts) is written
// in it, so a typed line lines up with the lines around it.

import { css } from '@codemirror/lang-css';
import { indentOnInput } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { codeIndentExtensions } from '../../../ui/codeEditorIndent';

/** CSS language support plus the indentation rules above. */
export function cssEditorIndentExtensions(): readonly Extension[] {
  return [css(), ...codeIndentExtensions(), indentOnInput()];
}
