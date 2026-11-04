// What a page gives a component that an isolated preview does not.
//
// A palette preview renders one component on an empty route. On a real page the same
// component also inherits CSS that site-wide components carry in inline <style> blocks
// (a Webflow or Lumos "GlobalStyles" embed resets <button>, for example), classes and
// data attributes on <html> and <body>, and the props an author actually passes. Without
// them a button renders as the browser's grey default button with the wrong label.
//
// This module reads all three from the project's own source. It never evaluates source:
// it reads literal attribute values, literal style blocks and plain-HTML children only.
// It runs inside the project's dev server, so it imports only unpacked runtime modules
// (electron/parse and shared).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseAttrs } from '../parse/astroAttrs';
import { scanTag } from '../parse/astroTag';
import { assert } from '../../shared/core/assert';

export const PREVIEW_CONTEXT_LIMITS = {
  astroFilesMax: 4000,
  directoriesMax: 1024,
  propsMax: 256,
  slotCharsMax: 4096,
  sourceBytesMax: 32 * 1024 * 1024,
  stylesCharsMax: 2 * 1024 * 1024,
  globalFilesMax: 64,
  importsPerFileMax: 512,
} as const satisfies Record<string, number>;

export type PreviewSampleValue = string | boolean | number;

export type PreviewSlot = { readonly kind: 'name' } | { readonly kind: 'none' } | { readonly kind: 'html'; readonly html: string };

export interface PreviewSample {
  readonly props: Readonly<Record<string, PreviewSampleValue>>;
  readonly slot: PreviewSlot;
}

export interface PreviewDocumentAttributes {
  readonly html: Readonly<Record<string, string>>;
  readonly body: Readonly<Record<string, string>>;
}

export interface PreviewProjectFile {
  /** Project-relative POSIX path, such as `src/pages/index.astro`. */
  readonly relative: string;
  readonly source: string;
  readonly imports: ReadonlyArray<PreviewImport>;
}

export interface PreviewImport {
  readonly name: string;
  readonly relative: string;
}

export interface PreviewProjectIndex {
  readonly pages: ReadonlyArray<PreviewProjectFile>;
  readonly others: ReadonlyArray<PreviewProjectFile>;
}

export interface PreviewContextModule {
  readonly code: string;
  readonly watchFiles: readonly string[];
}

export interface PreviewSampleFound {
  readonly sample: PreviewSample;
  readonly host: string;
}

/** Reads every .astro file under src once, with the imports each one declares. */
export function readPreviewProjectIndex(projectDirectory: string): PreviewProjectIndex {
  const root = path.resolve(projectDirectory);
  const files = astroFilesUnder(path.join(root, 'src'));
  const pages: PreviewProjectFile[] = [];
  const others: PreviewProjectFile[] = [];
  let sourceBytes = 0;
  for (const file of files) {
    sourceBytes += fs.statSync(file).size;
    assert(sourceBytes <= PREVIEW_CONTEXT_LIMITS.sourceBytesMax, 'Preview context sources exceed limit');
    const relative = path.relative(root, file).split(path.sep).join('/');
    const source = fs.readFileSync(file, 'utf8');
    const entry = { relative, source, imports: previewImports(source, relative) };
    if (relative.startsWith('src/pages/')) {
      pages.push(entry);
    } else {
      others.push(entry);
    }
  }
  assert(pages.length + others.length === files.length, 'Every project file is indexed once');
  // The homepage is the page a visitor sees first, so its instances are the best samples.
  const homepage = pages.filter((page) => page.relative === 'src/pages/index.astro');
  return { pages: [...homepage, ...pages.filter((page) => page.relative !== 'src/pages/index.astro')], others };
}

/** The `export` module the preview route imports for its page context. */
export function componentPreviewContextModule(projectDirectory: string, index: PreviewProjectIndex): PreviewContextModule {
  const globals = componentPreviewGlobalFiles(index.pages.map((page) => page.imports.map((entry) => entry.relative)));
  const sources = new Map([...index.pages, ...index.others].map((file) => [file.relative, file.source]));
  const styles: string[] = [];
  let html: Record<string, string> = {};
  let body: Record<string, string> = {};
  let stylesChars = 0;
  for (const relative of globals) {
    const source = sources.get(relative);
    if (source === undefined) {
      // A page imports a file outside src (a package) or one that no longer exists.
      continue;
    }
    for (const css of componentPreviewInlineStyles(source)) {
      stylesChars += css.length;
      assert(stylesChars <= PREVIEW_CONTEXT_LIMITS.stylesCharsMax, 'Preview context styles exceed limit');
      styles.push(css);
    }
    const attributes = componentPreviewDocumentAttributes(source);
    // The first layout that names a document attribute wins, as the outermost one does on a page.
    html = { ...attributes.html, ...html };
    body = { ...attributes.body, ...body };
  }
  const watchFiles = globals.filter((relative) => sources.has(relative)).map((relative) => path.join(path.resolve(projectDirectory), relative));
  assert(watchFiles.length <= PREVIEW_CONTEXT_LIMITS.globalFilesMax, 'Preview context dependencies are bounded');
  const code =
    `export const contextStyles = ${JSON.stringify(styles)};\n` +
    `export const htmlAttributes = ${JSON.stringify(html)};\n` +
    `export const bodyAttributes = ${JSON.stringify(body)};\n`;
  return { code, watchFiles };
}

