// A loop over a list held inside a collection's items: every pastor of every
// campus, every tag of every post. The Source picker lets a collection be
// opened and a list field inside its items chosen (LoopSourcePicker.tsx);
// the loop then goes over that field of every item, in the collection's order:
//
//   const campusPastors = (await getCollection("campus")).flatMap((entry) => entry.data?.pastors ?? []); // stacki:query
//   const campusPastors = await sanityClient.fetch("*[_type == \"campus\"].pastors[]->"); // stacki:query
//
// A Sanity list of references is followed (`->`), so the loop gets the
// documents themselves rather than pointers to them. This module writes those
// lines and reads them back, so the Source button can name the list
// ("Campus › Pastors") rather than calling it custom code.

import { assert } from '../../shared/core/assert';
import type { LoopSource } from './loopQuery';
import { parseExpression, parseFrontmatter, type Js } from './loopSyntax';

/** A list field inside a collection's items. */
export interface FieldList {
  readonly source: LoopSource;
  /** The field's path inside an item: `['pastors']`, `['team', 'members']`. */
  readonly path: readonly string[];
  /** Whether a Sanity list holds references, followed to the documents. */
  readonly follow: 'values' | 'references';
}

/** How the frontmatter reads each kind of collection: getCollection, the Sanity client. */
export interface FieldListReaders {
  readonly astro: string | undefined;
  readonly sanity: string | undefined;
}

const PATH_DEPTH_MAX = 8;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
// A Sanity field name GROQ can name plainly: what the schema reader allows, without dots.
const GROQ_FIELD = /^[A-Za-z_][\w-]*$/;

/** The expression for a field list, reading the collection with `reader`. */
export function fieldListCode(list: FieldList, reader: string): string {
  assert(list.path.length > 0, 'A field list names a field');
  assert(list.path.length <= PATH_DEPTH_MAX, 'A field list path is bounded');
  const code = list.source.kind === 'astro' ? astroCode(list, reader) : sanityCode(list, reader);
  const readers = list.source.kind === 'astro' ? { astro: reader, sanity: undefined } : { astro: undefined, sanity: reader };
  assert(fieldListOfExpression(code, readers)?.source.collection === list.source.collection, 'A field list reads back as written');
  return code;
}

/** Whether a Sanity field path can be written into GROQ as it is. */
export function isGroqPath(path: readonly string[]): boolean {
  return path.length > 0 && path.length <= PATH_DEPTH_MAX && path.every((key) => GROQ_FIELD.test(key));
}

/**
 * The field list a loop's data names, when its declaration is one: `data` is
 * the loop head's data (`campusPastors`), read through the frontmatter.
 */
export function fieldListOf(frontmatter: string, data: string, readers: FieldListReaders): FieldList | undefined {
  if (!IDENTIFIER.test(data.trim())) {
    return undefined;
  }
  const declaration = parseFrontmatter(frontmatter).declarations.get(data.trim());
  return declaration?.init === undefined ? undefined : fieldListOfJs(declaration.init, readers);
}

// Every step optional: an item without the field adds nothing rather than
// stopping the page.
function astroCode(list: FieldList, reader: string): string {
  const access = list.path.map((key) => (IDENTIFIER.test(key) ? `?.${key}` : `?.[${JSON.stringify(key)}]`)).join('');
  return `(await ${reader}(${JSON.stringify(list.source.collection)})).flatMap((entry) => entry.data${access} ?? [])`;
}

// `[]` flattens every document's list into one; `->` follows references.
function sanityCode(list: FieldList, client: string): string {
  assert(isGroqPath(list.path), 'A Sanity field list names fields GROQ can');
  assert(GROQ_FIELD.test(list.source.collection), 'A Sanity type is a plain name');
  const groq = `*[_type == "${list.source.collection}"].${list.path.join('.')}[]${list.follow === 'references' ? '->' : ''}`;
  return `await ${client}.fetch(${JSON.stringify(groq)})`;
}

function fieldListOfExpression(code: string, readers: FieldListReaders): FieldList | undefined {
  const parsed = parseExpression(code);
  return parsed === undefined ? undefined : fieldListOfJs(parsed.expression, readers);
}

function fieldListOfJs(init: Js, readers: FieldListReaders): FieldList | undefined {
  if (init.kind === 'await') {
    return readers.sanity === undefined ? undefined : sanityListOf(init.value, readers.sanity);
  }
  return readers.astro === undefined ? undefined : astroListOf(init, readers.astro);
}

// `client.fetch("*[_type == \"t\"].a.b[]->")`.
function sanityListOf(call: Js, client: string): FieldList | undefined {
  if (call.kind !== 'call' || call.callee.kind !== 'member' || call.callee.property !== 'fetch' || call.args.length !== 1) {
    return undefined;
  }
  const object = call.callee.object;
  const groq = call.args[0];
  if (object.kind !== 'name' || object.name !== client || groq?.kind !== 'string') {
    return undefined;
  }
  const match = /^\*\[_type == "([A-Za-z_][\w-]*)"\]\.([A-Za-z_][\w.-]*)\[\](->)?$/.exec(groq.value);
  const path = match?.[2]?.split('.') ?? [];
  if (match?.[1] === undefined || !isGroqPath(path)) {
    return undefined;
  }
  return { source: { kind: 'sanity', collection: match[1] }, path, follow: match[3] === undefined ? 'values' : 'references' };
}

// `(await reader("c")).flatMap((entry) => entry.data.a.b ?? [])`.
function astroListOf(init: Js, reader: string): FieldList | undefined {
  if (init.kind !== 'call' || init.callee.kind !== 'member' || init.callee.property !== 'flatMap' || init.args.length !== 1) {
    return undefined;
  }
  const source = init.callee.object.kind === 'await' ? init.callee.object.value : undefined;
  const first = source?.kind === 'call' && source.callee.kind === 'name' && source.callee.name === reader ? source.args[0] : undefined;
  const callback = init.args[0];
  if (first?.kind !== 'string' || callback?.kind !== 'function') {
    return undefined;
  }
  const parameter = callback.parameters[0];
  const body = callback.body;
  if (parameter?.kind !== 'name' || body?.kind !== 'binary' || body.operator !== '??' || body.right.kind !== 'array') {
    return undefined;
  }
  const path = memberPath(body.left, parameter.name);
  return path === undefined || path.length === 0 ? undefined : { source: { kind: 'astro', collection: first.value }, path, follow: 'values' };
}

// `entry.data.a["b-c"]` → `['a', 'b-c']`; undefined for anything else.
function memberPath(node: Js, parameter: string): readonly string[] | undefined {
  const keys: string[] = [];
  let current: Js = node;
  for (let depth = 0; depth <= PATH_DEPTH_MAX + 1; depth++) {
    if (current.kind === 'member') {
      keys.unshift(current.property);
      current = current.object;
    } else if (current.kind === 'index' && current.index.kind === 'string') {
      keys.unshift(current.index.value);
      current = current.object;
    } else if (current.kind === 'name' && current.name === parameter) {
      return keys[0] === 'data' ? keys.slice(1) : undefined;
    } else {
      return undefined;
    }
  }
  return undefined;
}
