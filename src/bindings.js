// Whether a node renders data rather than fixed markup — an expression prop
// (`href={service.link}`), an `{expr}` child, or text with an interpolation
// in it. Only the node's own props and its direct children count: a section
// isn't "bound" just because something deep inside it is.
export function isDataBound(node) {
  if (!node) return false;
  for (const v of Object.values(node.props || {})) {
    if (v?.type === 'expr') return true;
  }
  for (const c of node.children || []) {
    if (c.kind === 'expr') return true;
    if (c.kind === 'text' && /\{[^{}]*\}/.test(c.value || '')) return true;
  }
  return false;
}

// A plain name — `overlap`, `post.data.title`. What a chip can show and a
// picker can choose; anything with an operator or a call in it can't be named
// that way and stays code.
export const BIND_PATH_RE =
  /^[A-Za-z_$][\w$]*(?:\[\d+\])*(?:\.[A-Za-z_$][\w$]*(?:\[\d+\])*)*$/;

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
export function templateHoles(text) {
  const src = String(text ?? '');
  const out = [];
  let i = 0;
  while (i < src.length) {
    // `\${x}` is the characters, not a hole — the same escape partsFromValue
    // honours when it splits a template.
    if (src[i] === '\\') {
      i += 2;
      continue;
    }
    if (src[i] !== '$' || src[i + 1] !== '{') {
      i += 1;
      continue;
    }
    const close = src.indexOf('}', i + 2);
    if (close === -1) break;
    const path = src.slice(i + 2, close).trim();
    if (BIND_PATH_RE.test(path)) out.push({ from: i, to: close + 1, path });
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

const unescapeTpl = (text) =>
  String(text)
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${')
    .replace(/\\\\/g, '\\');

const escapeTpl = (text) =>
  String(text)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');

// Words that are JavaScript rather than data. `true` is not something to bind
// to, and neither is the `of` in a for loop.
const CODE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'new', 'typeof', 'void', 'delete', 'in', 'of',
  'instanceof', 'await', 'return', 'if', 'else', 'this',
]);

// An expression simple enough to read as data with operators between it —
// `a ?? b`, `a || b`, `a ? b : c`, `a.n + 1`. Calls, arrows, objects and
// template literals are not: those are programs, and a field of chips would be
// a worse way to read one than the code editor.
const NOT_SIMPLE = /[(){}`]|=>|\[\s*[^\d\s]/;

/**
 * An expression split into the data in it and the code around it:
 * `post.data.seo.title ?? post.data.title` is chip · " ?? " · chip. Null when
 * the expression is more than that, which keeps the code editor for the cases
 * that need one.
 */
export function codeParts(src) {
  const text = String(src || '');
  if (NOT_SIMPLE.test(text)) return null;
  const out = [];
  let last = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A name inside a string is text, not a reference.
    if (c === '"' || c === "'") {
      i += 1;
      while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (!/[A-Za-z_$]/.test(c)) {
      i += 1;
      continue;
    }
    let j = i;
    const word = () => {
      while (j < text.length && /[\w$]/.test(text[j])) j += 1;
      while (/^\[\d+\]/.test(text.slice(j))) j += text.slice(j).indexOf(']') + 1;
    };
    word();
    while (text[j] === '.' && /[A-Za-z_$]/.test(text[j + 1] || '')) {
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
    const optional = text[i - 1] === '.' && text[i - 2] === '?';
    if (text[i - 1] === '.' && !optional) {
      i = j;
      continue;
    }
    // The dot goes INSIDE that chip, so the text still reads as it was written.
    const from = optional ? i - 1 : i;
    const name = text.slice(from, j);
    if (!CODE_WORDS.has(name.replace(/^\./, '').split('.')[0])) {
      if (from > last) out.push({ text: text.slice(last, from) });
      out.push({ expr: name });
      last = j;
    }
    i = j;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  // Worth doing only when it is a mix: a bare path is one chip, handled above,
  // and an expression with no data in it has nothing to show.
  return out.some((p) => p.expr !== undefined) && out.some((p) => p.text !== undefined)
    ? out
    : null;
}

/**
 * How a field's parts are written back. 'text' — the parts are content, joined
 * into a string or a template literal. 'code' — they are an expression, joined
 * as written. The value itself says which, so a field never changes the
 * meaning of what it was opened on.
 */
export function valueModeOf(value) {
  if (!value || value.type !== 'expr') return 'text';
  const src = String(value.value ?? '').trim();
  if (!src || BIND_PATH_RE.test(src)) return 'text';
  if (/^(['"`])/.test(src)) return 'text';
  return codeParts(src) ? 'code' : 'text';
}

