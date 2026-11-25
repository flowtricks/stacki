// The component default values that `props` cannot hold (componentDefaults.ts): an imported file under src/, and a list or
// object written as a literal.
//
// They sit under their own recipe keys, `assets` and `literals`, rather than as new kinds of value in `props`: a Stacki
// that does not know them reads a recipe key by key and skips them, so it still opens the file and every other default.
// An object inside `props` would make it refuse the whole file. (Saving from such a version drops the two keys.)
//
// `assets.<prop>` is `{ "file": "src/assets/hero.png" }`, plus `"url": true` where picking it by hand writes
// `name.src` (a plain <img>, or a prop typed as text). A file in public/ or a hosted one is a URL, and stays a string
// in `props`. `literals.<prop>` is a list or object (a list of options) as the expression's own source (`["a", "b"]`),
// accepted only when it is nothing but literal data, since it is written into pages as code: it is read token by token,
// never run. Where it names imported files (`[{ image: hero }]`) it is `{ "source": "…", "imports": { "hero":
// "src/assets/hero.png" } }`, and each of those names is an import wherever the value is written.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import type { ComponentDefaults, ComponentRecipe, DefaultValue, RecipeChild, ResolvedNode } from './componentDefaults';

export const DEFAULT_VALUE_LIMITS = {
  /** Assets, or literals, on one recipe node (the same as its props). */
  entriesMax: 64,
  pathCharsMax: 500,
  literalCharsMax: 16_384,
  literalDepthMax: 12,
  literalTokensMax: 4096,
  literalImportsMax: 32,
  /** Recipe levels and nodes one walk visits: the stored limits of componentDefaults.ts. */
  walkDepthMax: 13,
  walkNodesMax: 4096,
} as const satisfies Record<string, number>;

const PROP_NAME = /^[A-Za-z_][\w:-]{0,99}$/;
const ASSET_EXTENSION = /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|m4v|ogv|ogg|mp3|wav|m4a|flac|aac)$/i;

export interface AssetDefault {
  readonly file: string;
  readonly url?: true;
}
export type AssetDefaults = Readonly<Record<string, AssetDefault>>;
/** A literal's source, or its source and the files the names in it import. */
export type LiteralDefault = string | { readonly source: string; readonly imports: Readonly<Record<string, string>> };
export type LiteralDefaults = Readonly<Record<string, LiteralDefault>>;
export interface HeldDefaults {
  readonly assets?: AssetDefaults;
  readonly literals?: LiteralDefaults;
}

/** Whether an import specifier names a media file, by its extension. */
export const isAssetSpecifier = (specifier: string): boolean => ASSET_EXTENSION.test(specifier);

