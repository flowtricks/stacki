// One declaration of an inline `style` attribute, edited in place (plan §3.3,
// `set-inline-style`). The rest of the attribute keeps its bytes — its order,
// spacing, comments and the declarations nobody touched — so an edit to one
// property never rewrites another, and an outside edit to another property
// maps instead of conflicting.
//
// One implementation for both sides: the planner splices the edits this
// returns into the file, and the renderer applies the same edits to its model
// value, so the two cannot disagree about what "set `color`" means.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import type { StyleDeclaration } from './intent';

/** A replacement inside the style text, in UTF-16 offsets of that text. */
export interface StyleTextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export type StyleEditResult =
  | { readonly tag: 'edited'; readonly edits: readonly StyleTextEdit[]; readonly text: string }
  /** The property is declared twice: which one the browser uses is a
   * cascade question, and editing either is a guess. */
  | { readonly tag: 'ambiguous' }
  /** The text is not a plain declaration list (unbalanced brackets, a
   * declaration without a colon): edit it as a whole attribute instead. */
  | { readonly tag: 'unreadable' };

interface Declaration {
  readonly property: string;
  /** The declaration from its property's first character. */
  readonly start: number;
  /** The trimmed value. */
  readonly valueStart: number;
  readonly valueEnd: number;
  /** Past the `;` that ends it, or the trimmed value's end for the last one. */
  readonly end: number;
}

/** Set or remove one property. Removing an absent property changes nothing. */
export function editInlineStyle(text: string, property: string, declaration: StyleDeclaration): StyleEditResult {
  assert(text.length <= LIMITS.attrCharsMax, 'A style value is inside the attribute bound');
  const declarations = scanDeclarations(text);
  if (declarations === undefined) {
    return { tag: 'unreadable' };
  }
  const matching = declarations.filter((found) => sameProperty(found.property, property));
  if (matching.length > 1) {
    return { tag: 'ambiguous' };
  }
  const [found] = matching;
  const edits = declaration.tag === 'set' ? setEdits(text, declarations, found, property, declaration.value) : removeEdits(text, declarations, found);
  return { tag: 'edited', edits, text: applyStyleEdits(text, edits) };
}

/** The one declaration that turns `before` into `after` — set to a value, or
 * removed — when there is exactly one and editInlineStyle writes exactly
 * `after` for it; undefined for anything else (several changes, a reordered
 * or reformatted list), which is then a whole-attribute edit. */
export function singleDeclarationChange(before: string, after: string): { readonly property: string; readonly declaration: StyleDeclaration } | undefined {
  const old = scanDeclarations(before);
  const next = scanDeclarations(after);
  if (old === undefined || next === undefined) {
    return undefined;
  }
  // A property's one value, or undefined when it is absent or declared twice.
  const value = (list: readonly Declaration[], text: string, property: string) => {
    const found = list.filter((entry) => sameProperty(entry.property, property));
    if (found.length !== 1) {
      return undefined;
    }
    const [only] = found;
    return only === undefined ? undefined : text.slice(only.valueStart, only.valueEnd);
  };
  const properties = [...new Set([...old, ...next].map((entry) => entry.property))];
  const changed = properties.filter((property) => value(old, before, property) !== value(next, after, property));
  const [property] = changed;
  if (changed.length !== 1 || property === undefined) {
    return undefined;
  }
  const set = value(next, after, property);
  const declaration: StyleDeclaration = set === undefined ? { tag: 'remove' } : { tag: 'set', value: set };
  const edited = editInlineStyle(before, property, declaration);
  if (edited.tag !== 'edited') {
    return undefined;
  }
  return edited.text === after ? { property, declaration } : undefined;
}

export function applyStyleEdits(text: string, edits: readonly StyleTextEdit[]): string {
  let result = '';
  let cursor = 0;
  for (const edit of edits) {
    assert(cursor <= edit.start, 'Style edits ascend without overlapping');
    assert(edit.start <= edit.end, 'A style edit has an order');
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}

function setEdits(
  text: string,
  declarations: readonly Declaration[],
  found: Declaration | undefined,
  property: string,
  value: string,
): readonly StyleTextEdit[] {
  if (found !== undefined) {
    return [{ start: found.valueStart, end: found.valueEnd, text: value }];
  }
  const last = declarations[declarations.length - 1];
  if (last === undefined) {
    // Nothing declared yet: the new declaration is the whole value, placed
    // where the text has anything but whitespace, or at its start.
    const at = text.trimEnd().length;
    return [{ start: at, end: at, text: `${property}: ${value}` }];
  }
  const closed = text.slice(last.valueEnd, last.end).includes(';');
  return closed
    ? [{ start: last.end, end: last.end, text: ` ${property}: ${value};` }]
    : [{ start: last.valueEnd, end: last.valueEnd, text: `; ${property}: ${value}` }];
}

function removeEdits(text: string, declarations: readonly Declaration[], found: Declaration | undefined): readonly StyleTextEdit[] {
  if (found === undefined) {
    return [];
  }
  const index = declarations.indexOf(found);
  const next = declarations[index + 1];
  if (next !== undefined) {
    return [{ start: found.start, end: next.start, text: '' }];
  }
  // The last one: take the space before it, so no trailing gap is left.
  const previous = declarations[index - 1];
  const from = previous === undefined ? found.start : text.slice(0, found.start).trimEnd().length;
  return [{ start: from, end: found.end, text: '' }];
}

// CSS property names are ASCII case-insensitive; custom properties are not.
function sameProperty(left: string, right: string): boolean {
  if (left.startsWith('--')) {
    return left === right;
  }
  return left.toLowerCase() === right.toLowerCase();
}

// Top-level `;` splits declarations; brackets and quotes hide it (`url(a;b)`,
// `content: ";"`). Every loop walks the text once.
function scanDeclarations(text: string): readonly Declaration[] | undefined {
  const pieces = splitTopLevel(text);
  if (pieces === undefined) {
    return undefined;
  }
  const declarations: Declaration[] = [];
  for (const piece of pieces) {
    const body = text.slice(piece.start, piece.end);
    if (body.trim() === '') {
      continue;
    }
    const colon = body.indexOf(':');
    if (colon === -1) {
      return undefined;
    }
    const leading = body.length - body.trimStart().length;
    const property = body.slice(leading, colon).trim();
    if (property === '') {
      return undefined;
    }
    const valueRaw = body.slice(colon + 1);
    const valueLead = valueRaw.length - valueRaw.trimStart().length;
    const valueStart = piece.start + colon + 1 + valueLead;
    const valueEnd = piece.start + colon + 1 + valueRaw.trimEnd().length;
    declarations.push({
      property,
      start: piece.start + leading,
      valueStart,
      valueEnd: Math.max(valueStart, valueEnd),
      end: piece.terminated ? piece.end + 1 : Math.max(valueStart, valueEnd),
    });
  }
  return declarations;
}

interface Piece {
  readonly start: number;
  readonly end: number;
  readonly terminated: boolean;
}

function splitTopLevel(text: string): readonly Piece[] | undefined {
  const pieces: Piece[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (quote !== undefined) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '(' || char === '[') {
      depth++;
    } else if (char === ')' || char === ']') {
      depth--;
      if (depth < 0) {
        return undefined;
      }
    } else if (char === ';' && depth === 0) {
      pieces.push({ start, end: index, terminated: true });
      start = index + 1;
    }
  }
  if (quote !== undefined || depth !== 0) {
    return undefined;
  }
  pieces.push({ start, end: text.length, terminated: false });
  return pieces;
}
