import type { Attr } from '../../shared/page/pageNode';
import { TYPE_OPERATORS } from './dataScope';
// Whether a node renders data rather than fixed markup — an expression prop
// (`href={service.link}`), an `{expr}` child, or text with an interpolation
// in it. Only the node's own props and its direct children count: a section
// isn't "bound" just because something deep inside it is.

interface BindableNode {
  readonly props?: Record<string, { readonly type?: string } | undefined> | undefined;
  readonly children?: readonly { readonly kind?: string; readonly value?: string }[] | undefined;
}

export function isDataBound(node: BindableNode | undefined): boolean {
  if (!node) {
    return false;
  }
  for (const value of Object.values(node.props ?? {})) {
    if (value?.type === 'expr') {
      return true;
    }
  }
  for (const child of node.children ?? []) {
    if (child.kind === 'expr') {
      return true;
    }
    if (child.kind === 'text' && /\{[^{}]*\}/.test(child.value ?? '')) {
      return true;
    }
  }
  return false;
}

// A plain name — `overlap`, `post.data.title`. What a chip can show and a
// picker can choose; anything with an operator or a call in it can't be named
// that way and stays code.
// A step may also be `["campus-name"]`, for a field a dot can't reach.
export const BIND_PATH_RE = /^[A-Za-z_$][\w$]*(?:\[(?:\d+|"(?:[^"\\]|\\.)*")\])*(?:\.[A-Za-z_$][\w$]*(?:\[(?:\d+|"(?:[^"\\]|\\.)*")\])*)*$/;

export interface TemplateHole {
  readonly from: number;
  readonly to: number;
  readonly path: string;
}

/**
 * The `${…}` holes in a piece of code that name plain data, as ranges into the
 * text. What the code editor draws as chips: an expression like
 * ``maxWidth ? `--_mw: ${maxWidth}ch;` : undefined`` is a program — it keeps
 * the code editor rather than becoming a field of chips — but the data inside
 * it is still data, and reading it as one purple word among the code is the
 * whole reason chips exist.
 *
 * Only holes holding a plain path. `${a + 1}` is an expression whose value no
 * picker could choose, so it stays code, coloured like the rest of it.
 */