/**
 * The files the pages share: those imported by a majority of the pages, in the order
 * the pages import them. A layout, a global style embed, a navbar and a footer qualify;
 * a section used on one page does not.
 */
export function componentPreviewGlobalFiles(pages: ReadonlyArray<ReadonlyArray<string>>): readonly string[] {
  assert(pages.length <= PREVIEW_CONTEXT_LIMITS.astroFilesMax, 'Preview context page count exceeds limit');
  if (pages.length === 0) {
    return [];
  }
  const counts = new Map<string, number>();
  for (const imports of pages) {
    assert(imports.length <= PREVIEW_CONTEXT_LIMITS.importsPerFileMax, 'Preview context imports per page exceed limit');
    for (const relative of new Set(imports)) {
      counts.set(relative, (counts.get(relative) ?? 0) + 1);
    }
  }
  const globals = [...counts].filter(([, count]) => count * 2 > pages.length).map(([relative]) => relative);
  assert(globals.length <= counts.size, 'Global files are a subset of imported files');
  return globals.slice(0, PREVIEW_CONTEXT_LIMITS.globalFilesMax);
}

/**
 * The literal CSS of a template's `<style is:inline>` and `<style is:global>` blocks.
 * Scoped styles only reach the component's own elements, and preprocessed languages
 * would need the compiler, so neither is copied.
 */
export function componentPreviewInlineStyles(source: string): readonly string[] {
  const template = templateOf(source);
  const styles: string[] = [];
  for (const match of template.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi)) {
    const attributes = match[1] ?? '';
    const css = (match[2] ?? '').trim();
    if (css.length === 0) {
      continue;
    }
    if (/\blang\s*=/.test(attributes)) {
      continue;
    }
    if (/\bis:(inline|global)\b/.test(attributes)) {
      styles.push(css);
    }
  }
  assert(styles.length <= template.length, 'Every copied style comes from the template');
  return styles;
}

/** Literal `class` and `data-*` attributes of a layout's <html> and <body> tags. */
export function componentPreviewDocumentAttributes(source: string): PreviewDocumentAttributes {
  const template = templateOf(source);
  return { html: documentTagAttributes(template, 'html'), body: documentTagAttributes(template, 'body') };
}

/**
 * The first instance of a component in the project, pages first, as preview inputs.
 * Pages show a component as visitors see it; other components are the fallback.
 */
export function componentPreviewSample(index: PreviewProjectIndex, component: string): PreviewSampleFound | undefined {
  assert(component.startsWith('src/'), 'Preview samples are found for project files');
  for (const file of [...index.pages, ...index.others]) {
    if (file.relative === component) {
      continue;
    }
    const entry = file.imports.find((candidate) => candidate.relative === component);
    if (entry === undefined) {
      continue;
    }
    const sample = componentPreviewInstance(file.source, entry.name);
    if (sample !== undefined) {
      return { sample, host: file.relative };
    }
  }
  return undefined;
}

/** Literal props and plain-HTML children of the first `<Name …>` in a template. */
export function componentPreviewInstance(source: string, name: string): PreviewSample | undefined {
  assert(/^[A-Za-z_$][\w$]*$/.test(name), 'A preview instance name is an identifier');
  const template = templateOf(source);
  const opening = new RegExp(`<${name}(?=[\\s/>])`, 'g');
  for (const match of template.matchAll(opening)) {
    const tag = scanTag(template, match.index);
    if (tag === undefined || tag.name !== name) {
      continue;
    }
    assert(tag.end > match.index, 'A scanned instance tag advances');
    const props = literalProps(tag.attrs);
    if (tag.selfClose === '/') {
      return { props, slot: { kind: 'none' } };
    }
    const close = template.indexOf(`</${name}>`, tag.end);
    if (close < 0) {
      return { props, slot: { kind: 'name' } };
    }
    return { props, slot: plainSlot(template.slice(tag.end, close), name) };
  }
  return undefined;
}

