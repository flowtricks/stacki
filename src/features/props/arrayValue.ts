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
// So this reads an array literal and answers with its items, or with undefined,
// which is the field's cue to stay in the code editor. A `quote` of undefined marks a
// value written without quotes: a number, or a yes/no.

export interface ScalarItem {
  readonly text: string;
  readonly quote: string | undefined;
  readonly fields?: undefined;
}

export interface ItemField {
  readonly key: string;
  readonly keyQuote: string | undefined;
  readonly text: string;
  readonly quote: string | undefined;
}

export interface ObjectItem {
  readonly fields: readonly ItemField[];
  readonly text?: undefined;
  readonly quote?: undefined;
}

export type Item = ScalarItem | ObjectItem;

type ItemDraft = { text: string; quote: string | undefined } | { fields: ItemField[] };

// `{ value: "a", label: "A" }` — an object whose every value is a word or a
// number. That is a thing with several fields, which a row can name and a popup
// can edit; an object with a call or another object inside it is not.
function objectFrom(source: string): { fields: ItemField[] } | undefined {
  const body = source.trim().slice(1, -1);
  const parts = splitTop(body);
  if (!parts) {
    return undefined;
  }
  const fields: ItemField[] = [];
  for (const [i, part] of parts.entries()) {
    if (!part.trim()) {
      if (i === parts.length - 1) {
        continue; // a trailing comma
      }
      return undefined;
    }
    const colon = topColon(part);
    if (colon === -1) {
      return undefined; // shorthand `{ value }` names something else
    }
    const rawKey = part.slice(0, colon).trim();
    const key = /^(['"`])(.*)\1$/.test(rawKey) ? rawKey.slice(1, -1) : rawKey;
    const first = rawKey.charAt(0);
    const keyQuote = first === '"' || first === "'" ? first : undefined;
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      return undefined;
    }
    const value = itemFrom(part.slice(colon + 1));
    // A field holds a word or a number. An object inside an object is a shape
    // with no depth of fields to show it in, and the popup would have nowhere
    // to put it.
    if (!value || 'fields' in value) {
      return undefined;
    }
    fields.push({ key, keyQuote, text: value.text, quote: value.quote });
  }
  return fields.length ? { fields } : undefined;
}

/** The first colon that separates a key from its value, at the top level. */
function topColon(part: string): number {
  let depth = 0;
  for (let i = 0; i < part.length; i++) {
    const character = part.charAt(i);
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      i++;
      while (i < part.length && part.charAt(i) !== quote) {
        i += part.charAt(i) === '\\' ? 2 : 1;
      }
      continue;
    }
    if (character === '[' || character === '(' || character === '{') {
      depth++;
    } else if (character === ']' || character === ')' || character === '}') {
      depth--;
    } else if (character === ':' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/** A quoted string, a number, an object of those, or nothing this can show. */
function itemFrom(source: string): ItemDraft | undefined {
  const text = source.trim();
  if (!text) {
    return undefined;
  }
  if (text.charAt(0) === '{' && text.charAt(text.length - 1) === '}') {
    return objectFrom(text);
  }
  const quote = text.charAt(0);
  if (quote === '"' || quote === "'" || quote === '`') {
    if (text.length < 2 || text.charAt(text.length - 1) !== quote) {
      return undefined;
    }
    const body = text.slice(1, -1);
    // A template with a hole in it is code — what it says depends on something
    // else, and a row would have to show the hole rather than the value.
    if (quote === '`' && /\$\{/.test(body)) {
      return undefined;
    }
    // An unescaped quote inside means the literal ended early: two items were
    // read as one, and this is not the shape it looks like.
    for (let i = 0; i < body.length; i++) {
      if (body.charAt(i) === '\\') {
        i++;
        continue;
      }
      if (body.charAt(i) === quote) {
        return undefined;
      }
    }
    return { text: body.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n'), quote };
  }
  if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) {
    return { text, quote: undefined };
  }
  return undefined;
}

/** Where the top-level commas are, or undefined if the source is unbalanced. */
function splitTop(body: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const character = body.charAt(i);
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      i++;
      while (i < body.length && body.charAt(i) !== quote) {
        i += body.charAt(i) === '\\' ? 2 : 1;
      }
      if (i >= body.length) {
        return undefined; // ran off the end inside a string
      }
      continue;
    }
    if (character === '[' || character === '(' || character === '{') {
      depth++;
    } else if (character === ']' || character === ')' || character === '}') {
      depth--;
      if (depth < 0) {
        return undefined;
      }
    } else if (character === ',' && depth === 0) {
      out.push(body.slice(last, i));
      last = i + 1;
    }
  }
  if (depth !== 0) {
    return undefined;
  }
  out.push(body.slice(last));
  return out;
}

/**
 * The items of a simple array literal, or undefined when the value is anything
 * else — a name, an array with a spread or a call in it, or no value at all. An
 * empty array is an empty list, which is not the same as undefined: one is a list
 * with nothing in it, the other is not a list.
 */
export function arrayItems(source: unknown): Item[] | undefined {
  const text = String(source ?? '').trim();
  if (!text.startsWith('[') || !text.endsWith(']')) {
    return undefined;
  }
  const parts = splitTop(text.slice(1, -1));
  if (!parts) {
    return undefined;
  }
  const items: Item[] = [];
  for (const [i, part] of parts.entries()) {
    // A trailing comma leaves one empty part at the end, which is punctuation
    // rather than an item. An empty part anywhere else is a hole — `[a, , b]` —
    // and that is not a list of things.
    if (!part.trim()) {
      if (i === parts.length - 1) {
        continue;
      }
      return undefined;
    }
    const item = itemFrom(part);
    if (!item) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

/** How a string is written back, in the quote it was written with. */
function quoted(item: { readonly text: string; readonly quote: string | undefined | undefined }, fallback: string): string {
  const quote = item.quote || fallback;
  const body = String(item.text).replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`).replace(/\n/g, '\\n');
  return `${quote}${body}${quote}`;
}

/**
 * The items as an array literal. The quote the file used is kept — a project
 * that writes single quotes should not have double ones appear the first time
 * a list is touched — and a number stays a number.
 */
export function arrayText(items: readonly Item[] | undefined): string {
  const list = items ?? [];
  const fallback = list.find((item) => item.quote)?.quote || list.flatMap((item) => item.fields ?? []).find((field) => field.quote)?.quote || '"';
  const one = (item: Item): string => {
    if (item.fields) {
      const inner = item.fields
        .map(
          (field) =>
            `${field.keyQuote ? `${field.keyQuote}${field.key}${field.keyQuote}` : field.key}: ${
              field.quote === undefined ? String(field.text) : quoted(field, fallback)
            }`,
        )
        .join(', ');
      return `{ ${inner} }`;
    }
    return item.quote === undefined ? String(item.text) : quoted(item, fallback);
  };
  return `[${list.map(one).join(', ')}]`;
}

export interface ObjectRow {
  readonly key: string;
  readonly keyQuote: string | undefined;
  readonly kind: 'list' | 'boolean' | 'number' | 'text';
  readonly text?: string;
  readonly quote?: string | undefined;
  readonly items?: readonly Item[];
}

/**
 * An object literal a set of fields can edit: `{ legend: "Ministry Role",
 * options: ["Pastors", "Staff"] }`. Every value has to be one a control can
 * show — a word, a number, or a list of those — and every key a plain name.
 *
 * The difference from an item inside a list is depth: an item's fields hold
 * words only, because a row's popup has nowhere to put anything larger. A prop
 * whose whole value is an object has the panel to lay out, so one of its fields
 * can be a list, and that list is the same rows as anywhere else.
 *
 * Undefined for everything else — a name, a call, an object inside an object, a
 * spread — which is the field's cue to stay in the code editor.
 */
export function objectFields(source: unknown): ObjectRow[] | undefined {
  const text = String(source ?? '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return undefined;
  }
  const parts = splitTop(text.slice(1, -1));
  if (!parts) {
    return undefined;
  }
  const out: ObjectRow[] = [];
  for (const [i, part] of parts.entries()) {
    if (!part.trim()) {
      if (i === parts.length - 1) {
        continue; // a trailing comma
      }
      return undefined;
    }
    const colon = topColon(part);
    if (colon === -1) {
      return undefined; // shorthand `{ legend }` names something else
    }
    const rawKey = part.slice(0, colon).trim();
    const key = /^(['"`])(.*)\1$/.test(rawKey) ? rawKey.slice(1, -1) : rawKey;
    const first = rawKey.charAt(0);
    const keyQuote = first === '"' || first === "'" ? first : undefined;
    if (!/^[A-Za-z_$][\w$]*$/.test(key)) {
      return undefined;
    }
    const raw = part.slice(colon + 1).trim();
    if (raw.startsWith('[')) {
      const items = arrayItems(raw);
      if (!items) {
        return undefined; // a list this cannot show is one it must not eat
      }
      out.push({ key, keyQuote, kind: 'list', items });
      continue;
    }
    // A yes/no is a control of its own here — a pair of buttons rather than a
    // box to type `true` into. Only in an object: inside a list an item is a
    // row with a name on it, and "true" is not a name.
    if (raw === 'true' || raw === 'false') {
      out.push({ key, keyQuote, kind: 'boolean', text: raw, quote: undefined });
      continue;
    }
    const value = itemFrom(raw);
    // An object inside an object has no second level of fields to live in.
    if (!value || 'fields' in value) {
      return undefined;
    }
    out.push({
      key,
      keyQuote,
      kind: value.quote === undefined ? 'number' : 'text',
      text: value.text,
      quote: value.quote,
    });
  }
  return out.length ? out : undefined;
}

/** The fields as an object literal, in the quotes the file was written with. */
export function objectText(fields: readonly ObjectRow[] | undefined): string {
  const list = fields ?? [];
  const fallback = list.find((row) => row.quote)?.quote || list.flatMap((row) => row.items ?? []).find((item) => item.quote)?.quote || '"';
  const one = (row: ObjectRow): string => {
    const name = row.keyQuote ? `${row.keyQuote}${row.key}${row.keyQuote}` : row.key;
    if (row.items) {
      return `${name}: ${arrayText(row.items)}`;
    }
    const valueText = row.quote === undefined ? String(row.text) : quoted({ text: row.text ?? '', quote: row.quote }, fallback);
    return `${name}: ${valueText}`;
  };
  return `{ ${list.map(one).join(', ')} }`;
}

// What a row calls an item. An object is named by the field a person would read
// it by — its label, its name, its title — and falls back to the first field it
// has, because a row with nothing written on it is a row nobody can aim at.
const NAMES = ['label', 'name', 'title', 'text', 'value'] as const;

export function itemLabel(item: Item | undefined): string {
  if (!item) {
    return '';
  }
  if (!item.fields) {
    return String(item.text);
  }
  for (const want of NAMES) {
    const field = item.fields.find((candidate) => {
      return candidate.key === want && String(candidate.text).trim();
    });
    if (field) {
      return String(field.text);
    }
  }
  return String(item.fields[0]?.text ?? '');
}

/**
 * An empty item shaped like the ones already in the list: the same fields for a
 * list of objects, a plain word for a list of words. A list of objects that
 * offered a bare word as its next item would write an array the component
 * cannot read.
 */
export function blankLike(items: readonly Item[] | undefined): Item {
  const shape = (items ?? []).find((item) => item.fields);
  const quote = (items ?? []).find((item) => item.quote)?.quote || '"';
  if (!shape || !shape.fields) {
    return { text: '', quote };
  }
  return {
    fields: shape.fields.map((field) => ({
      key: field.key,
      keyQuote: field.keyQuote,
      text: '',
      quote: field.quote ?? quote,
    })),
  };
}

/**
 * The list with one item moved to sit BEFORE position `to` — the position being
 * a gap between rows, which is what a drop lands in: dropping row 0 into gap 2
 * of [a, b, c] means "after b", so it comes back [b, a, c] and not [b, c, a].
 * Out-of-range or no-op moves return the list unchanged.
 */
export function moveItem<T>(items: readonly T[] | undefined, from: number, to: number): T[] {
  const list = [...(items ?? [])];
  if (!Number.isInteger(from) || from < 0 || from >= list.length) {
    return list;
  }
  const gap = Math.max(0, Math.min(list.length, Math.trunc(to)));
  if (gap === from || gap === from + 1) {
    return list;
  }
  const [moved] = list.splice(from, 1);
  if (moved === undefined) {
    return list; // unreachable: from is bounds-checked above
  }
  list.splice(gap > from ? gap - 1 : gap, 0, moved);
  return list;
}
