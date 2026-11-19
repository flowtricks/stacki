// Where a value in a component's template comes from, read from text alone. A component hands an image
// its `src` and `alt` in many spellings (`alt={alt}`, `alt={imageAlt}`, `alt={image.alt}`,
// `alt={props.altText ?? ''}`, a `const alt = altProp ?? ""` the template prints, or a `{...image}` spread
// of an object): this module follows each of them back to the prop of the component that supplies it, so
// the canvas can show the prop's own field whatever the prop is called (canvasImageTrace.ts).
//
// Nothing here runs project code. A spelling it does not recognise is answered as blocked, never guessed.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { readPropsDestructure } from '../../editor/loopProps';

/** Aliases followed from one name to another (`const alt = altProp ?? ""`), so a cycle cannot loop. */
export const ALIAS_DEPTH_MAX = 6;
/** Statements and object members read from one component's frontmatter or one literal. */
export const STATEMENTS_MAX = 400;
export const MEMBERS_MAX = 200;
const SCAN_CHARS_MAX = 200_000;

/** What a value comes from. `member` is a field of an object prop (`image.alt` is prop `image`, member `alt`). */
export type ValueSource =
  | { readonly kind: 'prop'; readonly prop: string; readonly member?: string }
  /** Written in the component itself (a string, a number, a template without holes): fixed for every instance. */
  | { readonly kind: 'literal'; readonly text: string | undefined }
  /** Computed, or from something the reader cannot follow. `expression` is what was written. */
  | { readonly kind: 'blocked'; readonly expression: string };

/** A component's frontmatter as the reader needs it: which locals are props, and what each `const` is. */
export interface ComponentScope {
  /** Local name to the prop it reads (`altProp` to `alt`). */
  readonly propLocals: ReadonlyMap<string, string>;
  /** Top-level `const name = initializer`. */
  readonly consts: ReadonlyMap<string, string>;
  /** A prop's default as written, by prop name. */
  readonly defaults: ReadonlyMap<string, string>;
}

/** The scope of a component's frontmatter (the code after its imports). */
export function componentScope(frontmatter: string): ComponentScope {
  const destructure = readPropsDestructure(frontmatter);
  const entries = destructure?.entries ?? [];
  const propLocals = new Map(entries.map((entry) => [entry.local, entry.key]));
  const defaults = new Map<string, string>();
  for (const entry of entries) {
    if (entry.defaultValue !== undefined) {
      defaults.set(entry.key, frontmatter.slice(entry.defaultValue.from, entry.defaultValue.to).trim());
    }
  }
  assert(propLocals.size <= entries.length, 'Each local reads one destructure entry');
  return { propLocals, consts: topLevelConsts(frontmatter), defaults };
}

/**
 * Follows `expression` to its source, as an attribute's value is stored: the code between its braces.
 * Depth-bounded: an alias chain longer than ALIAS_DEPTH_MAX is blocked, not followed.
 */
export function traceValue(expression: string, scope: ComponentScope, depth = 0): ValueSource {
  assert(depth >= 0, 'The alias depth is never negative');
  assert(depth <= LIMITS.treeDepthMax, 'The alias depth stays within the structural bound');
  const written = expression.trim();
  if (depth > ALIAS_DEPTH_MAX) {
    return { kind: 'blocked', expression: written };
  }
  const plain = unwrapped(written);
  const text = literalText(plain);
  if (text !== undefined) {
    return { kind: 'literal', text: text.value };
  }
  const first = splitTopLevel(plain, ['??', '||']);
  if (first.length > 1) {
    // `a ?? b`: a prop with a fallback is still that prop, and a literal with one is still that literal.
    const lead = first[0];
    assert(lead !== undefined, 'A split has a first part');
    return traceValue(lead, scope, depth + 1);
  }
  const path = memberPath(plain);
  if (path === undefined) {
    return { kind: 'blocked', expression: written };
  }
  return traceMemberPath(path, written, scope, depth);
}

