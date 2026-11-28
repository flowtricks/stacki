// What counts as changing a picture, for the editor content check (editorContent.ts):
// an image's own source and alt attributes, a component prop that holds a picture
// (by its value, whatever the component calls it) and its alt text, and the
// imports of picture files. Free of Node imports: the browser runs it too.
import type { ImportDecl } from '../../../vendor/stacki/shared/page/pageNode';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { frontmatterRange } from '../source/frontmatter';
import type { ParserNode } from '../source/source';

const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif|gif|svg|ico|bmp|tiff?)$/i;
const IMPORTS_MAX = 500;

/** The names a page's imports bind to picture files. */
export type ImageBindings = ReadonlySet<string>;

export function imageBindings(imports: readonly Pick<ImportDecl, 'name' | 'path'>[]): ImageBindings {
  return new Set(imports.filter((entry) => IMAGE_FILE.test(entry.path)).map((entry) => entry.name));
}

// Attributes that are never a picture, whatever their value looks like: they style,
// script, link or place an element.
const NEVER_IMAGE =
  /^(?:class|class:list|style|id|slot|href|action|formaction|srcdoc|sandbox|role|tabindex)$|^(?:on|set:|is:|client:|server:|data-|aria-|transition:|define:)/i;

// The attributes a picture is written in, by the tag that draws it. Lower-case tags
// are HTML; Image and Picture are Astro's own components.
const ELEMENT_IMAGE_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  img: ['src', 'srcset', 'alt'],
  source: ['src', 'srcset'],
  video: ['poster'],
  Image: ['src', 'alt'],
  Picture: ['src', 'alt'],
};

type Value = NonNullable<ParserNode['props']>[string];

