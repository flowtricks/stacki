// A template page (`src/pages/docs/[...slug].astro`) has no single document: the build
// renders one per entry its getStaticPaths returns. The bake keeps each entry's document
// as a page of its own that shares the template's file (BakePage.entry), so the demo can
// open the template on any entry, and an edit to the template shows on all of them.
//
// Which documents a template produced is Astro's answer, not a guess from file names:
// `astro:routes:resolved` names each route's pattern and source file, and
// `astro:build:done` lists each pattern's output files in the order the build wrote them,
// which is getStaticPaths' order. That order is the picker's, as on Desktop.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { routeFor } from '../project/projectClient';
import { isTemplateRoute, matchTemplateRoute, templateEntryLabel } from '../pages/templateRoutes';
import { BAKE_LIMITS, type BakePage } from './bakeSnapshot';
import { parseEntryProps } from '../pages/entryPropsSample';

/** More documents than any route renders; a reply past it is refused. */
const TEMPLATE_DOCUMENTS_MAX = 10_000;
const TEMPLATES_MAX = 500;

/** One template's built documents, relative to the build's output folder, in build order. */
export interface TemplateOutput {
  readonly file: string;
  readonly documents: readonly string[];
}

/** The integration's half: what Astro resolved and wrote, gathered across two hooks. */
export class TemplateOutputs {
  private readonly patterns = new Map<string, string>();

  constructor(private readonly root: string) {
    assert(path.isAbsolute(root), 'The project root is absolute');
  }

  /** `astro:routes:resolved`: each page route with params, by pattern. */
  resolved(routes: readonly { readonly pattern: string; readonly entrypoint: string | URL; readonly type: string }[]): void {
    this.patterns.clear();
    for (const route of routes) {
      const file = this.projectFile(route.entrypoint);
      if (route.type === 'page' && file !== undefined && isTemplateRoute(route.pattern) && this.patterns.size < TEMPLATES_MAX) {
        this.patterns.set(route.pattern, file);
      }
    }
  }

  /** `astro:build:done`: each template's documents, in the order the build wrote them. */
  done(directory: URL, assets: ReadonlyMap<string, readonly URL[]>): readonly TemplateOutput[] {
    const out = fileURLToPath(directory);
    const outputs: TemplateOutput[] = [];
    for (const [pattern, file] of this.patterns) {
      const documents = (assets.get(pattern) ?? [])
        .slice(0, TEMPLATE_DOCUMENTS_MAX)
        .map((url) => path.relative(out, fileURLToPath(url)).split(path.sep).join('/'))
        .filter((document) => document.endsWith('.html') && !document.startsWith('..'));
      outputs.push({ file, documents });
    }
    return outputs;
  }

  private projectFile(entrypoint: string | URL): string | undefined {
    const absolute = entrypoint instanceof URL ? fileURLToPath(entrypoint) : path.resolve(this.root, entrypoint);
    const file = path.relative(this.root, absolute).split(path.sep).join('/');
    return file.startsWith('src/pages/') && file.endsWith('.astro') ? file : undefined;
  }
}

/** The child's reply, parsed: it crosses a process boundary. */
export function parseTemplateOutputs(input: unknown): readonly TemplateOutput[] {
  if (input === undefined) {
    return [];
  }
  if (!Array.isArray(input) || input.length > TEMPLATES_MAX) {
    throw new Error('Template outputs: expected a bounded list');
  }
  return input.map((item: unknown) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('Template output: expected an object');
    }
    const file: unknown = Reflect.get(item, 'file');
    const documents: unknown = Reflect.get(item, 'documents');
    if (typeof file !== 'string' || !file.startsWith('src/pages/') || !isTemplateRoute(routeFor(file))) {
      throw new Error('Template output: expected a template page');
    }
    if (!Array.isArray(documents) || documents.length > TEMPLATE_DOCUMENTS_MAX) {
      throw new Error('Template output: expected a bounded document list');
    }
    return {
      file,
      documents: documents.map((document: unknown) => {
        if (typeof document !== 'string' || document.startsWith('/') || document.split('/').includes('..') || !document.endsWith('.html')) {
          throw new Error('Template output: a document is outside the site');
        }
        return document;
      }),
    };
  });
}

