// A style section as it reads now, from the current sources. The result replaces
// the section's `<style>` text on the baked page, so it is whole: imports inlined,
// `<style>` blocks scoped, and authored `url()`s swapped for the build's own.
import type { BakeSection } from '../src/features/bake/bakeSnapshot';
import { scopeStyles } from './scopeStyles';

const IMPORT_DEPTH_MAX = 16;
const IMPORT = /@import\s+(?:url\()?["']([^"']+)["']\)?\s*(?:layer\(([^)]+)\))?\s*;/g;

type Sources = Readonly<Record<string, string>>;

function resolveFile(from: string, target: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.') {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function inlineImports(file: string, css: string, sources: Sources, depth: number): string {
  if (depth > IMPORT_DEPTH_MAX) {
    throw new Error('Stylesheet imports nest too deeply');
  }
  return css.replace(IMPORT, (statement: string, target: string, layer: string | undefined) => {
    const resolved = resolveFile(file, target);
    const imported = sources[resolved];
    if (imported === undefined) {
      return statement; // Not a project file: the browser resolves it, as it always did.
    }
    const text = inlineImports(resolved, imported, sources, depth + 1);
    return layer === undefined ? text : `@layer ${layer} {\n${text}\n}`;
  });
}

/** The compiled `<style>` blocks of a file. Astro compiles them last to first, so
 * section `#0` is the last one written, and `is:inline` blocks never reach the build. */
export function styleBlock(source: string, index: number): string | undefined {
  const blocks = [...source.matchAll(/<style\b([^>]*)>([\s\S]*?)<\/style>/g)].filter((match) => !(match[1] ?? '').includes('is:inline'));
  return blocks[blocks.length - 1 - index]?.[2];
}

function replaceURLs(css: string, urls: BakeSection['urls']): string {
  let result = css;
  for (const [authored, built] of Object.entries(urls)) {
    result = result.replaceAll(authored, built);
  }
  return result;
}

/** The section's current CSS, or undefined when the block no longer exists. */
export function renderSection(section: BakeSection, sources: Sources): string | undefined {
  const source = sources[section.file];
  if (source === undefined) {
    return undefined;
  }
  const hash = section.id.indexOf('#');
  const authored = hash < 0 ? inlineImports(section.file, source, sources, 0) : styleBlock(source, Number(section.id.slice(hash + 1)));
  if (authored === undefined) {
    return undefined;
  }
  return replaceURLs(section.scope === undefined ? authored : scopeStyles(authored, section.scope), section.urls);
}
