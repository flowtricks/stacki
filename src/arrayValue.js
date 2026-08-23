// An array a list can edit.
//
// `options={["Designer", "Developer"]}` is a list of things, and a list of
// things is a list of rows: drag one to reorder, click one to open it, press
// the bin to drop it. An item can be a word, a number, or an object with a
// field or two — `{ value: "us", label: "United States" }` — which is a row
// with several things in it and a popup to edit them in.
//
// That only works while every value is one a field can SHOW. `[...defaults,
// other]`, `[getOptions()]`, a name standing for a list somewhere else, an
// object with another object inside it: those are programs, and a row that
// pretended otherwise would lose what it could not draw.
//
// So this reads an array literal and answers with its items, or with null,
// which is the field's cue to stay in the code editor.

// `{ value: "a", label: "A" }` — an object whose every value is a word or a
// number. That is a thing with several fields, which a row can name and a popup
// can edit; an object with a call or another object inside it is not.
function objectFrom(src) {
  const body = src.trim().slice(1, -1);
  const parts = splitTop(body);
  if (!parts) return null;
  const fields = [];
  for (const [i, part] of parts.entries()) {
    if (!part.trim()) {
      if (i === parts.length - 1) continue; // a trailing comma
      return null;
    }
    const colon = topColon(part);
    if (colon === -1) return null; // shorthand `{ value }` names something else
    const rawKey = part.slice(0, colon).trim();
    const key = /^(['"`])(.*)\1$/.test(rawKey) ? rawKey.slice(1, -1) : rawKey;
    const keyQuote = rawKey[0] === '"' || rawKey[0] === "'" ? rawKey[0] : null;
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) return null;
    const value = itemFrom(part.slice(colon + 1));
    // A field holds a word or a number. An object inside an object is a shape
    // with no depth of fields to show it in, and the popup would have nowhere
    // to put it.
    if (!value || value.fields) return null;
    fields.push({ key, keyQuote, text: value.text, quote: value.quote });
  }
  return fields.length ? { fields } : null;
}

/** The first colon that separates a key from its value, at the top level. */
function topColon(part) {
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < part.length && part[i] !== quote) i += part[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') depth--;
    else if (c === ':' && depth === 0) return i;
  }
  return -1;
}

/** A quoted string, a number, an object of those, or nothing this can show. */
function itemFrom(src) {
  const text = src.trim();
  if (!text) return null;
  if (text[0] === '{' && text[text.length - 1] === '}') return objectFrom(text);
  const quote = text[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    if (text.length < 2 || text[text.length - 1] !== quote) return null;
    const body = text.slice(1, -1);
    // A template with a hole in it is code — what it says depends on something
    // else, and a row would have to show the hole rather than the value.
    if (quote === '`' && /\$\{/.test(body)) return null;
    // An unescaped quote inside means the literal ended early: two items were
    // read as one, and this is not the shape it looks like.
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '\\') { i++; continue }
      if (body[i] === quote) return null;
    }
    return { text: body.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'), quote };
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) return { text, quote: null };
  return null;
}

/** Where the top-level commas are, or null if the source is unbalanced. */
function splitTop(body) {
  const out = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < body.length && body[i] !== quote) i += body[i] === '\\' ? 2 : 1;
      if (i >= body.length) return null; // ran off the end inside a string
      continue;
    }
    if (c === '[' || c === '(' || c === '{') depth++;
    else if (c === ']' || c === ')' || c === '}') {
      depth--;
      if (depth < 0) return null;
    } else if (c === ',' && depth === 0) {
      out.push(body.slice(last, i));
      last = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(body.slice(last));
  return out;
}

/**
 * The items of a simple array literal, or null when the value is anything else
 * — a name, an array with a spread or a call in it, or no value at all. An
 * empty array is an empty list, which is not the same as null: one is a list
 * with nothing in it, the other is not a list.
 *
 * @param {string} src
 * @returns {({text: string, quote: string|null}
 *          | {fields: {key: string, keyQuote: string|null, text: string, quote: string|null}[]})[]
 *          | null}
 */
export function arrayItems(src) {
  const text = String(src ?? '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const parts = splitTop(text.slice(1, -1));
  if (!parts) return null;
  const items = [];
  for (const [i, part] of parts.entries()) {
    // A trailing comma leaves one empty part at the end, which is punctuation
    // rather than an item. An empty part anywhere else is a hole — `[a, , b]` —
    // and that is not a list of things.
    if (!part.trim()) {
      if (i === parts.length - 1) continue;
      return null;
    }
    const item = itemFrom(part);
    if (!item) return null;
    items.push(item);
  }
  return items;
}

/** How a string is written back, in the quote it was written with. */
function quoted(item, fallback) {
  const q = item.quote || fallback;
  const body = String(item.text)
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(q, 'g'), `\\${q}`)
    .replace(/\n/g, '\\n');
  return `${q}${body}${q}`;
}

/**
 * The items as an array literal. The quote the file used is kept — a project
 * that writes single quotes should not have double ones appear the first time
 * a list is touched — and a number stays a number.
 */
export function arrayText(items) {
  const list = items || [];
  const fallback =
    list.find((i) => i.quote)?.quote ||
    list.flatMap((i) => i.fields || []).find((f) => f.quote)?.quote ||
    '"';
  const one = (item) => {
    if (item.fields) {
      const inner = item.fields
        .map((f) => `${f.keyQuote ? `${f.keyQuote}${f.key}${f.keyQuote}` : f.key}: ${
          f.quote === null ? String(f.text) : quoted(f, fallback)
        }`)
        .join(', ');
      return `{ ${inner} }`;
    }
    return item.quote === null ? String(item.text) : quoted(item, fallback);
  };
  return `[${list.map(one).join(', ')}]`;
}

// What a row calls an item. An object is named by the field a person would read
// it by — its label, its name, its title — and falls back to the first field it
// has, because a row with nothing written on it is a row nobody can aim at.
const NAMES = ['label', 'name', 'title', 'text', 'value'];
export function itemLabel(item) {
  if (!item) return '';
  if (!item.fields) return String(item.text);
  for (const want of NAMES) {
    const field = item.fields.find((f) => f.key === want && String(f.text).trim());
    if (field) return String(field.text);
  }
  return String(item.fields[0]?.text ?? '');
}

/**
 * An empty item shaped like the ones already in the list: the same fields for a
 * list of objects, a plain word for a list of words. A list of objects that
 * offered a bare word as its next item would write an array the component
 * cannot read.
 */
export function blankLike(items) {
  const shape = (items || []).find((i) => i.fields);
  const quote = (items || []).find((i) => i.quote)?.quote || '"';
  if (!shape) return { text: '', quote };
  return {
    fields: shape.fields.map((f) => ({ key: f.key, keyQuote: f.keyQuote, text: '', quote: f.quote ?? quote })),
  };
}

/**
 * The list with one item moved to sit BEFORE position `to` — the position being
 * a gap between rows, which is what a drop lands in: dropping row 0 into gap 2
 * of [a, b, c] means "after b", so it comes back [b, a, c] and not [b, c, a].
 * Out-of-range or no-op moves return the list unchanged.
 */
export function moveItem(items, from, to) {
  const list = [...(items || [])];
  if (!Number.isInteger(from) || from < 0 || from >= list.length) return list;
  const gap = Math.max(0, Math.min(list.length, Math.trunc(to)));
  if (gap === from || gap === from + 1) return list;
  const [moved] = list.splice(from, 1);
  list.splice(gap > from ? gap - 1 : gap, 0, moved);
  return list;
}
