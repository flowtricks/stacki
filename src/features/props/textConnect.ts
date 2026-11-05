// A text node in the Settings panel connected to data and back (TextPanel in
// SourcePanels.tsx): the pieces it becomes when a chip is picked into it, and the
// words it becomes again when it is disconnected.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { propNamed } from '../../editor/loopProps';
import { textWithChip, type FieldFocus } from './fieldFocus';

/** One node a text becomes: words, or an expression written with its braces (`{label}`). */
export type TextPiece = { readonly kind: 'text'; readonly value: string } | { readonly kind: 'expr'; readonly value: string };

// A path a chip names: `label`, `post.data.title`. Anything else is code, which
// the Text panel does not show as a connection.
const PATH = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/** The text `value` with the picked `path` put in: the whole of it when the dot
 * was pressed from outside the field, at the caret or over the selection when not. */
export function connectedPieces(value: string, focus: FieldFocus, path: string): readonly TextPiece[] {
  assert(PATH.test(path), 'connectedPieces: a picked chip is a path');
  const { before, after } = textWithChip(value, focus, path);
  const pieces: TextPiece[] = [];
  if (before.length > 0) {
    pieces.push({ kind: 'text', value: before });
  }
  pieces.push({ kind: 'expr', value: `{${path}}` });
  if (after.length > 0) {
    pieces.push({ kind: 'text', value: after });
  }
  assert(pieces.length <= 3, 'connectedPieces: words, a chip, words');
  return pieces;
}

/** The path an expression node shows as a connection: `{label}` reads `label`; code reads nothing. */
export function connectedPath(expression: string): string | undefined {
  assert(expression.length <= LIMITS.nodeValueCharsMax, 'connectedPath: the expression is inside its bound');
  const match = /^\{\s*([^{}]*?)\s*\}$/.exec(expression);
  const path = match?.[1];
  if (path === undefined) {
    return undefined;
  }
  return PATH.test(path) ? path : undefined;
}

/** The words a disconnected text goes back to: the prop's default when it is a
 * plain string, which is the text it held when the prop was made from it; the
 * path's own name otherwise, so the text is never left empty. */
export function disconnectedText(path: string, frontmatter: string): string {
  assert(PATH.test(path), 'disconnectedText: a connection is a path');
  const local = path.split('.')[0] ?? path;
  const entry = propNamed(frontmatter, local);
  const span = entry?.defaultValue;
  const literal = span === undefined || path !== local ? undefined : stringLiteral(frontmatter.slice(span.from, span.to));
  const out = literal === undefined || literal.length === 0 ? path : literal;
  assert(out.length > 0, 'disconnectedText: a disconnected text has words');
  return out;
}

// A JavaScript string literal's value, for the plain quoted kinds a default is
// written as; undefined for anything else (a template with holes, a call).
function stringLiteral(code: string): string | undefined {
  const text = code.trim();
  if (text.length < 2) {
    return undefined;
  }
  const quote = text.charAt(0);
  if (quote !== '"' && quote !== "'" && quote !== '`') {
    return undefined;
  }
  if (text.charAt(text.length - 1) !== quote) {
    return undefined;
  }
  const body = text.slice(1, -1);
  if (quote === '`' && body.includes('${')) {
    return undefined;
  }
  if (quote === '"') {
    // Frontmatter as written by hand: a malformed escape is no default, not a crash.
    try {
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  // Single quotes and backticks: the escapes a default written by hand uses.
  return body.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n');
}
