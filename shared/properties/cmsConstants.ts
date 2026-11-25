// A data file's plain variables, as the CMS panel's file settings add and remove
// them: `export const SITE_TAGLINE = "…";` in `src/consts.ts`, or
// `const heading = "…";` in a page's frontmatter. The main process reads the file
// and the way it already writes its constants (electron/parse/constantFields.ts);
// this module holds what both processes share: the wire shapes and their
// parsers, the name rules, and the one serializer, so the line the panel previews
// is exactly the line written to disk.

import { assert } from '../core/assert';
import { BOUNDARY_LIMITS, boolean, data, list, optional, record, text, type Data, type DataRecord } from '../core/boundary';
import { err, ok, type Result } from '../core/result';

export const CMS_CONSTANT_LIMITS = {
  /** Characters in a new variable's name. Hand-written names stay far below it. */
  nameCharsMax: 64,
  /** Variables one listing returns; a constants file past it is a program, not settings. */
  fieldsMax: 1_000,
  /** Characters of a value's source shown beside its name. */
  previewCharsMax: 120,
  /** Characters of a new variable's description comment. */
  descriptionCharsMax: 300,
  /** Columns a value may use before its array or object breaks onto lines (Prettier's default). */
  lineWidthMax: 80,
} as const satisfies Record<string, number>;

/** What a new variable's value is; the form offers one input for each. */
export const CONSTANT_TYPES = ['string', 'number', 'boolean', 'array', 'object'] as const;
export type ConstantType = (typeof CONSTANT_TYPES)[number];

/** A data module exports its constants; a page's frontmatter declares them. */
export const CONSTANT_HOSTS = ['module', 'page'] as const;
export type ConstantHost = (typeof CONSTANT_HOSTS)[number];

/** Whether the file is TypeScript (annotations and `as const` are allowed) and whether it holds JSX. */
export const CONSTANT_SCRIPTS = ['ts', 'tsx', 'js', 'jsx'] as const;
export type ConstantScript = (typeof CONSTANT_SCRIPTS)[number];

/** How the file's existing names are written; `mixed` keeps a valid typed name as it is. */
export const CONSTANT_NAMINGS = ['screamingSnake', 'camel', 'mixed'] as const;
export type ConstantNaming = (typeof CONSTANT_NAMINGS)[number];

/** Why an edit was refused; every refusal leaves the file exactly as it was. */
export const CONSTANT_REFUSALS = [
  'syntax',
  'fence',
  'invalidName',
  'reservedName',
  'duplicateName',
  'missing',
  'inUse',
  'compound',
  'changed',
  'invalidValue',
  'dependency',
] as const;
export type ConstantRefusal = (typeof CONSTANT_REFUSALS)[number];

/** The way a file writes its constants, read from the ones it has (electron/parse/constantFields.ts). */
export interface ConstantStyle {
  readonly host: ConstantHost;
  readonly script: ConstantScript;
  readonly quote: 'double' | 'single';
  readonly semicolons: boolean;
  readonly asConst: boolean;
  readonly typeAnnotations: boolean;
  readonly descriptionComments: boolean;
  readonly trailingCommas: boolean;
  readonly blankLineBetween: boolean;
  /** One indent step: spaces or a tab. */
  readonly indent: string;
  readonly newline: 'lf' | 'crlf';
  readonly naming: ConstantNaming;
}

/** A new variable: its final identifier, its value, and a description comment for files that write them. */
export interface ConstantField {
  readonly name: string;
  readonly value: Data;
  readonly description?: string;
}

/** One existing variable, as the settings list shows it. `code` is anything that is not a plain literal. */
export interface ConstantSummary {
  readonly name: string;
  readonly type: ConstantType | 'code';
  readonly preview: string;
}

export interface ConstantListing {
  readonly style: ConstantStyle;
  readonly fields: readonly ConstantSummary[];
  /** Every name the file's top level already binds, so the form refuses a duplicate as it is typed. */
  readonly taken: readonly string[];
}

/** An edit to one file's variables; `restore` is an undo or redo, written only over the text it replaced. */
export type ConstantEdit =
  | { readonly kind: 'add'; readonly field: ConstantField }
  | { readonly kind: 'remove'; readonly name: string }
  /** Every variable's name, in the order the file should declare them. */
  | { readonly kind: 'reorder'; readonly order: readonly string[] }
  | { readonly kind: 'restore'; readonly text: string; readonly expected: string };

export type ConstantEditReply =
  { readonly ok: true; readonly before: string; readonly after: string } | { readonly ok: false; readonly refusal: ConstantRefusal };