/** Whether `file` can be an asset default: a media file the page imports, project-relative, under src/. */
export function isAssetDefaultFile(file: string): boolean {
  if (file.length > DEFAULT_VALUE_LIMITS.pathCharsMax || !file.startsWith('src/') || !ASSET_EXTENSION.test(file)) {
    return false;
  }
  if (/[\x00-\x1f\\?#]/.test(file)) {
    return false;
  }
  return file.split('/').every((segment) => segment !== '' && !segment.startsWith('.'));
}

function parseAsset(input: unknown): AssetDefault {
  const value = record(input);
  if (Object.keys(value).some((key) => key !== 'file' && key !== 'url')) {
    throw new Error('An asset default holds a file, and url when the page reads its address');
  }
  const file = text(value['file']);
  if (!isAssetDefaultFile(file)) {
    throw new Error('An asset default names a media file under src/');
  }
  if (value['url'] !== undefined && value['url'] !== true) {
    throw new Error('Asset default url is true or left out');
  }
  return value['url'] === true ? { file, url: true } : { file };
}

function parseEntries<T>(input: unknown, parse: (value: unknown) => T): Readonly<Record<string, T>> {
  const entries = Object.entries(record(input));
  if (entries.length > DEFAULT_VALUE_LIMITS.entriesMax) {
    throw new Error('Too many default props');
  }
  return Object.fromEntries(
    entries.map(([name, value]) => {
      if (!PROP_NAME.test(name)) {
        throw new Error('Invalid default prop name');
      }
      return [name, parse(value)];
    }),
  );
}

function parseLiteral(input: unknown): LiteralDefault {
  if (typeof input === 'string') {
    if (!isLiteralSource(input)) {
      throw new Error('A literal default is a list, object or other literal value');
    }
    return input;
  }
  const value = record(input);
  if (Object.keys(value).some((key) => key !== 'source' && key !== 'imports')) {
    throw new Error('A literal default with imports holds source and imports');
  }
  const source = text(value['source']);
  const entries = Object.entries(record(value['imports']));
  if (entries.length === 0 || entries.length > DEFAULT_VALUE_LIMITS.literalImportsMax) {
    throw new Error('A literal default names between one and 32 imports');
  }
  const imports = Object.fromEntries(
    entries.map(([name, input]) => {
      const file = text(input);
      if (!/^[A-Za-z_$][\w$]{0,99}$/.test(name) || RESERVED.has(name) || LITERAL_WORDS.has(name) || !isAssetDefaultFile(file)) {
        throw new Error('A literal default imports media files under src/ by name');
      }
      return [name, file];
    }),
  );
  const used = literalReferences(source, new Set(Object.keys(imports)));
  if (used === undefined || new Set(used.map((reference) => reference.name)).size !== entries.length) {
    throw new Error('A literal default is literal data naming each of its imports');
  }
  return { source, imports };
}

/** A recipe node's `assets` and `literals`, parsed. A prop is held in one place only. */
export function parseHeldDefaults(value: Readonly<Record<string, unknown>>, props: Readonly<Record<string, DefaultValue>>): HeldDefaults {
  const assets = value['assets'] === undefined ? undefined : parseEntries(value['assets'], parseAsset);
  const literals = value['literals'] === undefined ? undefined : parseEntries(value['literals'], parseLiteral);
  const names = [...Object.keys(props), ...Object.keys(assets ?? {}), ...Object.keys(literals ?? {})];
  if (new Set(names).size !== names.length) {
    throw new Error('A default prop is set once: in props, assets or literals');
  }
  return heldDefaults({ ...(assets === undefined ? {} : { assets }), ...(literals === undefined ? {} : { literals }) });
}

/** The `assets` and `literals` of a node that has any; empty keys are left out. */
export function heldDefaults(value: HeldDefaults): HeldDefaults {
  const { assets, literals } = value;
  return {
    ...(assets === undefined || Object.keys(assets).length === 0 ? {} : { assets }),
    ...(literals === undefined || Object.keys(literals).length === 0 ? {} : { literals }),
  };
}

type Values = HeldDefaults & { readonly props?: Readonly<Record<string, DefaultValue>> };

/** `base` with `override` over it, prop by prop: a prop the override sets leaves whichever place the base held it in. */
export function mergeDefaultValues(base: Values, override: Values): Values & { readonly props: Readonly<Record<string, DefaultValue>> } {
  const taken = new Set([...Object.keys(override.props ?? {}), ...Object.keys(override.assets ?? {}), ...Object.keys(override.literals ?? {})]);
  const kept = <T>(held: Readonly<Record<string, T>> | undefined, own: Readonly<Record<string, T>> | undefined): Readonly<Record<string, T>> => ({
    ...Object.fromEntries(Object.entries(held ?? {}).filter(([name]) => !taken.has(name))),
    ...own,
  });
  return {
    props: kept(base.props, override.props),
    ...heldDefaults({ assets: kept(base.assets, override.assets), literals: kept(base.literals, override.literals) }),
  };
}

/** A node's defaults as attributes, as picking each by hand would write them. `binding` names an asset's import. */
export function defaultAttributes(
  node: Values,
  binding: (file: string) => string,
): readonly (readonly [string, { readonly type: 'string' | 'expr'; readonly value: string }])[] {
  const assets = Object.entries(node.assets ?? {}).map(([name, asset]) => {
    const local = binding(asset.file);
    return [name, { type: 'expr' as const, value: asset.url === true ? `${local}.src` : local }] as const;
  });
  const props = Object.entries(node.props ?? {}).map(
    ([name, value]) => [name, { type: typeof value === 'string' ? ('string' as const) : ('expr' as const), value: String(value) }] as const,
  );
  const literals = Object.entries(node.literals ?? {}).map(([name, value]) => [name, { type: 'expr' as const, value: literalText(value, binding) }] as const);
  return [...assets, ...props, ...literals];
}

const literalImports = (literal: LiteralDefault): Readonly<Record<string, string>> => (typeof literal === 'string' ? {} : literal.imports);

// The literal as a page writes it: each imported name replaced by the one `binding` gives its file there.
function literalText(literal: LiteralDefault, binding: (file: string) => string): string {
  if (typeof literal === 'string') {
    return literal;
  }
  const references = literalReferences(literal.source, new Set(Object.keys(literal.imports)));
  assert(references !== undefined, 'literalText: a parsed literal reads as one');
  let written = literal.source;
  // From the end, so each earlier offset still holds.
  for (const reference of [...references].reverse()) {
    const file = literal.imports[reference.name];
    assert(file !== undefined, 'literalText: every reference has its import');
    written = written.slice(0, reference.start) + binding(file) + written.slice(reference.start + reference.name.length);
  }
  return written;
}

// A word JavaScript keeps for itself cannot name an import.
const RESERVED = new Set(
  (
    'arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if ' +
    'implements import in instanceof interface let new null package private protected public return static super switch this throw true try ' +
    'typeof var void while with yield'
  ).split(' '),
);

/** The name a new import of `file` takes, as picking the file by hand names it: its own name, made an identifier and free. */
export function assetBindingName(file: string, taken: ReadonlySet<string>): string {
  const base =
    file
      .split('/')
      .pop()
      ?.replace(/\.[^.]+$/, '') ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9_$]/g, '_').replace(/^(\d)/, '_$1') || 'asset';
  const first = RESERVED.has(cleaned) ? `_${cleaned}` : cleaned;
  let candidate = first;
  // Ends within taken.size + 1 passes: each tries a name not yet tried.
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    assert(suffix <= taken.size + 2, 'assetBindingName: a free name is found');
    candidate = `${first}${suffix}`;
  }
  return candidate;
}

