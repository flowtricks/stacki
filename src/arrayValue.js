// An array a list can edit.
//
// `options={["Designer", "Developer"]}` is a list of things, and a list of
// things is a list of rows: drag one to reorder, click one to change it, press
// the bin to drop it. That only works while every item is a value a row can
// SHOW — a word or a number. `[...defaults, other]`, `[{ value, label }]`, a
// name standing for a list somewhere else: those are programs, and a row that
// pretended otherwise would lose what it could not draw.
//
// So this reads an array literal and answers with its items, or with null,
// which is the field's cue to stay in the code editor.

/** A quoted string, a number, or nothing this can show. */
function itemFrom(src) {
  const text = src.trim();
  if (!text) return null;
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
 * — including a name, an array with a spread or an object in it, or no value at
 * all. An empty array is an empty list, which is not the same as null: one is a
 * list with nothing in it, the other is not a list.
 *
 * @param {string} src
 * @returns {{text: string, quote: string|null}[] | null}
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
  const fallback = list.find((i) => i.quote)?.quote || '"';
  return `[${list.map((i) => (i.quote === null ? String(i.text) : quoted(i, fallback))).join(', ')}]`;
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