// Words JavaScript reserves, in strict mode and modules (where `await` and `yield`
// are reserved too), plus the globals a declaration would shadow confusingly.
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'arguments',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'eval',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'Infinity',
  'instanceof',
  'interface',
  'let',
  'NaN',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The identifier a typed name becomes in a file that names its constants `naming`:
 * "site tagline" is `SITE_TAGLINE` or `siteTagline`. A file with mixed names keeps a
 * typed name that is already an identifier as it is. Characters outside ASCII
 * letters and digits separate words, so the result may be empty, which the name
 * check refuses.
 */
export function constantIdentifier(typed: string, naming: ConstantNaming): string {
  assert(typed.length <= BOUNDARY_LIMITS.textLengthMax, 'constantIdentifier: the typed name is bounded');
  const trimmed = typed.trim();
  if (naming === 'mixed') {
    if (IDENTIFIER.test(trimmed)) {
      return trimmed;
    }
  }
  const words = wordsOf(trimmed);
  const identifier = naming === 'screamingSnake' ? words.map((word) => word.toUpperCase()).join('_') : camelOf(words);
  assert(!/\s/.test(identifier), 'constantIdentifier: an identifier holds no whitespace');
  return identifier;
}

/**
 * The names after a drag moves the one at `from` to the drop index `to`, measured
 * before removal (useListReorder.ts): dropping below itself lands one higher.
 */
export function movedNames(names: readonly string[], from: number, to: number): readonly string[] {
  assert(from >= 0, 'movedNames: the dragged row index is not negative');
  assert(from < names.length, 'movedNames: the dragged row exists');
  assert(to >= 0, 'movedNames: the drop index is not negative');
  assert(to <= names.length, 'movedNames: the drop index is within the list');
  const next = [...names];
  const [name] = next.splice(from, 1);
  assert(name !== undefined, 'movedNames: the dragged row has a name');
  next.splice(to > from ? to - 1 : to, 0, name);
  assert(next.length === names.length, 'movedNames: a move keeps every name');
  return next;
}

/** What is wrong with `name` as a new variable beside the names already `taken`, or undefined. */
export function constantNameProblem(name: string, taken: readonly string[]): ConstantRefusal | undefined {
  if (name.length === 0) {
    return 'invalidName';
  }
  if (name.length > CMS_CONSTANT_LIMITS.nameCharsMax) {
    return 'invalidName';
  }
  if (!IDENTIFIER.test(name)) {
    return 'invalidName';
  }
  if (RESERVED_WORDS.has(name)) {
    return 'reservedName';
  }
  if (taken.includes(name)) {
    return 'duplicateName';
  }
  return undefined;
}