/**
 * Parts for a prop value, or null when the value is code no field of chips and
 * text can hold (`items.filter(Boolean)`) — those keep the code editor, which
 * is the only thing that can show them honestly.
 */
export function partsFromValue(value) {
  if (!value) return [];
  if (value.type !== 'expr') return value.value === '' ? [] : [{ text: String(value.value) }];
  const src = String(value.value ?? '').trim();
  if (!src) return [];
  // `cols={3}`, `overlap={true}` — written as expressions because that is how
  // those props are written, but there is nothing bound about them. Ahead of
  // the path test, which would otherwise read `true` as a name to bind to.
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(src) || /^(true|false|null|undefined)$/.test(src))
    return [{ text: src }];
  if (BIND_PATH_RE.test(src)) return [{ expr: src }];
  // A quoted string written as an expression is still just text.
  const quoted = src.match(/^(['"])((?:[^\\]|\\.)*)\1$/);
  if (quoted) return [{ text: quoted[2].replace(/\\n/g, '\n').replace(/\\(['"\\])/g, '$1') }];
  const tpl = src.match(/^`([\s\S]*)`$/);
  // Not a template: an expression, which is data with code between it or
  // nothing this field can show.
  if (!tpl) return codeParts(src);
  const body = tpl[1];
  const out = [];
  let last = 0;
  let i = 0;
  // Scanned rather than matched: `\${x}` is the text "${x}", and a regex for
  // holes reads it as one — which would turn typed text into a binding.
  while (i < body.length) {
    if (body[i] === '\\') {
      i += 2;
      continue;
    }
    if (body[i] !== '$' || body[i + 1] !== '{') {
      i++;
      continue;
    }
    const close = body.indexOf('}', i + 2);
    if (close === -1) return null;
    const expr = body.slice(i + 2, close).trim();
    // One hole that isn't a plain path makes the whole thing code: a field of
    // chips would have to show it as a chip, and a chip that can't be named
    // can't be chosen from a list either.
    if (!BIND_PATH_RE.test(expr)) return null;
    if (i > last) out.push({ text: unescapeTpl(body.slice(last, i)) });
    out.push({ expr });
    i = close + 1;
    last = i;
  }
  if (last < body.length) out.push({ text: unescapeTpl(body.slice(last)) });
  return out;
}

/**
 * And back. `numeric` covers the props whose values are written as
 * expressions even when they are plain — `cols={3}`, `overlap={true}` — so
 * typing 3 into one of those fields doesn't quietly write `cols="3"`.
 */
export function valueFromParts(parts, { numeric, mode } = {}) {
  const clean = (parts || []).filter((p) =>
    p.expr !== undefined ? String(p.expr).trim() !== '' : p.text !== ''
  );
  if (!clean.length) return undefined;
  // An expression stays an expression: what is between the data in it is code,
  // so it is written as it reads rather than quoted into a template.
  if (mode === 'code' && clean.some((p) => p.expr !== undefined))
    return {
      type: 'expr',
      value: clean.map((p) => (p.expr !== undefined ? p.expr : p.text)).join(''),
    };
  // One binding on its own stays one expression — `{post.data.pubDate}`, not a
  // template that stringifies it. A date prop needs the Date, not its text.
  if (clean.length === 1 && clean[0].expr !== undefined)
    return { type: 'expr', value: String(clean[0].expr).trim() };
  if (clean.every((p) => p.text !== undefined)) {
    const text = clean.map((p) => p.text).join('');
    return { type: numeric ? 'expr' : 'string', value: text };
  }
  const body = clean
    .map((p) => (p.expr !== undefined ? `\${${String(p.expr).trim()}}` : escapeTpl(p.text)))
    .join('');
  return { type: 'expr', value: `\`${body}\`` };
}

/**
 * A pick can name data the page doesn't fetch yet. `query` says what has to be
 * written before the path means anything; the app answers with the name the
 * query ended up under — which may be one that was already there, since a page
 * asking for the same collection twice is the same query twice.
 */
export function resolvePick(path, query, bindCtx) {
  if (!query || !bindCtx?.ensureQuery) return path;
  const actual = bindCtx.ensureQuery(query.collection);
  if (!actual || actual === query.name) return path;
  return actual + String(path).slice(query.name.length);
}