/** What the bake keeps of a template: its first entries, and how many it left as built. */
export interface TemplateEntryPages {
  readonly pages: readonly BakePage[];
  readonly dropped: number;
}

/**
 * Each template entry the bake keeps, as a page sharing the template's file. Kept: an
 * editable document (`editable`), at most `templateEntriesMax` per template, in build order.
 * A document that is also a fixed page's is that page's, as Astro routes it.
 */
export function templateEntryPages(
  outputs: readonly TemplateOutput[],
  fixed: readonly BakePage[],
  editable: (document: string) => boolean,
  propsOf: (document: string) => unknown = () => undefined,
): TemplateEntryPages {
  const taken = new Set(fixed.map((page) => page.document));
  const pages: BakePage[] = [];
  let dropped = 0;
  for (const output of outputs) {
    const pattern = routeFor(output.file);
    assert(isTemplateRoute(pattern), 'A template output belongs to a template page');
    let kept = 0;
    for (const document of output.documents) {
      const route = documentRoute(document);
      const params = matchTemplateRoute(pattern, route);
      if (params !== undefined && !taken.has(document) && editable(document)) {
        if (kept < BAKE_LIMITS.templateEntriesMax) {
          taken.add(document);
          const entry = templateEntryLabel(pattern, params);
          const props = propsOf(document);
          pages.push(props === undefined ? { file: output.file, route, document, entry } : { file: output.file, route, document, entry, entryProps: props });
          kept += 1;
        } else {
          dropped += 1;
        }
      }
    }
    assert(kept <= BAKE_LIMITS.templateEntriesMax, 'A template keeps at most its entry limit');
  }
  return { pages, dropped };
}

/** The route a built document serves: `docs/intro/index.html` is `/docs/intro`. */
export function documentRoute(document: string): string {
  assert(document.endsWith('.html'), 'A built page is an HTML document');
  assert(!document.startsWith('/'), 'A built document is relative to the site');
  if (document === 'index.html') {
    return '/';
  }
  if (document.endsWith('/index.html')) {
    return `/${document.slice(0, -'/index.html'.length)}`;
  }
  return `/${document.slice(0, -'.html'.length)}`;
}

/** The element a template entry's props sample rides in, from the render to the bake. */
const ENTRY_PROPS_ID = 'stacki-bake-entry-props';
const ENTRY_PROPS_ELEMENT = new RegExp(`\\s*<script type="application/json" id="${ENTRY_PROPS_ID}">([\\s\\S]*?)</script>`);

/**
 * Markup a template page renders last: its own Astro.props, sampled as Desktop samples
 * getStaticPaths' props (entryPropsSample.ts), so each entry's document says what its data
 * holds. The bake reads it and cuts it out again (`extractEntryProps`). `<` is escaped so
 * no value can end the element early.
 */
export function entryPropsMarkup(sampler: (value: unknown, depth: number) => unknown): string {
  const source = sampler.toString();
  assert(source.length < 10_000, 'The sampler is a small self-contained function');
  const value = `JSON.stringify((${source})(Astro.props, 0)).replace(/</g, '\\\\u003c')`;
  return `\n<script type="application/json" id="${ENTRY_PROPS_ID}" is:inline set:html={${value}}></script>`;
}

/** A rendered entry's props sample and its document without it; no sample, no change. */
export function extractEntryProps(html: string): { readonly html: string; readonly props: unknown } {
  const match = ENTRY_PROPS_ELEMENT.exec(html);
  if (match === null) {
    return { html, props: undefined };
  }
  const props = parseEntryProps(JSON.parse(match[1] ?? 'null') as unknown);
  const stripped = html.slice(0, match.index) + html.slice(match.index + match[0].length);
  assert(!ENTRY_PROPS_ELEMENT.test(stripped), 'A document carries one props sample');
  return { html: stripped, props };
}