// ─── Tags an element recipe cannot name ───

// A child that is not an HTML element or a project component: Astro's own `<Fragment>` and `<>`, a built-in the page
// imports from Astro, or an SVG element spelled with capitals. It is stored as an element child, `{ "element": "div",
// "tag": "Fragment" }`, so a Stacki that does not know `tag` still reads the file and inserts a div in its place; a new
// kind of child would make it refuse the whole file.
export const BUILTIN_MODULES = {
  'astro:components': ['Code', 'Debug'],
  'astro:assets': ['Image', 'Picture', 'Font'],
} as const satisfies Record<string, readonly string[]>;
export type BuiltinModule = keyof typeof BUILTIN_MODULES;
export interface WrittenTag {
  readonly tag?: string;
  /** The module a built-in is imported from, by name. */
  readonly from?: BuiltinModule;
}
const SVG_TAG = /^[a-z][a-z0-9-]{0,60}[A-Z][A-Za-z0-9-]{0,60}$/;

export function builtinModuleOf(path: string, name: string): BuiltinModule | undefined {
  const modules: readonly BuiltinModule[] = ['astro:components', 'astro:assets'];
  return modules.find((module) => module === path && (BUILTIN_MODULES[module] as readonly string[]).includes(name));
}

export const isFragmentTag = (tag: string | undefined): boolean => tag === 'Fragment' || tag === '<>';
export const isSVGTag = (tag: string): boolean => SVG_TAG.test(tag);

/** An element child's `tag` and `from`, parsed. */
export function parseWrittenTag(value: Readonly<Record<string, unknown>>): WrittenTag {
  const { tag, from } = value;
  if (tag === undefined) {
    if (from !== undefined) {
      throw new Error('A default child with from names the tag it imports');
    }
    return {};
  }
  const name = text(tag);
  if (from === undefined) {
    if (!isFragmentTag(name) && !isSVGTag(name)) {
      throw new Error('A default child tag is Fragment, <>, an SVG element or a built-in with its module');
    }
    return { tag: name };
  }
  const module = builtinModuleOf(text(from), name);
  if (module === undefined) {
    throw new Error('A default child from a module is one of Astro’s built-ins');
  }
  return { tag: name, from: module };
}

/** The `tag` and `from` of a node that has them. */
export function writtenTag(node: WrittenTag): WrittenTag {
  return { ...(node.tag === undefined ? {} : { tag: node.tag }), ...(node.from === undefined ? {} : { from: node.from }) };
}

/** One tag as source. `<>` takes no attributes, so one given any is written as `<Fragment>`. */
export function elementMarkup(name: string, props: string, children: string | undefined): string {
  const tag = name === '<>' && props !== '' ? 'Fragment' : name;
  if (tag === '<>') {
    return `<>${children ?? ''}</>`;
  }
  return children === undefined ? `<${tag}${props} />` : `<${tag}${props}>${children}</${tag}>`;
}

// ─── Markup kept as written ───

// A comment, or a `{…}` that holds nothing the page computes (`{" "}`, `{}`): nothing it renders can differ, so it is kept
// as written among a recipe's children, as `{ "literal": "", "verbatim": "<!-- Links -->" }`. A Stacki that does not know
// `verbatim` reads an empty text there.