function traceMemberPath(path: readonly string[], written: string, scope: ComponentScope, depth: number): ValueSource {
  const [head, ...rest] = path;
  assert(head !== undefined, 'A member path has a head');
  const blocked: ValueSource = { kind: 'blocked', expression: written };
  // `Astro.props.alt` and `props.alt` (after `const props = Astro.props`) name the prop `alt`.
  if (isAstroProps(head, rest, scope)) {
    const asProps = head === 'Astro' ? rest.slice(1) : rest;
    const [prop, ...members] = asProps;
    if (prop === undefined || members.length > 1) {
      return blocked;
    }
    return members[0] === undefined ? { kind: 'prop', prop } : { kind: 'prop', prop, member: members[0] };
  }
  const prop = scope.propLocals.get(head);
  if (prop !== undefined) {
    if (rest.length > 1) {
      return blocked;
    }
    return rest[0] === undefined ? { kind: 'prop', prop } : { kind: 'prop', prop, member: rest[0] };
  }
  const initializer = scope.consts.get(head);
  if (initializer === undefined) {
    return blocked;
  }
  const source = traceValue(initializer, scope, depth + 1);
  if (rest.length === 0) {
    return source;
  }
  // A member of a const that is itself an object literal (`const image = { alt: altProp }`, then `image.alt`).
  const literal = objectLiteral(unwrapped(initializer));
  const member = rest[0];
  if (literal !== undefined && rest.length === 1 && member !== undefined) {
    const found = literal.find((entry) => entry.kind === 'member' && entry.name === member);
    if (found?.kind === 'member') {
      return traceValue(found.expression, scope, depth + 1);
    }
    return blocked;
  }
  if (source.kind === 'prop' && source.member === undefined && rest.length === 1 && member !== undefined) {
    return { kind: 'prop', prop: source.prop, member };
  }
  return blocked;
}

function isAstroProps(head: string, rest: readonly string[], scope: ComponentScope): boolean {
  if (head === 'Astro') {
    return rest[0] === 'props';
  }
  const initializer = scope.consts.get(head);
  return initializer !== undefined && /^Astro\s*\.\s*props$/.test(unwrapped(initializer));
}

/** One entry of an object literal: `key`, `key: value`, `"key": value` or `...spread`. */
export type ObjectEntry =
  { readonly kind: 'member'; readonly name: string; readonly expression: string } | { readonly kind: 'spread'; readonly expression: string };

