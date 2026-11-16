// Reuse the scan's source reads so titles require no additional disk access.
import { parsePage } from '../parse/astroParser';
import { layoutPageTitle } from '../../shared/page/pageTitle';
import type { ScanPage } from '../../shared/properties/projectScan';
import { assert } from '../../shared/core/assert';
import { PLATFORM_LIMITS } from '../../shared/core/limits';
import { runSync, type SlicedWork } from '../lib/slicedWork';
import { resolveSpec, type Alias } from '../content/cmsRefs';
import path from 'node:path';

export type PageTitleSource = { readonly specifier: string | undefined } & (
  { readonly kind: 'inherit' } | { readonly kind: 'override'; readonly title: string | undefined }
);

export function scanPageTitles(
  pages: readonly ScanPage[],
  sources: readonly { readonly file: string; readonly text: string }[],
  aliases: readonly Alias[] = [],
): readonly ScanPage[] {
  return runSync(pageTitlesSliced(pages, sources, aliases));
}

/**
 * The same scan, written once for both drivers (lib/slicedWork.ts). Parsing a
 * page is the cost, so each page is read once up front with a yield after it:
 * a project of thousands of pages is a longer run, never a stall. The wrapper
 * chains resolved afterwards hit the cache for every page already read.
 */
export function* pageTitlesSliced(
  pages: readonly ScanPage[],
  sources: readonly { readonly file: string; readonly text: string }[],
  aliases: readonly Alias[] = [],
): SlicedWork<readonly ScanPage[]> {
  // Import resolution produces native absolute paths. Normalize both sides so
  // Windows separators and equivalent source spellings use the same cache key.
  const sourceByPath = new Map(sources.map(({ file, text }) => [path.resolve(file), text]));
  // Keep only small title summaries, not every parsed page tree, during a scan.
  const cache = new Map<string, PageTitleSource | undefined>();
  const read = (file: string): PageTitleSource | undefined => {
    const key = path.resolve(file);
    if (!cache.has(key)) {
      const text = sourceByPath.get(key);
      cache.set(key, text === undefined ? undefined : scanPageTitleSource(text));
    }
    return cache.get(key);
  };
  for (const page of pages) {
    if (page.path.toLowerCase().endsWith('.astro')) {
      read(page.path);
      yield;
    }
  }
  assert(sourceByPath.size <= sources.length, 'Page titles: sources are indexed once each');
  return resolvePageTitles(pages, aliases, read);
}

export function resolvePageTitles(
  pages: readonly ScanPage[],
  aliases: readonly Alias[],
  read: (file: string) => PageTitleSource | undefined,
): readonly ScanPage[] {
  const wrapperOf = (file: string, source: PageTitleSource): string | undefined => {
    const candidates = source.specifier === undefined ? [] : resolveSpec(source.specifier, file, aliases);
    return candidates.find((candidate) => read(candidate) !== undefined);
  };
  return pages.map((page) => {
    if (!page.path.toLowerCase().endsWith('.astro')) {
      return page;
    }
    const source = read(page.path);
    if (source === undefined) {
      return page;
    }
    const inheritedTitle = scanInheritedTitle(wrapperOf(page.path, source), wrapperOf, read);
    const title = source.kind === 'override' ? source.title : inheritedTitle;
    return title === undefined && inheritedTitle === undefined ? page : { ...page, title, inheritedTitle };
  });
}

export function scanPageTitleSource(text: string): PageTitleSource | undefined {
  const parsed = parsePage(text);
  if (!parsed.editable) {
    return undefined;
  }
  const layout = parsed.model.nodes.find((node) => node.id === 'layout');
  if (layout?.kind !== 'component') {
    return undefined;
  }
  const imported = parsed.model.imports.find((entry) => entry.name === layout.name);
  return layout.props?.['title'] === undefined
    ? { kind: 'inherit', specifier: imported?.path }
    : { kind: 'override', title: layoutPageTitle(parsed.model.nodes), specifier: imported?.path };
}

function scanInheritedTitle(
  wrapper: string | undefined,
  wrapperOf: (file: string, source: PageTitleSource) => string | undefined,
  read: (file: string) => PageTitleSource | undefined,
): string | undefined {
  // Each step adds a file not yet visited, so a chain ends after the project's own file count: a
  // wrapper chain of any depth resolves, and a cycle stops where it closes.
  const visited = new Set<string>();
  let current = wrapper;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    assert(visited.size <= PLATFORM_LIMITS.arrayLengthMax, 'scanInheritedTitle: the chain stays inside an array');
    const source = read(current);
    if (source?.kind === 'override') {
      return source.title;
    }
    current = source === undefined ? undefined : wrapperOf(current, source);
  }
  return undefined;
}