/** Whether `markup` is a comment, or braces holding at most one string or number among comments. */
export function isStaticMarkup(markup: string): boolean {
  if (markup.startsWith('<!--')) {
    return markup.length >= 7 && markup.indexOf('-->', 4) === markup.length - 3;
  }
  if (!markup.startsWith('{') || !markup.endsWith('}')) {
    return false;
  }
  const tokens = literalTokens(markup.slice(1, -1));
  const [only, ...more] = tokens ?? [];
  return tokens !== undefined && more.length === 0 && (only === undefined || /^["'`]|^-?\.?\d/.test(only.text));
}

// ─── Literal data ───

// Strings, templates with nothing to fill in, numbers, names, punctuation and comments. A `//` comment counts only
// with its line break, since one that ends the value would swallow the brace after it. Nothing else is a token, so a
// call, an operator or an arrow ends the reading.
const LITERAL_TOKEN =
  /\s+|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?=\r?\n)|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|`(?:\\[\s\S]|\$(?!\{)|[^`\\$])*`|-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|[[\]{}:,.]/giy;
const LITERAL_WORDS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined']);

interface LiteralToken {
  readonly text: string;
  readonly start: number;
}
export interface LiteralReference {
  readonly name: string;
  readonly start: number;
}
interface LiteralReading {
  readonly tokens: readonly LiteralToken[];
  readonly imports: ReadonlySet<string>;
  readonly references: LiteralReference[];
}

function literalTokens(source: string): readonly LiteralToken[] | undefined {
  if (source.length > DEFAULT_VALUE_LIMITS.literalCharsMax) {
    return undefined;
  }
  const tokens: LiteralToken[] = [];
  let at = 0;
  // Every token is at least one character, so this ends within the source's length.
  while (at < source.length) {
    LITERAL_TOKEN.lastIndex = at;
    const found = LITERAL_TOKEN.exec(source)?.[0];
    if (found === undefined || tokens.length > DEFAULT_VALUE_LIMITS.literalTokensMax) {
      return undefined;
    }
    if (!/^(?:\s|\/\*|\/\/)/.test(found)) {
      tokens.push({ text: found, start: at });
    }
    at += found.length;
  }
  return tokens;
}

/**
 * The places `source` names one of `imports`, when it is only data otherwise: strings, numbers, true, false, null,
 * undefined, those names (and their `.src`), and lists and objects of them. Undefined when it is anything else.
 */
export function literalReferences(source: string, imports: ReadonlySet<string>): readonly LiteralReference[] | undefined {
  const tokens = literalTokens(source);
  if (tokens === undefined) {
    return undefined;
  }
  const reading: LiteralReading = { tokens, imports, references: [] };
  return literalEnd(reading, 0, 0) === tokens.length ? reading.references : undefined;
}

/** Whether `source` is only data, naming nothing. */
export function isLiteralSource(source: string): boolean {
  return literalReferences(source, new Set()) !== undefined;
}

// The index past the value starting at `at`, or undefined when none does. Depth bounds the recursion.
function literalEnd(reading: LiteralReading, at: number, depth: number): number | undefined {
  const token = reading.tokens[at];
  if (token === undefined || depth > DEFAULT_VALUE_LIMITS.literalDepthMax) {
    return undefined;
  }
  if (token.text === '[' || token.text === '{') {
    return collectionEnd(reading, at, depth);
  }
  if (/^["'`]|^-?\.?\d/.test(token.text) || LITERAL_WORDS.has(token.text)) {
    return at + 1;
  }
  if (!reading.imports.has(token.text)) {
    return undefined;
  }
  reading.references.push({ name: token.text, start: token.start });
  return reading.tokens[at + 1]?.text === '.' && reading.tokens[at + 2]?.text === 'src' ? at + 3 : at + 1;
}