export function templateHoles(text: unknown): TemplateHole[] {
  const source = String(text ?? '');
  const out: TemplateHole[] = [];
  let i = 0;
  while (i < source.length) {
    // `\${x}` is the characters, not a hole — the same escape partsFromValue
    // honours when it splits a template.
    if (source.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (source.charAt(i) !== '$' || source.charAt(i + 1) !== '{') {
      i += 1;
      continue;
    }
    const close = source.indexOf('}', i + 2);
    if (close === -1) {
      break;
    }
    const path = source.slice(i + 2, close).trim();
    if (BIND_PATH_RE.test(path)) {
      out.push({ from: i, to: close + 1, path });
    }
    i = close + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A prop value as PARTS: the text someone typed, and the data they dropped
// into it. `date={post.data.pubDate}` is one part; ``label={`Posted
// ${post.data.pubDate}`}`` is three. The field edits parts; these two
// functions are the only place that knows how they are written in the file.
// ---------------------------------------------------------------------------

export interface Part {
  readonly text?: string;
  readonly expr?: string;
}

const unescapeTpl = (text: string): string =>
  String(text)
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${')
    .replace(/\\\\/g, '\\');

const escapeTpl = (text: string | undefined): string => String(text).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

// Words that are JavaScript rather than data. `true` is not something to bind
// to, and neither is the `of` in a for loop.
const CODE_WORDS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'new',
  'typeof',
  'void',
  'delete',
  'in',
  'of',
  'instanceof',
  'await',
  'return',
  'if',
  'else',
  'this',
]);

// An expression simple enough to read as data with operators between it —
// `a ?? b`, `a || b`, `a ? b : c`, `a.n + 1`. Calls, arrows, objects and
// template literals are not: those are programs, and a field of chips would be
// a worse way to read one than the code editor.
const NOT_SIMPLE = /[(){}`]|=>|\[\s*[^\d\s]/;

/**
 * An expression split into the data in it and the code around it:
 * `post.data.seo.title ?? post.data.title` is chip · " ?? " · chip. Undefined when
 * the expression is more than that, which keeps the code editor for the cases
 * that need one.
 */
export function codeParts(source: unknown): Part[] | undefined {
  const text = String(source || '');
  if (NOT_SIMPLE.test(text)) {
    return undefined;
  }
  const out: Part[] = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const character = text.charAt(i);
    // A name inside a string is text, not a reference.
    if (character === '"' || character === "'") {
      i += 1;
      while (i < text.length && text.charAt(i) !== character) {
        i += text.charAt(i) === '\\' ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (!/[A-Za-z_$]/.test(character)) {
      i += 1;
      continue;
    }
    let j = i;
    const word = (): void => {
      while (j < text.length && /[\w$]/.test(text.charAt(j))) {
        j += 1;
      }
      while (/^\[\d+\]/.test(text.slice(j))) {
        j += text.slice(j).indexOf(']') + 1;
      }
    };
    word();
    while (text.charAt(j) === '.' && /[A-Za-z_$]/.test(text.charAt(j + 1))) {
      j += 1;
      word();
    }
    // `.title` after a path is part of THAT path, not the start of another —
    // and the whole of it is stepped over, not one character of it. Stepping
    // over one left the rest of the word to be read as a value of its own:
    // `featured?.data.title` came out as `featured` · "?.d" · `ata.title`,
    // a chip beginning in the middle of a name.
    //
    // A `?` breaks the path in two. It is punctuation — it says how the value
    // is reached, not what it is — so it belongs to neither chip, and the
    // property it guards is a chip of its own, dot and all:
    // `featured` · "?" · `.data.title`.
    const optional = text.charAt(i - 1) === '.' && text.charAt(i - 2) === '?';
    if (text.charAt(i - 1) === '.' && !optional) {
      i = j;
      continue;
    }
    // The dot goes INSIDE that chip, so the text still reads as it was written.
    const from = optional ? i - 1 : i;
    const name = text.slice(from, j);
    // The rest of an `as` or `satisfies` clause names a type, not a value to
    // bind. Keep it as code so type names cannot become clickable data chips.
    if (TYPE_OPERATORS.has(name)) {
      break;
    }
    if (!CODE_WORDS.has(name.replace(/^\./, '').split('.')[0] ?? '')) {
      if (from > last) {
        out.push({ text: text.slice(last, from) });
      }
      out.push({ expr: name });
      last = j;
    }
    i = j;
  }
  if (last < text.length) {
    out.push({ text: text.slice(last) });
  }
  // Worth doing only when it is a mix: a bare path is one chip, handled above,
  // and an expression with no data in it has nothing to show.
  return out.some((part) => part.expr !== undefined) && out.some((part) => part.text !== undefined) ? out : undefined;
}

interface ValueLike {
  readonly type?: string;
  readonly value?: unknown;
}

/**
 * How a field's parts are written back. 'text' — the parts are content, joined
 * into a string or a template literal. 'code' — they are an expression, joined
 * as written. The value itself says which, so a field never changes the
 * meaning of what it was opened on.
 */
export function valueModeOf(value: ValueLike | undefined): 'text' | 'code' {
  if (!value || value.type !== 'expr') {
    return 'text';
  }
  const source = String(value.value ?? '').trim();
  if (!source || BIND_PATH_RE.test(source)) {
    return 'text';
  }
  if (/^(['"`])/.test(source)) {
    return 'text';
  }
  return codeParts(source) ? 'code' : 'text';
}

/**
 * Parts for a prop value, or undefined when the value is code no field of chips and
 * text can hold (`items.filter(Boolean)`) — those keep the code editor, which
 * is the only thing that can show them honestly.
 */