function plainSlot(children: string, name: string): PreviewSlot {
  const html = children.trim();
  if (html.length === 0) {
    return { kind: 'none' };
  }
  // Expressions, components, scripts and named slots need the host page's scope.
  // The component's own name stays a recognisable placeholder for them.
  if (html.length > PREVIEW_CONTEXT_LIMITS.slotCharsMax) {
    return { kind: 'name' };
  }
  if (/[{}]|<[A-Z]|<\/?(script|style)\b|\sslot\s*=/.test(html) || html.includes(`<${name}`)) {
    return { kind: 'name' };
  }
  return { kind: 'html', html };
}

function literalProps(attributes: string): Readonly<Record<string, PreviewSampleValue>> {
  const props: Record<string, PreviewSampleValue> = {};
  let count = 0;
  // The attribute scanner does not read template literals; blank them so their
  // interpolations cannot surface as bare attributes.
  const scannable = attributes.replace(/=\s*`[^`]*`/g, '={_}');
  for (const [key, attribute] of Object.entries(parseAttrs(scannable))) {
    // Directives and `slot` steer the compiler, not the component.
    if (key.includes(':') || key === 'slot') {
      continue;
    }
    const value =
      attribute.type === 'string' ? attribute.value : attribute.type === 'bare' ? true : attribute.type === 'expr' ? literal(attribute.value) : undefined;
    if (value !== undefined) {
      count += 1;
      assert(count <= PREVIEW_CONTEXT_LIMITS.propsMax, 'Preview sample props exceed limit');
      props[key] = value;
    }
  }
  return props;
}

function literal(expression: string): PreviewSampleValue | undefined {
  const text = expression.trim();
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    const number = Number(text);
    return Number.isFinite(number) ? number : undefined;
  }
  const quoted = /^(["'`])([^"'`\\$]*)\1$/.exec(text);
  return quoted?.[2];
}

function documentTagAttributes(template: string, tagName: 'html' | 'body'): Readonly<Record<string, string>> {
  const at = template.search(new RegExp(`<${tagName}(?=[\\s>])`, 'i'));
  if (at < 0) {
    return {};
  }
  const tag = scanTag(template, at);
  if (tag === undefined) {
    return {};
  }
  const attributes: Record<string, string> = {};
  for (const [key, attribute] of Object.entries(parseAttrs(tag.attrs))) {
    if (attribute.type !== 'string') {
      continue;
    }
    if (key === 'class' || /^data-[\w-]+$/.test(key)) {
      attributes[key] = attribute.value;
    }
  }
  return attributes;
}

const IMPORT_PATTERN = /^[ \t]*import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+\.astro)['"]/gm;

/** Default .astro imports that resolve to project files, by relative or `@/`/`~/` alias. */
export function previewImports(source: string, relative: string): ReadonlyArray<PreviewImport> {
  const frontmatter = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? '';
  const imports: PreviewImport[] = [];
  for (const match of frontmatter.matchAll(IMPORT_PATTERN)) {
    const name = match[1];
    const specifier = match[2];
    assert(name !== undefined, 'An import match has a name');
    assert(specifier !== undefined, 'An import match has a specifier');
    const target = resolvePreviewImport(relative, specifier);
    if (target !== undefined) {
      assert(imports.length < PREVIEW_CONTEXT_LIMITS.importsPerFileMax, 'Preview imports per file exceed limit');
      imports.push({ name, relative: target });
    }
  }
  return imports;
}

function resolvePreviewImport(from: string, specifier: string): string | undefined {
  let target: string;
  if (specifier.startsWith('.')) {
    target = path.posix.join(path.posix.dirname(from), specifier);
  } else if (/^[@~]\//.test(specifier)) {
    target = 'src/' + specifier.slice(2);
  } else if (specifier.startsWith('/src/')) {
    target = specifier.slice(1);
  } else {
    return undefined;
  }
  const normalized = path.posix.normalize(target);
  return normalized.startsWith('src/') ? normalized : undefined;
}

function templateOf(source: string): string {
  return source.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
}

function astroFilesUnder(root: string): readonly string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  // A breadth-first queue with a stated bound replaces recursion over an untrusted tree.
  const directories = [root];
  const files: string[] = [];
  for (let index = 0; index < directories.length; index++) {
    const directory = directories[index];
    assert(directory !== undefined, 'Queued preview directories exist');
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        assert(directories.length < PREVIEW_CONTEXT_LIMITS.directoriesMax, 'Preview context directories exceed limit');
        directories.push(file);
      } else if (entry.isFile() && entry.name.endsWith('.astro')) {
        assert(files.length < PREVIEW_CONTEXT_LIMITS.astroFilesMax, 'Preview context files exceed limit');
        files.push(file);
      }
    }
  }
  return files;
}
