// A document type's fields as the site's own Sanity Studio defines them: their
// order, titles, help text, whether they are required, and their types.
//
// Sanity does not serve a schema over its API — the schema is the Studio's code
// — so it is read from that code, without running it. Every `defineType({ … })`
// in the project's source is a named type. A document type's `fields: [ … ]`
// lists its fields in order, as `defineField({ name: "address", … })` or plain
// `{ name: "address", … }`; each entry's own keys (not a nested object's) give
// its name, title, description, type and validation. A type that names another
// (`type: "richText"`) resolves through the named types, to a bounded depth.
//
// What code alone cannot settle is left to the value (sanityFields.ts): a type
// built by a function, or a field whose type cannot be resolved. A field whose
// own options say `hidden: true` is hidden in the Studio, and so here; a hidden
// callback depends on the document, so the field is shown. An entry spreading
// `orderRankField(…)` is the orderable plugin's hidden `orderRank`.

import fs from 'node:fs';
import { assert } from '../../shared/core/assert';
import {
  REMOTE_SCHEMA_LIMITS,
  type RemoteOption,
  type RemoteRowPreview,
  type RemoteRule,
  type RemoteScalarKind,
  type RemoteSchemaField,
  type RemoteType,
} from '../../shared/properties/cmsRemoteSchema';
import { rulesOf } from './sanityRules';
import { projectSourceFiles } from './sanityStructure';
import {
  closing,
  entries,
  entryObject,
  ownBracketed,
  ownKey,
  ownSource,
  ownString,
} from './sanitySource';

/** A field as the schema states it; a type the code does not settle is `undefined`. */
export interface SanitySchemaField {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly required: boolean;
  readonly rules: readonly RemoteRule[];
  readonly type: RemoteType | undefined;
}

/**
 * How a document is shown in a list, from its schema's `preview.select`: the
 * paths to its title, subtitle and image, and any other values the Studio's
 * `prepare` builds a subtitle from (which is code, so those values are shown
 * as they are). A path is plain field names with dots, as Sanity writes them.
 */
export interface SanityPreview {
  readonly title: string | undefined;
  readonly media: string | undefined;
  /** What the line under the title is made of, in the order the Studio puts it. */
  readonly parts: readonly { readonly key: string; readonly path: string }[];
}

export interface SanityDocumentSchema {
  readonly preview: SanityPreview | undefined;
  readonly fields: readonly SanitySchemaField[];
  /** Fields the Studio hides, kept out of the panel even though documents hold them. */
  readonly hidden: ReadonlySet<string>;
}

// `defineType` calls one file may hold.
const TYPES_PER_FILE_MAX = 64;
const SCALARS: readonly RemoteScalarKind[] = [
  'string',
  'text',
  'url',
  'email',
  'number',
  'boolean',
  'date',
  'datetime',
  'slug',
];

/** Every type the project's source defines, by name: the body of its `defineType({…})`. */
export function sanityNamedTypes(projectRoot: string): ReadonlyMap<string, string> {
  const named = new Map<string, string>();
  for (const file of projectSourceFiles(projectRoot, (text) => text.includes('defineType('))) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [name, body] of definedTypes(text)) {
      if (!named.has(name)) {
        named.set(name, body);
      }
    }
  }
  return named;
}

/**
 * The Sanity icon each type's schema names (`icon: UserIcon`, imported from
 * `@sanity/icons`), as the icon's symbol (`user`). An icon from anywhere else
 * is the Studio's own drawing, so that type has none here.
 */
export function sanityTypeIcons(projectRoot: string): ReadonlyMap<string, string> {
  const icons = new Map<string, string>();
  for (const file of projectSourceFiles(projectRoot, (text) => text.includes('defineType('))) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const [name, body] of definedTypes(text)) {
      const symbol = iconSymbol(text, body);
      if (symbol !== undefined && !icons.has(name)) {
        icons.set(name, symbol);
      }
    }
  }
  return icons;
}

