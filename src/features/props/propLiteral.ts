// The plain text a prop expression writes as a literal, and whether a field's
// type takes that text: shared by the field model's way back to its control and
// the normal-field decision (normalFieldDecision.ts). Pure.

import type { Attr } from '../../../shared/page/pageNode';
import type { FieldDefinition } from './propRules';

// A template literal with nothing to substitute and nothing to unescape is plain text.
const PLAIN_TEMPLATE = /^`([^`$\\]*)`$/;
// A quoted string: no unescaped quote of its own kind inside, so `"a" + "b"` is code.
const QUOTED_STRING = /^(['"])((?:(?!\1)[^\\]|\\.)*)\1$/;

/** The text of a quoted string or a plain template literal; undefined for anything else. */
export function plainTextOf(source: string): string | undefined {
  const trimmed = source.trim();
  const quoted = trimmed.match(QUOTED_STRING);
  if (quoted) {
    return (quoted[2] ?? '').replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1');
  }
  const template = trimmed.match(PLAIN_TEMPLATE);
  return template ? (template[1] ?? '') : undefined;
}

/** A text as the field's plain value, or undefined where the field's type refuses it. */
export function textValue(field: FieldDefinition, text: string): Attr | undefined {
  if (field.type === 'boolean' || field.type === 'number') {
    return undefined;
  }
  if (field.type === 'enum' && !(field.options ?? []).includes(text)) {
    return undefined;
  }
  return { type: 'string', value: text };
}