/** The value's type as the form names it; `null` and `undefined` are not a variable's value here. */
export function constantTypeOf(value: Data): ConstantType | undefined {
  if (typeof value === 'string') {
    return 'string';
  }
  if (typeof value === 'number') {
    return 'number';
  }
  if (typeof value === 'boolean') {
    return 'boolean';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  return 'object';
}

/**
 * The statement that declares `field` in a file written in `style`, without a
 * final line break: the description comment (when the file writes them and one is
 * given), the keyword, the name, an annotation when the file annotates, the
 * value, `as const` and the semicolon when the file uses them.
 */
export function constantStatement(field: ConstantField, style: ConstantStyle): string {
  const type = constantTypeOf(field.value);
  assert(type !== undefined, 'constantStatement: the value is a plain value');
  assert(constantNameProblem(field.name, []) === undefined, 'constantStatement: the name is a valid identifier');
  const newline = style.newline === 'crlf' ? '\r\n' : '\n';
  const typescript = style.script === 'ts' || style.script === 'tsx';
  const keyword = style.host === 'module' ? 'export const' : 'const';
  const annotation = typescript && style.typeAnnotations ? annotationOf(field.value) : undefined;
  const head = `${keyword} ${field.name}${annotation === undefined ? '' : `: ${annotation}`} = `;
  const value = valueText(field.value, { style, newline, pad: '', used: head.length, depth: 0 });
  const tail = `${typescript && style.asConst ? ' as const' : ''}${style.semicolons ? ';' : ''}`;
  const comment = descriptionCommentOf(field.description, style);
  return `${comment === undefined ? '' : comment + newline}${head}${value}${tail}`;
}

// ---------------------------------------------------------------------------
// Wire parsers
// ---------------------------------------------------------------------------

export function parseConstantStyle(input: unknown): ConstantStyle {
  const value = record(input);
  const indent = text(value['indent']);
  if (indent.length === 0 || indent.length > 8 || indent.trim().length !== 0) {
    throw new Error('Constant style: indent must be 1-8 whitespace characters');
  }
  return {
    host: oneOf(CONSTANT_HOSTS, value['host'], 'host'),
    script: oneOf(CONSTANT_SCRIPTS, value['script'], 'script'),
    quote: oneOf(['double', 'single'] as const, value['quote'], 'quote'),
    semicolons: boolean(value['semicolons']),
    asConst: boolean(value['asConst']),
    typeAnnotations: boolean(value['typeAnnotations']),
    descriptionComments: boolean(value['descriptionComments']),
    trailingCommas: boolean(value['trailingCommas']),
    blankLineBetween: boolean(value['blankLineBetween']),
    indent,
    newline: oneOf(['lf', 'crlf'] as const, value['newline'], 'newline'),
    naming: oneOf(CONSTANT_NAMINGS, value['naming'], 'naming'),
  };
}

export function parseConstantField(input: unknown): ConstantField {
  const value = record(input);
  const name = text(value['name']);
  if (name.length > CMS_CONSTANT_LIMITS.nameCharsMax) {
    throw new Error('Constant field: name exceeds limit');
  }
  const fieldValue = data(value['value']);
  if (constantTypeOf(fieldValue) === undefined) {
    throw new Error('Constant field: value must be a string, number, boolean, array or object');
  }
  const description = optional(text)(value['description']);
  if (description !== undefined && description.length > CMS_CONSTANT_LIMITS.descriptionCharsMax) {
    throw new Error('Constant field: description exceeds limit');
  }
  return description === undefined ? { name, value: fieldValue } : { name, value: fieldValue, description };
}

export function parseConstantEdit(input: unknown): ConstantEdit {
  const value = record(input);
  const kind = oneOf(['add', 'remove', 'reorder', 'restore'] as const, value['kind'], 'edit kind');
  switch (kind) {
    case 'add':
      return { kind, field: parseConstantField(value['field']) };
    case 'remove':
      return { kind, name: constantName(value['name']) };
    case 'reorder': {
      const order = list(constantName)(value['order']);
      if (order.length > CMS_CONSTANT_LIMITS.fieldsMax) {
        throw new Error('Constant edit: order exceeds the field limit');
      }
      if (new Set(order).size !== order.length) {
        throw new Error('Constant edit: order names a field twice');
      }
      return { kind, order };
    }
    case 'restore':
      return { kind, text: text(value['text']), expected: text(value['expected']) };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function parseConstantListing(input: unknown): ConstantListing {
  const value = record(input);
  const fields = list(parseConstantSummary)(value['fields']);
  if (fields.length > CMS_CONSTANT_LIMITS.fieldsMax) {
    throw new Error('Constant listing: field limit exceeded');
  }
  const taken = list(constantName)(value['taken']);
  for (const field of fields) {
    if (!taken.includes(field.name)) {
      throw new Error('Constant listing: a listed field is a taken name');
    }
  }
  return { style: parseConstantStyle(value['style']), fields, taken };
}

/** The listing read, or why the file's variables cannot be read (its syntax, its fence). */
export type ConstantListingReply = { readonly ok: true; readonly listing: ConstantListing } | { readonly ok: false; readonly refusal: ConstantRefusal };

export function parseConstantListingReply(input: unknown): Result<ConstantListing, ConstantRefusal> {
  const value = record(input);
  if (boolean(value['ok'])) {
    return ok(parseConstantListing(value['listing']));
  }
  return err(oneOf(CONSTANT_REFUSALS, value['refusal'], 'refusal'));
}

export function parseConstantEditReply(input: unknown): Result<{ readonly before: string; readonly after: string }, ConstantRefusal> {
  const value = record(input);
  if (boolean(value['ok'])) {
    return ok({ before: text(value['before']), after: text(value['after']) });
  }
  return err(oneOf(CONSTANT_REFUSALS, value['refusal'], 'refusal'));
}

function parseConstantSummary(input: unknown): ConstantSummary {
  const value = record(input);
  const preview = text(value['preview']);
  if (preview.length > CMS_CONSTANT_LIMITS.previewCharsMax + 1) {
    throw new Error('Constant summary: preview exceeds limit');
  }
  return {
    name: constantName(value['name']),
    type: oneOf([...CONSTANT_TYPES, 'code'] as const, value['type'], 'type'),
    preview,
  };
}

// A name read back from the file: any identifier, however long the file wrote it.
function constantName(input: unknown): string {
  const name = text(input);
  if (name.length === 0 || name.length > BOUNDARY_LIMITS.pathLengthMax) {
    throw new Error('Constant name: expected a bounded non-empty name');
  }
  return name;
}

function oneOf<const T extends string>(options: readonly T[], input: unknown, what: string): T {
  const value = text(input);
  const found = options.find((option) => option === value);
  if (found === undefined) {
    throw new Error(`Constants: unknown ${what}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

interface Layout {
  readonly style: ConstantStyle;
  readonly newline: string;
  /** The indent of the line the value starts on. */
  readonly pad: string;
  /** Columns already used on that line before the value. */
  readonly used: number;
  readonly depth: number;
}

// A value written the way the file writes them: short arrays and objects on one
// line, longer ones one entry per line, each entry laid out by the same rule.
function valueText(value: Data, layout: Layout): string {
  assert(layout.depth <= BOUNDARY_LIMITS.depthMax, 'constantStatement: the value nests within the boundary depth');
  const inline = inlineText(value, layout.style, layout.depth);
  if (typeof value !== 'object' || value === null) {
    return inline;
  }
  if (layout.used + inline.length + 1 <= CMS_CONSTANT_LIMITS.lineWidthMax) {
    return inline;
  }
  const inner = layout.pad + layout.style.indent;
  const entries = Array.isArray(value)
    ? value.map((item) => ({ key: '', item }))
    : objectEntries(value).map(([key, item]) => ({ key: keyText(key, layout.style) + ': ', item }));
  if (entries.length === 0) {
    return inline;
  }
  const lines = entries.map(
    ({ key, item }) => inner + key + valueText(item, { ...layout, pad: inner, used: inner.length + key.length, depth: layout.depth + 1 }),
  );
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  const trailing = layout.style.trailingCommas ? ',' : '';
  return `${open}${layout.newline}${lines.join(',' + layout.newline)}${trailing}${layout.newline}${layout.pad}${close}`;
}

function inlineText(value: Data, style: ConstantStyle, depth: number): string {
  assert(depth <= BOUNDARY_LIMITS.depthMax, 'constantStatement: the value nests within the boundary depth');
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return quoted(value, style);
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'constantStatement: numbers are finite');
    return Object.is(value, -0) ? '-0' : String(value);
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => inlineText(item, style, depth + 1)).join(', ')}]`;
  }
  const entries = objectEntries(value);
  if (entries.length === 0) {
    return '{}';
  }
  return `{ ${entries.map(([key, item]) => `${keyText(key, style)}: ${inlineText(item, style, depth + 1)}`).join(', ')} }`;
}

// An object's entries with a value; an absent value is not written, as JSON drops it.
function objectEntries(value: DataRecord): readonly (readonly [string, Data])[] {
  return Object.entries(value).filter(([, item]) => item !== undefined);
}

function keyText(key: string, style: ConstantStyle): string {
  return IDENTIFIER.test(key) ? key : quoted(key, style);
}

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  ' ': '\\u2028',
  ' ': '\\u2029',
};

function quoted(value: string, style: ConstantStyle): string {
  const mark = style.quote === 'single' ? "'" : '"';
  let body = '';
  for (const character of value) {
    const escape = ESCAPES[character];
    if (escape !== undefined) {
      body += escape;
    } else if (character === mark) {
      body += '\\' + mark;
    } else if (character.charCodeAt(0) < 0x20) {
      body += '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0');
    } else {
      body += character;
    }
  }
  return mark + body + mark;
}

// The annotation a file that annotates its constants gets for a value whose type
// is plain to name; a mixed list or an object is left to inference.
function annotationOf(value: Data): string | undefined {
  const type = constantTypeOf(value);
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return type;
  }
  if (Array.isArray(value)) {
    const itemTypes = new Set(value.map((item) => constantTypeOf(item)));
    const [only] = [...itemTypes];
    if (itemTypes.size === 1) {
      if (only === 'string' || only === 'number' || only === 'boolean') {
        return `${only}[]`;
      }
    }
  }
  return undefined;
}

function descriptionCommentOf(description: string | undefined, style: ConstantStyle): string | undefined {
  if (!style.descriptionComments) {
    return undefined;
  }
  // A comment's own closing marker would end it early; line breaks would break the one-line form.
  const clean = (description ?? '').replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim();
  return clean.length === 0 ? undefined : `/** ${clean} */`;
}

function wordsOf(typed: string): readonly string[] {
  // A camelCase or PascalCase name splits at its capitals, so "siteTagline" is two words either way.
  const spaced = typed.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
}

function camelOf(words: readonly string[]): string {
  return words.map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())).join('');
}