export function partsFromValue(value: ValueLike | undefined): Part[] | undefined {
  if (!value) {
    return [];
  }
  if (value.type !== 'expr') {
    return value.value === '' ? [] : [{ text: String(value.value) }];
  }
  const source = String(value.value ?? '').trim();
  if (!source) {
    return [];
  }
  // `cols={3}`, `overlap={true}` — written as expressions because that is how
  // those props are written, but there is nothing bound about them. Ahead of
  // the path test, which would otherwise read `true` as a name to bind to.
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(source) || /^(true|false|null|undefined)$/.test(source)) {
    return [{ text: source }];
  }
  if (BIND_PATH_RE.test(source)) {
    return [{ expr: source }];
  }
  // A quoted string written as an expression is still just text.
  const quoted = source.match(/^(['"])((?:[^\\]|\\.)*)\1$/);
  if (quoted) {
    return [{ text: (quoted[2] ?? '').replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1') }];
  }
  const tpl = source.match(/^`([\s\S]*)`$/);
  // Not a template: an expression, which is data with code between it or
  // nothing this field can show.
  if (!tpl) {
    return codeParts(source);
  }
  const body = tpl[1] ?? '';
  const out: Part[] = [];
  let last = 0;
  let i = 0;
  // Scanned rather than matched: `\${x}` is the text "${x}", and a regex for
  // holes reads it as one — which would turn typed text into a binding.
  while (i < body.length) {
    if (body.charAt(i) === '\\') {
      i += 2;
      continue;
    }
    if (body.charAt(i) !== '$' || body.charAt(i + 1) !== '{') {
      i++;
      continue;
    }
    const close = body.indexOf('}', i + 2);
    if (close === -1) {
      return undefined;
    }
    const expr = body.slice(i + 2, close).trim();
    // One hole that isn't a plain path makes the whole thing code: a field of
    // chips would have to show it as a chip, and a chip that can't be named
    // can't be chosen from a list either.
    if (!BIND_PATH_RE.test(expr)) {
      return undefined;
    }
    if (i > last) {
      out.push({ text: unescapeTpl(body.slice(last, i)) });
    }
    out.push({ expr });
    i = close + 1;
    last = i;
  }
  if (last < body.length) {
    out.push({ text: unescapeTpl(body.slice(last)) });
  }
  return out;
}

/**
 * And back. `numeric` covers the props whose values are written as
 * expressions even when they are plain — `cols={3}`, `overlap={true}` — so
 * typing 3 into one of those fields doesn't quietly write `cols="3"`.
 */
export function valueFromParts(
  parts: readonly Part[] | undefined,
  { numeric, mode }: { readonly numeric?: boolean; readonly mode?: string } = {},
): Extract<Attr, { readonly type: 'string' | 'expr' }> | undefined {
  const clean = (parts ?? []).filter((part) => (part.expr !== undefined ? String(part.expr).trim() !== '' : part.text !== ''));
  if (!clean.length) {
    return undefined;
  }
  // An expression stays an expression: what is between the data in it is code,
  // so it is written as it reads rather than quoted into a template.
  if (mode === 'code' && clean.some((part) => part.expr !== undefined)) {
    return {
      type: 'expr',
      value: clean.map((part) => (part.expr !== undefined ? part.expr : part.text)).join(''),
    };
  }
  // One binding on its own stays one expression — `{post.data.pubDate}`, not a
  // template that stringifies it. A date prop needs the Date, not its text.
  const only = clean.length === 1 ? clean[0] : undefined;
  if (only !== undefined && only.expr !== undefined) {
    return { type: 'expr', value: String(only.expr).trim() };
  }
  if (clean.every((part) => part.text !== undefined)) {
    const text = clean.map((part) => part.text).join('');
    return { type: numeric ? 'expr' : 'string', value: text };
  }
  const body = clean
    .map((part) => {
      return part.expr !== undefined ? `\${${String(part.expr).trim()}}` : escapeTpl(part.text);
    })
    .join('');
  return { type: 'expr', value: `\`${body}\`` };
}

interface PickQuery {
  readonly collection: string;
  readonly name: string;
}

interface BindContext {
  readonly ensureQuery?: (collection: string) => string | undefined;
}

/**
 * A pick can name data the page doesn't fetch yet. `query` says what has to be
 * written before the path means anything; the app answers with the name the
 * query ended up under — which may be one that was already there, since a page
 * asking for the same collection twice is the same query twice.
 */
export function resolvePick(path: string, query: PickQuery | undefined, bindContext: BindContext | undefined): string {
  if (!query || !bindContext?.ensureQuery) {
    return path;
  }
  const actual = bindContext.ensureQuery(query.collection);
  if (!actual || actual === query.name) {
    return path;
  }
  return actual + String(path).slice(query.name.length);
}
