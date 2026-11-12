// An array a list can edit.
//
// `options={["Designer", "Developer"]}` is a list of things, and a list of
// things is a list of rows: drag one to reorder, click one to open it, press
// the bin to drop it. An item can be a word, a number, or an object with a
// field or two — `{ value: "us", label: "United States" }` — which is a row
// with several things in it and a popup to edit them in.
//
// An item's field can itself hold a list or an object (a List property's item
// fields nest, itemFields.ts): `{ title: "A", children: [{ title: "B" }] }`.
// Such a value stays one field, its text the nested literal as written, and the
// editor draws it with the very rows and fields it draws an item with. It
// nests as deep as a List property's fields do (LIMITS.listFieldDepthMax), and
// a literal that holds anything else, or nests deeper, is code.
//
// That only works while every value is one a field can SHOW. `[...defaults,
// other]`, `[getOptions()]`, a name standing for a list somewhere else, an
// object with another object inside it: those are programs, and a row that
// pretended otherwise would lose what it could not draw.
//
// One thing a row can show that is not a literal: a field of an object bound to
// data, `{ title: entry.data.title }`. The popup draws it as the chip any bound
// field is, so the list stays a list; the array is still one literal in the file.
//
// So this reads an array literal and answers with its items, or with undefined,
// which is the field's cue to stay in the code editor. A `quote` of undefined marks a
// value written without quotes: a number, a yes/no, or a field's code.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

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

const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)$/;

// A List property's item fields nest LIMITS.listFieldDepthMax levels: the top list's items are the first, so
// a literal inside them nests at most one level fewer.
const NESTING_DEPTH_MAX = LIMITS.listFieldDepthMax - 1;

// `{ value: "a", label: "A" }` — an object whose every value is a word, a number
// or an expression. That is a thing with several fields, which a row can name
// and a popup can edit; an object with another object inside it is not.
function objectFrom(source: string, nesting: number): { fields: ItemField[] } | undefined {
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
    // A yes/no field is a switch in the item's popup (listItemShape.ts), so
    // `{ title: "Fast", featured: true }` is still a row and not code.
    const raw = part.slice(colon + 1).trim();
    if (raw === 'true' || raw === 'false') {
      fields.push({ key, keyQuote, text: raw, quote: undefined });
      continue;
    }
    // A list or an object inside an item is a field of its own that is read, and
    // checked, as the literal it is; one this cannot read keeps the whole list code.
    if (raw.startsWith('[') || raw.startsWith('{')) {
      if (nestedItems(raw, nesting + 1) === undefined) {
        return undefined;
      }
      fields.push({ key, keyQuote, text: raw, quote: undefined });
      continue;
    }
    const value = itemFrom(raw, nesting) ?? codeFrom(raw);
    // A field holds a word, a number or code.
    if (!value || 'fields' in value) {
      return undefined;
    }
    fields.push({ key, keyQuote, text: value.text, quote: value.quote });
  }
  return fields.length ? { fields } : undefined;
}

// A field's value as code, written back exactly as it reads. An object or an
// array here is one this could not read (a nested literal is read before this
// is asked), so it stays the list's reason to be code.
function codeFrom(raw: string): ItemDraft | undefined {
  if (raw === '' || raw.startsWith('{') || raw.startsWith('[')) {
    return undefined;
  }
  return { text: raw, quote: undefined };
}

/**
 * Whether a field holds code, where a word, a number or a yes/no is a literal.
 * A nested list or object is a literal too, unless something inside it is
 * bound to data.
 */
export function fieldHoldsCode(field: Pick<ItemField, 'text' | 'quote'>): boolean {
  if (field.quote !== undefined) {
    return false;
  }
  const nested = nestedItems(field.text);
  if (nested !== undefined) {
    return itemsHoldCode(nested);
  }
  return field.text !== 'true' && field.text !== 'false' && !NUMBER_TEXT.test(field.text);
}

/** Whether any item is bound to data, so the list can only be written as the code it is. */
export function itemsHoldCode(items: readonly Item[]): boolean {
  return items.some((item) => (item.fields ?? []).some(fieldHoldsCode));
}

/**
 * The items a nested value holds: an array literal's items, or the one object
 * of an object literal, as `[item]`. Undefined for anything else, and for a
 * literal nested deeper than a List property's fields go.
 */
export function nestedItems(source: string, nesting = 1): Item[] | undefined {
  const text = source.trim();
  if (nesting > NESTING_DEPTH_MAX) {
    return undefined;
  }
  if (text.startsWith('[')) {
    return arrayItems(text, nesting);
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    const object = objectFrom(text, nesting);
    return object === undefined ? undefined : [object];
  }
  return undefined;
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
function itemFrom(source: string, nesting: number): ItemDraft | undefined {
  const text = source.trim();
  if (!text) {
    return undefined;
  }
  if (text.charAt(0) === '{' && text.charAt(text.length - 1) === '}') {
    return objectFrom(text, nesting);
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
  if (NUMBER_TEXT.test(text)) {
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
export function arrayItems(source: unknown, nesting = 0): Item[] | undefined {
  assert(nesting <= NESTING_DEPTH_MAX, 'arrayItems: a list nests within its bound');
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
    const item = itemFrom(part, nesting);
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
    const value = itemFrom(raw, 0);
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
// it by — its label, its name, its title — and falls back to its first text
// field, then its first field, because a row with nothing written on it is a
// row nobody can aim at.
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
  const words = item.fields.find((field) => field.quote !== undefined && String(field.text).trim());
  return String((words ?? item.fields[0])?.text ?? '');
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
  return { fields: shape.fields.map((field) => blankLikeField(field, quote, 1)) };
}

// A field with nothing in it, like `field`: a nested list is empty and a nested object has blank fields of its own.
function blankLikeField(field: ItemField, quote: string, depth: number): ItemField {
  assert(depth <= LIMITS.listFieldDepthMax, 'blankLikeField: a field nests within its bound');
  const nested = field.quote === undefined ? nestedItems(field.text) : undefined;
  const object = nested?.[0]?.fields;
  if (nested !== undefined && field.text.trim().startsWith('[')) {
    return { key: field.key, keyQuote: field.keyQuote, text: '[]', quote: undefined };
  }
  if (object !== undefined) {
    const inner = object.map((own) => blankLikeField(own, quote, depth + 1));
    return { key: field.key, keyQuote: field.keyQuote, text: arrayText([{ fields: inner }]).slice(1, -1), quote: undefined };
  }
  return { key: field.key, keyQuote: field.keyQuote, text: '', quote: field.quote ?? quote };
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