const ICON_IMPORT =
  /import\s*\{([^}]{1,2000})\}\s*from\s*["'](@sanity\/icons(?:\/[A-Za-z]+)?)["']/g;

/** The symbol of the `@sanity/icons` icon a type's `icon:` names, if it names one. */
export function iconSymbol(text: string, body: string): string | undefined {
  const local = ownSource(body, 'icon')?.trim();
  if (local === undefined || !/^[A-Za-z_$][\w$]{0,63}$/.test(local)) {
    return undefined;
  }
  for (const match of text.matchAll(ICON_IMPORT)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const [imported = '', alias] = specifier.trim().split(/\s+as\s+/);
      if ((alias ?? imported) === local && /^[A-Z][A-Za-z0-9]{0,60}Icon$/.test(imported)) {
        const symbol = imported
          .slice(0, -'Icon'.length)
          .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
          .toLowerCase();
        assert(/^[a-z][a-z0-9-]*$/.test(symbol), 'An icon symbol is kebab case');
        return symbol;
      }
    }
  }
  return undefined;
}

/** The schema of document type `type`, or undefined when the project does not define it. */
export function sanityDocumentSchema(
  named: ReadonlyMap<string, string>,
  type: string,
  lists: ReadonlyMap<string, readonly string[]> = new Map(),
): SanityDocumentSchema | undefined {
  const body = named.get(type);
  if (body === undefined) {
    return undefined;
  }
  const hidden = new Set<string>();
  const fields = fieldsOf(body, { named, lists, depth: 0, hidden });
  assert(fields.length <= REMOTE_SCHEMA_LIMITS.fieldsMax, 'A schema stays within its field bound');
  return { preview: previewOf(body), fields, hidden };
}

/** Each `defineType({ name: … })` in this source text, as name and body. */
export function definedTypes(text: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  let from = 0;
  for (let count = 0; count < TYPES_PER_FILE_MAX; count++) {
    const call = text.indexOf('defineType(', from);
    if (call === -1) {
      break;
    }
    from = call + 1;
    const open = text.indexOf('{', call);
    const close = open === -1 ? undefined : closing(text, open);
    const body = close === undefined ? undefined : inlineHelpers(text.slice(open + 1, close), text);
    const name = body === undefined ? undefined : ownString(body, 'name');
    if (body !== undefined && name !== undefined) {
      out.push([name, body]);
    }
  }
  return out;
}

// A path that is safe to place in a query: up to three field names joined by dots.
const PREVIEW_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,2}$/;
const PREVIEW_OTHERS_MAX = 6;

