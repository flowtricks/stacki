// Where a JavaScript condition can be cut into its parts without parsing all
// of JavaScript: the `||` and `&&` that join its top level (outside every
// bracket, string, template and comment), and whether anything looser than
// them sits there too (a ternary `?`, `??`, a comma, an assignment, an arrow),
// which makes the whole condition one piece of code.
//
//   render && (isWritten ? content : true)   → one `&&`, at 7; nothing looser
//   a ? b : c                                → looser: one piece
//
// The template condition editor reads each part on its own: the parts it can
// draw become rows, the rest stay code, byte for byte (conditionExpressionRich.ts).
// A regular expression cannot be told from a division without a parser, so code
// with a `/` where a value would start is not delimited (undefined), and stays
// code as a whole. Pure, bounded and total: code is data here, so no input throws.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export interface TopLevelScan {
  /** The index of each top-level `||`, in order. */
  readonly ors: readonly number[];
  /** The index of each top-level `&&`, in order. */
  readonly ands: readonly number[];
  /** A top-level operator looser than `&&` and `||`, or one that cannot be mixed with them. */
  readonly loose: boolean;
}

// What closes the bracket opened last; `template` is the `}` that ends a `${`, after which the template's text resumes.
type Closer = ')' | ']' | '}' | 'template';

// The characters after which a `/` starts a value (a regular expression) rather than dividing one.
const VALUE_STARTS_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '<', '>', '+', '-', '*', '%', '~', '^']);

/** The top level of `code`, or undefined when its brackets, strings or comments do not close, or a `/` may start a regular expression. */
export function scanTopLevel(code: string): TopLevelScan | undefined {
  if (code.length > LIMITS.attrCharsMax) {
    return undefined;
  }
  const ors: number[] = [];
  const ands: number[] = [];
  let loose = false;
  const closers: Closer[] = [];
  let previous = ''; // The last character that was not space, a string or a comment: what a `/` follows.
  let index = 0;
  // Every turn moves `index` forward by at least one, so the loop ends within the code's length.
  for (let turn = 0; index < code.length && turn <= code.length; turn += 1) {
    const start = index;
    const character = code.charAt(index);
    const next = code.charAt(index + 1);
    // Inside a `${ … }` the code is scanned as code; its closing `}` is handled with the other closers.
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = code.indexOf('\n', index);
      index = end < 0 ? code.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = code.indexOf('*/', index + 2);
      if (end < 0) {
        return undefined;
      }
      index = end + 2;
      continue;
    }
    if (character === '/' && VALUE_STARTS_AFTER.has(previous)) {
      return undefined; // A regular expression: not delimited without a parser.
    }
    if (character === '"' || character === "'") {
      const end = quotedEnd(code, index, character);
      if (end === undefined) {
        return undefined;
      }
      index = end;
      previous = character;
      continue;
    }
    if (character === '`') {
      const end = templateEnd(code, index + 1, closers);
      if (end === undefined) {
        return undefined;
      }
      index = end;
      previous = end > 0 && code.charAt(end - 1) === '`' ? '`' : '{';
      continue;
    }
    if (character === '(' || character === '[' || character === '{') {
      closers.push(character === '(' ? ')' : character === '[' ? ']' : '}');
      index += 1;
      previous = character;
      continue;
    }
    if (character === ')' || character === ']' || character === '}') {
      const expected = closers.pop();
      if (expected === 'template' && character === '}') {
        // The `${ … }` closed: the template's text resumes after it.
        const end = templateEnd(code, index + 1, closers);
        if (end === undefined) {
          return undefined;
        }
        index = end;
        previous = code.charAt(end - 1) === '`' ? '`' : '{';
        continue;
      }
      if (expected !== character) {
        return undefined;
      }
      index += 1;
      previous = character;
      continue;
    }
    if (closers.length === 0) {
      const step = topLevelOperator(code, index);
      if (step.kind === 'or') {
        ors.push(index);
      } else if (step.kind === 'and') {
        ands.push(index);
      } else if (step.kind === 'loose') {
        loose = true;
      }
      index += step.length;
    } else {
      index += nestedOperatorLength(code, index);
    }
    previous = code.charAt(index - 1);
    assert(index > start, 'scanTopLevel: every turn moves forward');
  }
  if (index < code.length || closers.length > 0) {
    return undefined;
  }
  return { ors, ands, loose };
}

type OperatorStep = { readonly kind: 'or' | 'and' | 'loose' | 'other'; readonly length: number };

