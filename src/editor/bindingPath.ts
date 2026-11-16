// Which `{expression}` nodes are a pure data binding: a name followed by member and index steps, with no call,
// operator, template or JSX in it. The Navigator draws those as a chip, and the Expression panel offers the
// data picker for them; anything else stays code, because a chip would claim a path the expression is not.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

// A name, then `.name` and `[0]` steps. Whitespace is allowed only around the braces.
const BINDING = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[\d{1,6}\])*$/;

// Words that read as names to the pattern but are values, not data.
const LITERAL_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this']);

/** The path inside `{path}` when the expression is a pure data binding, else undefined. */
export function pureBindingPath(expression: string): string | undefined {
  assert(expression.length <= LIMITS.nodeValueCharsMax, 'pureBindingPath: the expression is inside its bound');
  const match = /^\{\s*([^{}]*?)\s*\}$/.exec(expression);
  const path = match?.[1];
  if (path === undefined || !BINDING.test(path)) {
    return undefined;
  }
  const head = /^[A-Za-z_$][\w$]*/.exec(path)?.[0];
  assert(head !== undefined, 'pureBindingPath: a path starts with a name');
  return LITERAL_WORDS.has(head) ? undefined : path;
}