function previewOf(body: string): SanityPreview | undefined {
  const preview = ownBracketed(body, 'preview', '{');
  const select = preview === undefined ? undefined : ownBracketed(preview, 'select', '{');
  if (preview === undefined || select === undefined) {
    return undefined;
  }
  const paths = entries(select).flatMap((entry) => {
    const match = /^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:\s*["'`]([^"'`]+)["'`]\s*$/.exec(
      entry,
    );
    const key = match?.[1];
    const path = match?.[2];
    return key !== undefined && path !== undefined && PREVIEW_PATH.test(path)
      ? [{ key, path }]
      : [];
  });
  const find = (key: string) => paths.find((entry) => entry.key === key)?.path;
  const parts = subtitleParts(preview, paths).slice(0, PREVIEW_OTHERS_MAX);
  assert(
    parts.every((entry) => PREVIEW_PATH.test(entry.path)),
    'Preview paths are plain',
  );
  return { title: find('title'), media: find('media'), parts };
}

// `options: { columns: 2 }`: the Studio lays the group's fields out side by side.
function columnsOf(own: string): { readonly columns?: number } {
  const options = ownBracketed(own, 'options', '{');
  const columns = Number(
    /^\s*(\d)\b/.exec(options === undefined ? '' : (ownSource(options, 'columns') ?? ''))?.[1],
  );
  return columns >= 2 && columns <= 4 ? { columns } : {};
}

// An object type's list row, when its schema says how to preview it.
function rowPreview(own: string): { readonly preview?: RemoteRowPreview } {
  const preview = previewOf(own);
  if (preview === undefined) {
    return {};
  }
  return { preview: { title: preview.title, parts: preview.parts.map((part) => part.path) } };
}

// The values the line under a title is built from, in order. A `prepare` that
// returns a `subtitle` names them in the order it joins them (`[campus,
// subtitle]`); without one, the selected `subtitle` is the line, or failing
// that every other selected value.
function subtitleParts(
  preview: string,
  paths: readonly { readonly key: string; readonly path: string }[],
): Array<{ readonly key: string; readonly path: string }> {
  const candidates = paths.filter((entry) => !['title', 'media'].includes(entry.key));
  const prepare = ownSource(preview, 'prepare');
  const built = prepare === undefined ? undefined : /\bsubtitle\s*:([^\n]*)/.exec(prepare)?.[1];
  if (built !== undefined) {
    return candidates
      .map((entry) => ({ entry, at: built.search(new RegExp(`\\b${entry.key}\\b`)) }))
      .filter((found) => found.at !== -1)
      .sort((left, right) => left.at - right.at)
      .map((found) => found.entry);
  }
  const subtitle = candidates.filter((entry) => entry.key === 'subtitle');
  return subtitle.length > 0 ? subtitle : candidates;
}

// A field helper in the same file — `const asset = (name, title) => defineField({
// name, title, type: "object", fields: […] })` — written out where it is called,
// with its string arguments in place of its parameters, so the fields it makes
// read as if they had been written by hand. Only helpers whose arguments are
// all string literals are expanded; anything else is left to the value.
const HELPERS_MAX = 16;
const HELPER = new RegExp(
  String.raw`\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^()]{0,200})\)` +
    String.raw`\s*(?::[^=]{0,80})?=>\s*defineField\(\s*\{`,
  'g',
);

function inlineHelpers(body: string, text: string): string {
  let out = body;
  const helpers = [...text.matchAll(HELPER)].slice(0, HELPERS_MAX);
  for (const helper of helpers) {
    const name = helper[1] ?? '';
    const params = (helper[2] ?? '')
      .split(',')
      .map((param) => param.replace(/[:=].*$/s, '').trim())
      .filter((param) => param !== '');
    const open = (helper.index ?? 0) + helper[0].length - 1;
    const close = closing(text, open);
    if (close === undefined || !out.includes(`${name}(`)) {
      continue;
    }
    const keys = text.slice(open + 1, close);
    out = out.replace(
      new RegExp(`(\\.\\.\\.\\s*)?\\b${name}\\(([^()]{0,400})\\)`, 'g'),
      (call: string, spread: string | undefined, args: string) => {
        const values = entries(args).map((arg) => /^\s*(["'`])([^"'`]*)\1\s*$/.exec(arg)?.[2]);
        if (values.length !== params.length || values.some((value) => value === undefined)) {
          return call;
        }
        const filled = withArguments(keys, params, values);
        return spread === undefined ? `{${filled}}` : filled;
      },
    );
  }
  return out;
}

// A helper's object keys with each parameter replaced by its argument: a
// shorthand `name,` becomes `name: "icon1",`, and `title: title` takes the text.
function withArguments(
  keys: string,
  params: readonly string[],
  values: readonly (string | undefined)[],
): string {
  let out = keys;
  params.forEach((param, index) => {
    const literal = JSON.stringify(values[index] ?? '');
    out = out
      .replace(new RegExp(`(:\\s*)${param}\\b`, 'g'), `$1${literal}`)
      .replace(new RegExp(`(^|[{,\\s])${param}(\\s*(?:,|}|$))`, 'g'), `$1${param}: ${literal}$2`);
  });
  return out;
}

interface Resolving {
  readonly named: ReadonlyMap<string, string>;
  /** The project's lists of text by constant name, for `options: { list: [...NAME] }`. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly depth: number;
  /** Where hidden top-level names are collected; nested hidden fields are just dropped. */
  readonly hidden: Set<string> | undefined;
}

// The fields of an object-like body (`fields: [ … ]`), in order, hidden ones out.
function fieldsOf(body: string, context: Resolving): SanitySchemaField[] {
  const list = ownBracketed(body, 'fields', '[');
  if (list === undefined) {
    return [];
  }
  const out: SanitySchemaField[] = [];
  for (const entry of entries(list).slice(0, REMOTE_SCHEMA_LIMITS.fieldsMax)) {
    const own = entryObject(entry);
    // The orderable plugin's `orderRank`, spread into an entry or the entry itself;
    // the plugin always hides it, so the Studio never shows it.
    const spreadRank = /\.\.\.\s*orderRankField\(/.test(own) || /^\s*orderRankField\(/.test(entry);
    const name = ownString(own, 'name') ?? (spreadRank ? 'orderRank' : undefined);
    if (name === undefined || !/^[A-Za-z_][\w]{0,63}$/.test(name)) {
      continue;
    }
    if (literalTrue(own, 'hidden') || spreadRank) {
      context.hidden?.add(name);
      continue;
    }
    out.push({
      name,
      title: ownString(own, 'title') ?? '',
      description: ownString(own, 'description') ?? '',
      required: /\.required\(\)/.test(ownSource(own, 'validation') ?? ''),
      rules: rulesOf(ownSource(own, 'validation')),
      type: typeOf(own, { ...context, hidden: undefined }),
    });
  }
  return out;
}

// The type an entry's own object declares, resolved through named types.
function typeOf(own: string, context: Resolving): RemoteType | undefined {
  if (context.depth > REMOTE_SCHEMA_LIMITS.typeDepthMax) {
    return undefined;
  }
  const name = ownString(own, 'type');
  const inner: Resolving = { ...context, depth: context.depth + 1 };
  const scalar = SCALARS.find((candidate) => candidate === name);
  if (scalar !== undefined) {
    return { kind: scalar, options: optionsOf(own, context.lists) };
  }
  switch (name) {
    case 'geopoint':
    case 'file':
      return { kind: name };
    case 'block':
      return { kind: 'richText' };
    case 'image':
      return { kind: 'image', fields: settled(fieldsOf(own, inner)) };
    case 'object':
    case 'document':
      return {
        kind: 'object',
        name: ownString(own, 'name') ?? 'object',
        fields: settled(fieldsOf(own, inner)),
        ...rowPreview(own),
        ...columnsOf(own),
      };
    case 'reference':
      return { kind: 'reference', to: referenceTargets(own) };
    case 'array':
      return arrayOf(own, inner);
    case undefined:
      return undefined;
    default: {
      const definition = context.named.get(name);
      return definition === undefined ? undefined : typeOf(definition, inner);
    }
  }
}

// An array of block members is rich text; otherwise a list of its member types.
function arrayOf(own: string, context: Resolving): RemoteType | undefined {
  const list = ownBracketed(own, 'of', '[') ?? '';
  const members = entries(list)
    .slice(0, REMOTE_SCHEMA_LIMITS.membersMax)
    .map((entry) => typeOf(entryObject(entry), context));
  if (members.some((member) => member?.kind === 'richText')) {
    return { kind: 'richText' };
  }
  // A list's `options.list` is the values its text items may be — Sanity's
  // checkbox list — so each text member carries those choices.
  const choices = optionsOf(own, context.lists);
  const of = members
    .filter((member): member is RemoteType => member !== undefined)
    .map((member) =>
      member.kind === 'string' && member.options.length === 0 && choices.length > 0
        ? { ...member, options: choices }
        : member,
    );
  return of.length === 0 ? undefined : { kind: 'array', of };
}

function referenceTargets(own: string): string[] {
  const list = ownBracketed(own, 'to', '[') ?? '';
  return entries(list)
    .map((entry) => ownString(entryObject(entry), 'type'))
    .filter((target): target is string => target !== undefined)
    .slice(0, REMOTE_SCHEMA_LIMITS.membersMax);
}

// `options: { list: ["a", …] }` or `[{ title: "A", value: "a" }, …]`.
// `options: { list: [...] }` — text, `{ title, value }`, or a project constant
// spread in (`[...SERMON_SERVICES]`) or named outright (`list: SERMON_SERVICES`).
function optionsOf(own: string, lists: ReadonlyMap<string, readonly string[]>): RemoteOption[] {
  const options = ownBracketed(own, 'options', '{');
  if (options === undefined) {
    return [];
  }
  const named = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(ownSource(options, 'list') ?? '')?.[1];
  const list = ownBracketed(options, 'list', '[');
  const items = named !== undefined ? [`...${named}`] : list === undefined ? [] : entries(list);
  const out = items.flatMap((entry): RemoteOption[] => {
    const spread = /^\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*$/.exec(entry)?.[1];
    if (spread !== undefined) {
      return (lists.get(spread) ?? []).map((value) => ({ title: value, value }));
    }
    const literal = /^\s*["'`]([^"'`]{0,200})["'`]\s*$/.exec(entry)?.[1];
    if (literal !== undefined) {
      return [{ title: literal, value: literal }];
    }
    const value = ownString(entryObject(entry), 'value');
    const title = ownString(entryObject(entry), 'title') ?? value;
    return value === undefined || title === undefined ? [] : [{ title, value }];
  });
  return out.slice(0, REMOTE_SCHEMA_LIMITS.optionsMax);
}

/**
 * The project's constant lists of text (`export const SERMON_SERVICES = ["…", …]`,
 * `as const` or not), by name: what a schema's choices may be built from.
 */
export function sanityConstantLists(projectRoot: string): ReadonlyMap<string, readonly string[]> {
  const lists = new Map<string, readonly string[]>();
  const declaration = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,80})?=\s*\[/g;
  for (const file of projectSourceFiles(projectRoot, (text) =>
    /\bconst\s+\w+\s*=\s*\[/.test(text),
  )) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(declaration)) {
      const name = match[1] ?? '';
      const open = (match.index ?? 0) + match[0].length - 1;
      const close = closing(text, open);
      const values = close === undefined ? [] : stringItems(text.slice(open + 1, close));
      if (values !== undefined && values.length > 0 && !lists.has(name)) {
        lists.set(name, values);
      }
      if (lists.size >= CONSTANT_LISTS_MAX) {
        return lists;
      }
    }
  }
  return lists;
}

const CONSTANT_LISTS_MAX = 500;

// The array's items when every one is a string literal; otherwise it is not a list of text.
function stringItems(list: string): string[] | undefined {
  const values: string[] = [];
  for (const entry of entries(list).slice(0, REMOTE_SCHEMA_LIMITS.optionsMax)) {
    const literal = /^\s*["'`]([^"'`$]{0,200})["'`]\s*$/.exec(entry)?.[1];
    if (literal === undefined) {
      return undefined;
    }
    values.push(literal);
  }
  assert(values.length <= REMOTE_SCHEMA_LIMITS.optionsMax, 'A constant list fits a dropdown');
  return values;
}

// Nested fields need a settled type to be part of an object's shape; one the
// code does not settle is edited as text, which is what most such fields hold.
function settled(fields: readonly SanitySchemaField[]): RemoteSchemaField[] {
  return fields.map((field) => ({ ...field, type: field.type ?? { kind: 'string', options: [] } }));
}

function literalTrue(own: string, key: string): boolean {
  const at = ownKey(own, key);
  return at !== undefined && /^\s*true\b/.test(own.slice(at));
}