function collectionEnd(reading: LiteralReading, at: number, depth: number): number | undefined {
  const { tokens } = reading;
  const close = tokens[at]?.text === '[' ? ']' : '}';
  let next = at + 1;
  // Each pass consumes at least one token.
  while (next < tokens.length && tokens[next]?.text !== close) {
    if (close === '}') {
      const key = tokens[next]?.text ?? '';
      if (!/^["']|^[A-Za-z_$\d]/.test(key) || tokens[next + 1]?.text !== ':') {
        return undefined;
      }
      next += 2;
    }
    const end = literalEnd(reading, next, depth + 1);
    if (end === undefined) {
      return undefined;
    }
    const after = tokens[end]?.text;
    if (after !== ',' && after !== close) {
      return undefined;
    }
    next = after === ',' ? end + 1 : end;
  }
  return tokens[next]?.text === close ? next + 1 : undefined;
}

// ─── Every asset a configuration or an instance names ───

export interface AssetDefaultUse {
  /** The recipe's owner: the component whose defaults name the file, itself or through a child. */
  readonly owner: string;
  readonly prop: string;
  readonly file: string;
}

export function defaultAssetUses(config: ComponentDefaults): readonly AssetDefaultUse[] {
  const uses: AssetDefaultUse[] = [];
  let visited = 0;
  const walk = (owner: string, recipe: ComponentRecipe, depth: number): void => {
    visited += 1;
    assert(depth <= DEFAULT_VALUE_LIMITS.walkDepthMax, 'Recipes are walked to their stored depth');
    assert(visited <= DEFAULT_VALUE_LIMITS.walkNodesMax, 'Recipes are walked to their stored node count');
    for (const [prop, asset] of Object.entries(recipe.assets ?? {})) {
      uses.push({ owner, prop, file: asset.file });
    }
    for (const [prop, literal] of Object.entries(recipe.literals ?? {})) {
      uses.push(...Object.values(literalImports(literal)).map((file) => ({ owner, prop, file })));
    }
    for (const child of recipe.children ?? []) {
      if (!('literal' in child)) {
        walk(owner, child, depth + 1);
      }
    }
  };
  for (const [owner, recipe] of Object.entries(config.components)) {
    walk(owner, recipe, 0);
  }
  return uses;
}

/**
 * The configuration after a file or a folder moved from `from` to `to`. A default whose file would no longer be one a
 * page can import (moved to public/, or renamed to something that is not media) keeps its old path, which check-project
 * then names as missing. Returns `config` itself when nothing named it.
 */
export function relinkDefaultAssets(config: ComponentDefaults, from: string, to: string): ComponentDefaults {
  assert(from.length > 0, 'A move names what moved');
  assert(to.length > 0, 'A move names where it went');
  let changed = false;
  const moved = (file: string): string => {
    const next = file === from ? to : file.startsWith(`${from}/`) ? `${to}${file.slice(from.length)}` : file;
    if (next === file || !isAssetDefaultFile(next)) {
      return file;
    }
    changed = true;
    return next;
  };
  const relinkLiteral = (literal: LiteralDefault): LiteralDefault =>
    typeof literal === 'string'
      ? literal
      : { source: literal.source, imports: Object.fromEntries(Object.entries(literal.imports).map(([name, file]) => [name, moved(file)])) };
  const relink = <T extends ComponentRecipe>(recipe: T, depth: number): T => {
    assert(depth <= DEFAULT_VALUE_LIMITS.walkDepthMax, 'Relink depth is bounded by the recipe parser');
    const { assets, literals } = recipe;
    const children = recipe.children?.map((child): RecipeChild => ('literal' in child ? child : relink(child, depth + 1)));
    return {
      ...recipe,
      ...(assets === undefined
        ? {}
        : { assets: Object.fromEntries(Object.entries(assets).map(([prop, asset]) => [prop, { ...asset, file: moved(asset.file) }])) }),
      ...(literals === undefined ? {} : { literals: Object.fromEntries(Object.entries(literals).map(([prop, literal]) => [prop, relinkLiteral(literal)])) }),
      ...(children === undefined ? {} : { children }),
    };
  };
  const components = Object.fromEntries(Object.entries(config.components).map(([owner, recipe]) => [owner, relink(recipe, 0)]));
  return changed ? { version: 1, components } : config;
}

/** A resolved instance without the values whose file `exists` does not know, and those files: no import of a missing file. */
export function withoutMissingAssets<T extends ResolvedNode>(
  root: T,
  exists: (file: string) => boolean,
): { readonly node: T; readonly missing: readonly string[] } {
  const missing = new Set<string>();
  const there = (file: string): boolean => {
    const found = exists(file);
    if (!found) {
      missing.add(file);
    }
    return found;
  };
  const prune = <N extends ResolvedNode>(node: N, depth: number): N => {
    assert(depth <= DEFAULT_VALUE_LIMITS.walkDepthMax, 'A resolved instance has bounded depth');
    if ('literal' in node) {
      return node;
    }
    const assets = Object.entries(node.assets ?? {}).filter(([, asset]) => there(asset.file));
    // A list naming a missing file goes whole: there is no item to drop without guessing what the list means.
    const literals = Object.entries(node.literals ?? {}).filter(([, literal]) => Object.values(literalImports(literal)).map(there).every(Boolean));
    const content =
      node.content.kind === 'children' ? { kind: 'children' as const, children: node.content.children.map((child) => prune(child, depth + 1)) } : node.content;
    return {
      ...node,
      content,
      ...(node.assets === undefined ? {} : { assets: Object.fromEntries(assets) }),
      ...(node.literals === undefined ? {} : { literals: Object.fromEntries(literals) }),
    };
  };
  const node = prune(root, 0);
  return { node, missing: [...missing] };
}