/** A file path or a web address that names a picture, or `''`. */
function imagePath(value: string): boolean {
  const bare = value.split(/[?#]/)[0] ?? '';
  return safeAddress(value) && IMAGE_FILE.test(bare);
}

// A relative or root path, or http(s): never `javascript:`, `data:` or a protocol of its own.
function safeAddress(value: string): boolean {
  if (/[\u0000-\u001f<>"{}`]/.test(value)) {
    return false;
  }
  const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase();
  return scheme === undefined || scheme === 'http' || scheme === 'https';
}

// An imported picture (`hero`, `hero.src`), or a path to one.
function imageReference(value: Value | undefined, bindings: ImageBindings): boolean {
  if (value === undefined || value.type === 'bare' || value.type === 'spread') {
    return false;
  }
  if (value.type === 'string') {
    return imagePath(value.value);
  }
  const name = /^\s*([A-Za-z_$][\w$]*)(?:\.src)?\s*$/.exec(value.value)?.[1];
  return name !== undefined && bindings.has(name);
}

// What an `<img>` may hold: an imported picture, or any web or project address (a media host's need no extension).
function elementImageValue(name: string, value: Value | undefined, bindings: ImageBindings): boolean {
  if (value === undefined) {
    return true;
  }
  if (value.type === 'string') {
    return name === 'alt' || safeAddress(value.value);
  }
  return imageReference(value, bindings);
}

// `{ src: hero, alt: "A boat" }` with its pictures and alt text blanked, or undefined when it holds neither.
function blankedObject(value: Value | undefined, bindings: ImageBindings): string | undefined {
  if (value?.type !== 'expr' || !/^\s*\{[\s\S]*\}\s*$/.test(value.value)) {
    return undefined;
  }
  let found = false;
  const sources = value.value.replace(/\b(src\s*:\s*)([A-Za-z_$][\w$]*(?:\.src)?|"[^"\\\n]*"|'[^'\\\n]*')/g, (whole, key: string, written: string) => {
    const quoted = /^["']/.test(written);
    const holds = quoted ? imagePath(written.slice(1, -1)) : bindings.has(written.replace(/\.src$/, ''));
    found ||= holds;
    return holds ? `${key}\u0001` : whole;
  });
  const blanked = sources.replace(/\b(alt\s*:\s*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g, '$1\u0002');
  return found ? blanked : undefined;
}

function altName(name: string): boolean {
  return /^alt(?:Text)?$/i.test(name) || /[a-z]Alt(?:Text)?$/.test(name);
}

function holdsPicture(node: ParserNode, bindings: ImageBindings): boolean {
  return Object.values(node.props ?? {}).some((value) => imageReference(value, bindings) || blankedObject(value, bindings) !== undefined);
}

export interface AttributeChange {
  readonly name: string;
  readonly before: ParserNode;
  readonly after: ParserNode;
  readonly bindings: { readonly before: ImageBindings; readonly after: ImageBindings };
}

/** Whether changing attribute `name` of this node only changes a picture or its alt text. */
export function imageAttributeChange(change: AttributeChange): boolean {
  const { name, before, after, bindings } = change;
  assert(name.length > 0, 'An attribute has a name');
  if (NEVER_IMAGE.test(name)) {
    return false;
  }
  const was = before.props?.[name];
  const now = after.props?.[name];
  const tag = before.name ?? '';
  if (Object.hasOwn(ELEMENT_IMAGE_ATTRIBUTES, tag) && ELEMENT_IMAGE_ATTRIBUTES[tag]?.includes(name)) {
    return elementImageValue(name, now, bindings.after);
  }
  if (before.kind !== 'component') {
    return false;
  }
  if (altName(name)) {
    const strings = [was, now].every((value) => value === undefined || value.type === 'string');
    return strings && (holdsPicture(before, bindings.before) || holdsPicture(after, bindings.after));
  }
  const left = blankedObject(was, bindings.before);
  if (left !== undefined) {
    return left === blankedObject(now, bindings.after);
  }
  const wasPicture = imageReference(was, bindings.before);
  const nowPicture = imageReference(now, bindings.after);
  // A picture may replace a picture or fill an empty prop, and clearing one is a change of picture too.
  if (wasPicture) {
    return nowPicture || now === undefined || (now.type === 'string' && /^https?:\/\//i.test(now.value) && safeAddress(now.value));
  }
  return nowPicture && was === undefined;
}

/** Whether `name` on this node holds a picture or an image's alt text as it is written now. */
export function isImageAttribute(node: ParserNode, name: string, bindings: ImageBindings): boolean {
  const tag = node.name ?? '';
  if (Object.hasOwn(ELEMENT_IMAGE_ATTRIBUTES, tag) && ELEMENT_IMAGE_ATTRIBUTES[tag]?.includes(name)) {
    return true;
  }
  if (NEVER_IMAGE.test(name)) {
    return false;
  }
  const value = node.props?.[name];
  if (altName(name)) {
    return holdsPicture(node, bindings);
  }
  return imageReference(value, bindings) || blankedObject(value, bindings) !== undefined;
}

export interface AttributeText {
  /** The attribute as written, to compare the two versions. */
  readonly text: string;
  /** The attribute and the space before it, so adding or removing one leaves the tag as it was. */
  readonly range: { readonly start: number; readonly end: number };
}

/** A node's attributes by name, or undefined when one is written twice or has no source range. */
export function attributeSpans(source: string, node: ParserNode): ReadonlyMap<string, AttributeText> | undefined {
  const found = new Map<string, AttributeText>();
  for (const attribute of node.attrSpans ?? []) {
    if (!('name' in attribute) || found.has(attribute.name)) {
      return undefined;
    }
    let start: number = attribute.span.start;
    while (start > 0 && /\s/.test(source[start - 1] ?? '')) {
      start -= 1;
    }
    found.set(attribute.name, { text: source.slice(attribute.span.start, attribute.span.end), range: { start, end: attribute.span.end } });
  }
  // A spread has no name to compare by: it stays in the source, which must then match.
  const named = Object.entries(node.props ?? {}).filter(([, value]) => value.type !== 'spread');
  return named.every(([name]) => found.has(name)) ? found : undefined;
}

export interface ImportLine {
  readonly statement: string;
  readonly start: number;
  readonly end: number;
}

/** The frontmatter lines that each import one picture file by a default name, and nothing else. */
export function imageImportLines(source: string): readonly ImportLine[] {
  const range = frontmatterRange(source);
  if (range === undefined) {
    return [];
  }
  const fence = source.slice(range.start, range.end);
  const pattern = /^import[ \t]+[A-Za-z_$][\w$]*[ \t]+from[ \t]+(["'])([^"'\\\n?#*]+)\1;?[ \t]*(?:\r?\n|$)/gm;
  const lines: ImportLine[] = [];
  for (const match of fence.matchAll(pattern)) {
    if (lines.length < IMPORTS_MAX && IMAGE_FILE.test(match[2] ?? '')) {
      const start = range.start + match.index;
      lines.push({ statement: match[0].trim(), start, end: start + match[0].length });
    }
  }
  return lines;
}

/** The frontmatter's quoted strings, import paths aside: words the page may print. */
export function literalStrings(source: string): readonly string[] {
  const range = frontmatterRange(source);
  if (range === undefined) {
    return [];
  }
  const code = range.value.replace(/^\s*import\b[^;\n]*?(["'])[^"'\n]*\1;?[ \t]*$/gm, '');
  return code.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
}