// The operator at `index` on the top level, longest first, so `||=` is an assignment and `?.` a member access.
function topLevelOperator(code: string, index: number): OperatorStep {
  const rest = code.slice(index, index + 4);
  if (rest.startsWith('||=') || rest.startsWith('&&=') || rest.startsWith('??=')) {
    return { kind: 'loose', length: 3 };
  }
  if (rest.startsWith('||')) {
    return { kind: 'or', length: 2 };
  }
  if (rest.startsWith('&&')) {
    return { kind: 'and', length: 2 };
  }
  if (rest.startsWith('??')) {
    return { kind: 'loose', length: 2 };
  }
  // `?.` is optional chaining unless a digit follows (`a?.5:1` is a ternary).
  if (rest.startsWith('?.') && !/\d/.test(rest.charAt(2))) {
    return { kind: 'other', length: 2 };
  }
  if (rest.startsWith('?') || rest.startsWith(',') || rest.startsWith('=>')) {
    return { kind: 'loose', length: rest.startsWith('=>') ? 2 : 1 };
  }
  const comparison = ['===', '!==', '==', '!=', '<=', '>='].find((candidate) => rest.startsWith(candidate));
  if (comparison !== undefined) {
    return { kind: 'other', length: comparison.length };
  }
  if (rest.startsWith('=') || /^(?:\+|-|\*|\/|%|\*\*|<<|>>|>>>|&|\||\^)=/.test(rest)) {
    return { kind: 'loose', length: 1 }; // An assignment.
  }
  return { kind: 'other', length: wordLength(code, index) };
}

// Inside brackets nothing is recorded, but a comparison is still taken whole, so its `=` is never an assignment.
function nestedOperatorLength(code: string, index: number): number {
  return wordLength(code, index);
}

// A name or a number moves as a whole, so a word that ends in a digit never looks like the start of something else.
function wordLength(code: string, index: number): number {
  const word = /^[\w$]+/.exec(code.slice(index, index + LIMITS.attrCharsMax));
  return word === null ? 1 : word[0].length;
}

// The index after the closing quote of the string opened at `start`, or undefined when a line ends first.
function quotedEnd(code: string, start: number, quote: string): number | undefined {
  for (let index = start + 1; index < code.length; index += 1) {
    const character = code.charAt(index);
    if (character === '\\') {
      index += 1;
    } else if (character === quote) {
      return index + 1;
    } else if (character === '\n') {
      return undefined;
    }
  }
  return undefined;
}

// From inside a template's text: the index after its closing backtick, or after a `${` (pushing the `}` that ends it).
function templateEnd(code: string, from: number, closers: Closer[]): number | undefined {
  for (let index = from; index < code.length; index += 1) {
    const character = code.charAt(index);
    if (character === '\\') {
      index += 1;
    } else if (character === '`') {
      return index + 1;
    } else if (character === '$' && code.charAt(index + 1) === '{') {
      if (closers.length >= LIMITS.treeDepthMax) {
        return undefined;
      }
      closers.push('template');
      return index + 2;
    }
  }
  return undefined;
}

/** The trimmed pieces of `code` between the cuts at `at` (each cut `width` long). */
export function cutAt(code: string, at: readonly number[], width: number): readonly string[] {
  const pieces: string[] = [];
  let from = 0;
  for (const cut of at) {
    assert(cut >= from, 'cutAt: the cuts are in order');
    pieces.push(code.slice(from, cut).trim());
    from = cut + width;
  }
  pieces.push(code.slice(from).trim());
  assert(pieces.length === at.length + 1, 'cutAt: one piece more than cuts');
  return pieces;
}

/** `code` without the parentheses around all of it (`(a || b)` → `a || b`); unchanged when there are none. */
export function withoutOuterParentheses(code: string): string {
  let text = code.trim();
  for (let round = 0; round < LIMITS.treeDepthMax && text.startsWith('(') && text.endsWith(')'); round += 1) {
    const inner = text.slice(1, -1);
    // `(a) || (b)` starts and ends with parentheses that are not one pair: its inside does not balance.
    if (scanTopLevel(inner) === undefined) {
      break;
    }
    text = inner.trim();
  }
  return text;
}

/** Whether `code` needs parentheses to sit as one part of an `&&` or `||` chain: it has a top level operator of its own. */
export function needsParentheses(code: string): boolean {
  const scan = scanTopLevel(code);
  if (scan === undefined) {
    return true;
  }
  return scan.loose || scan.ors.length > 0 || scan.ands.length > 0;
}