/** The entries of `{ … }` written as an object literal, or undefined when the text is not one. */
export function objectLiteral(text: string): readonly ObjectEntry[] | undefined {
  const body = unwrapped(text);
  if (!body.startsWith('{') || !body.endsWith('}') || closingBracket(body, 0) !== body.length - 1) {
    return undefined;
  }
  const entries: ObjectEntry[] = [];
  for (const part of splitTopLevel(body.slice(1, -1), [',']).slice(0, MEMBERS_MAX)) {
    const entry = part.trim();
    if (entry === '') {
      continue;
    }
    if (entry.startsWith('...')) {
      entries.push({ kind: 'spread', expression: entry.slice(3).trim() });
      continue;
    }
    const colon = splitTopLevel(entry, [':']);
    const key = colon[0]?.trim() ?? '';
    if (colon.length === 1) {
      // Shorthand: `{ alt }` reads the local `alt`.
      if (IDENTIFIER.test(key)) {
        entries.push({ kind: 'member', name: key, expression: key });
      }
      continue;
    }
    const name = key.replace(/^["']|["']$/g, '');
    entries.push({ kind: 'member', name, expression: entry.slice((colon[0]?.length ?? 0) + 1).trim() });
  }
  return entries;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// `a`, `a.b`, `a?.b`, `a.b.c` as segments; anything else (calls, indexes, operators) is undefined.
function memberPath(text: string): readonly string[] | undefined {
  const segments = text.replaceAll('?.', '.').split('.');
  if (segments.length === 0 || segments.length > 6) {
    return undefined;
  }
  return segments.every((segment) => IDENTIFIER.test(segment.trim())) ? segments.map((segment) => segment.trim()) : undefined;
}

// A string, number or boolean written out, a template with no `${`: the text it holds (undefined for a non-string).
function literalText(text: string): { readonly value: string | undefined } | undefined {
  if (/^(["'])(?:\\.|(?!\1).)*\1$/s.test(text)) {
    return { value: text.slice(1, -1) };
  }
  if (/^`[^`$]*`$/.test(text)) {
    return { value: text.slice(1, -1) };
  }
  if (/^(-?\d+(\.\d+)?|true|false|undefined|null)$/.test(text)) {
    return { value: undefined };
  }
  return undefined;
}

/** `(expr)`, `expr as T`, `expr!` and `expr satisfies T` as the bare expression. */
export function unwrapped(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < ALIAS_DEPTH_MAX * 2; pass++) {
    const before = current;
    if (current.startsWith('(') && current.endsWith(')') && closingBracket(current, 0) === current.length - 1) {
      current = current.slice(1, -1).trim();
    }
    const cast = castStart(current);
    if (cast !== undefined) {
      current = current.slice(0, cast).trim();
    }
    if (current.endsWith('!')) {
      current = current.slice(0, -1).trim();
    }
    if (current === before) {
      return current;
    }
  }
  return current;
}

// The index of a top-level ` as ` or ` satisfies ` cast, when the text ends in one.
function castStart(text: string): number | undefined {
  const parts = splitTopLevelAt(text, [' as ', ' satisfies ']);
  const first = parts[0];
  return parts.length > 1 && first !== undefined ? first.length : undefined;
}

/** The index of the bracket closing the one at `from`, skipping strings; -1 when it never closes. */
export function closingBracket(text: string, from: number): number {
  const open = text[from];
  assert(open === '{' || open === '(' || open === '[', 'A closing bracket is sought from an opening one');
  let depth = 0;
  let quote: string | undefined;
  const limit = Math.min(text.length, SCAN_CHARS_MAX);
  for (let at = from; at < limit; at++) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        return at;
      }
    }
  }
  return -1;
}

/** `text` cut at each top-level occurrence of one of `separators` (outside brackets and strings). */
export function splitTopLevel(text: string, separators: readonly string[]): readonly string[] {
  return splitTopLevelAt(text, separators);
}

function splitTopLevelAt(text: string, separators: readonly string[]): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  const limit = Math.min(text.length, SCAN_CHARS_MAX);
  for (let at = 0; at < limit; at++) {
    const char = text[at];
    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
    } else if (depth === 0) {
      const found = separators.find((separator) => text.startsWith(separator, at));
      if (found !== undefined) {
        parts.push(text.slice(start, at));
        start = at + found.length;
        at += found.length - 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const STATEMENT_START = /^(const|let|var|function|if|for|while|return|import|export|type|interface|class|async|await|try|switch|\/\/|\/\*)\b|^\/[/*]/;

/** Top-level `const name = initializer` of a component's frontmatter, comments dropped, in order. */
export function topLevelConsts(code: string): ReadonlyMap<string, string> {
  const source = withoutComments(code.slice(0, SCAN_CHARS_MAX));
  const found = new Map<string, string>();
  const declaration = /(^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g;
  for (let match = declaration.exec(source), seen = 0; match !== null && seen < STATEMENTS_MAX; match = declaration.exec(source), seen++) {
    const name = match[2];
    assert(name !== undefined, 'A declaration has a name');
    const start = match.index + match[0].length;
    if (depthAt(source, match.index) !== 0) {
      continue;
    }
    const end = initializerEnd(source, start);
    if (!found.has(name)) {
      found.set(name, source.slice(start, end).trim());
    }
    declaration.lastIndex = Math.max(end, declaration.lastIndex);
  }
  return found;
}

// How deep in brackets the text is at `index`, so a `const` inside a function body is not a top-level one.
function depthAt(source: string, index: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let at = 0; at < index; at++) {
    const char = source[at];
    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
    }
  }
  return depth;
}

function initializerEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let at = start; at < source.length; at++) {
    const char = source[at];
    if (quote !== undefined) {
      if (char === '\\') {
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
    } else if (char === '{' || char === '(' || char === '[') {
      depth += 1;
    } else if (char === '}' || char === ')' || char === ']') {
      depth -= 1;
    } else if (depth === 0 && char === ';') {
      return at;
    } else if (depth === 0 && char === '\n') {
      const next = source.slice(at + 1).trimStart();
      if (next === '' || STATEMENT_START.test(next)) {
        return at;
      }
    }
  }
  return source.length;
}

// Line and block comments dropped, with strings left as they were (a `//` in a URL is not a comment).
function withoutComments(code: string): string {
  let out = '';
  let quote: string | undefined;
  for (let at = 0; at < code.length; at++) {
    const char = code[at];
    if (char === undefined) {
      break;
    }
    if (quote !== undefined) {
      out += char;
      if (char === '\\') {
        out += code[at + 1] ?? '';
        at += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      out += char;
    } else if (char === '/' && code[at + 1] === '/') {
      const end = code.indexOf('\n', at);
      at = end === -1 ? code.length : end - 1;
    } else if (char === '/' && code[at + 1] === '*') {
      const end = code.indexOf('*/', at + 2);
      at = end === -1 ? code.length : end + 1;
      out += ' ';
    } else {
      out += char;
    }
  }
  return out;
}
