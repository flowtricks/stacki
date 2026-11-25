// Reading a page template back into the settings the "Create page template" dialog chose, and changing them. A
// template is recognised only by writing its pieces again (pageTemplateSource.ts, contentTemplatePieces) and finding
// them byte for byte in the page's frontmatter: Stacki never guesses at code it did not write. A page whose code was
// changed by hand — its own getStaticPaths, two collections, a filter — reads as `custom`, shown as code and never
// rewritten. A change replaces exactly the two pieces (the paths function and the entry's type) and nothing else.
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { described } from '../../shared/properties/i18n/messageRef';
import type { ContentSlug, RouteParts } from '../../shared/properties/pageTemplate';
import type { TemplateReading } from '../../shared/properties/pageTemplateReading';

export type { TemplateReading };
import { contentTemplatePieces } from './pageTemplateSource';

export const TEMPLATE_READ_LIMITS = {
  /** Address fields tried when recognising a template: every field the frontmatter names. */
  candidatesMax: 200,
} as const satisfies Record<string, number>;

const FENCE = /^(\s*---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const FIELD = /\bentry\.data(?:\.([A-Za-z_$][\w$]*)|\[\s*'((?:\\.|[^'\\])+)'\s*\])/g;

/** What the template settings of the page at `page` (relative to src/pages) are, read from its text. */
export function readPageTemplate(page: string, source: string): TemplateReading {
  const route = routeOf(page);
  if (route === undefined) {
    return { kind: 'none' };
  }
  const fence = FENCE.exec(source);
  const code = fence?.[2] ?? '';
  const frontmatter = code.replace(/\r\n/g, '\n');
  const collections = [...frontmatter.matchAll(/\bgetCollection\(\s*(['"])((?:\\.|(?!\1).)+)\1/g)].map((match) => match[2] ?? '');
  const collection = collections[0];
  if (collection === undefined || collections.length !== 1 || collection.includes('\\')) {
    return { kind: 'custom', code };
  }
  for (const api of ['current', 'legacy'] as const) {
    for (const slug of slugCandidates(frontmatter)) {
      const pieces = contentTemplatePieces(route, { collection, slug }, api);
      if (frontmatter.includes(pieces.paths)) {
        if (frontmatter.includes(pieces.entryType)) {
          return { kind: 'content', collection, slug, param: route.param, api, code };
        }
      }
    }
  }
  return { kind: 'custom', code };
}

/** The page's text with its template's collection and address source changed; refused unless it reads as `content`. */
export function retargetPageTemplate(page: string, source: string, next: { readonly collection: string; readonly slug: ContentSlug }): Result<string> {
  const reading = readPageTemplate(page, source);
  const route = routeOf(page);
  if (reading.kind !== 'content' || route === undefined) {
    return err({ code: 'custom', ...described('pages.settings.error.templateChanged') });
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const before = contentTemplatePieces(route, { collection: reading.collection, slug: reading.slug }, reading.api);
  const after = contentTemplatePieces(route, next, reading.api);
  const fence = FENCE.exec(source);
  assert(fence !== null, 'A recognised template has a frontmatter fence');
  const opening = fence[1] ?? '';
  const code = fence[2] ?? '';
  const closing = fence[3] ?? '';
  const paths = before.paths.replace(/\n/g, eol);
  assert(code.includes(paths), 'A recognised template holds its paths function as written');
  const changed = code
    .replace(paths, () => after.paths.replace(/\n/g, eol))
    .split(before.entryType)
    .join(after.entryType);
  const text = opening + changed + closing + source.slice(fence[0].length);
  const check = readPageTemplate(page, text);
  assert(check.kind === 'content', 'A retargeted template still reads as a template');
  assert(check.collection === next.collection, 'A retargeted template reads its new collection');
  return ok(text);
}

// `blog/[slug].astro` is a route whose placeholder is `slug`; a static page, or two placeholders, is not a template.
function routeOf(page: string): RouteParts | undefined {
  const name = page.split('/').at(-1) ?? '';
  const match = /^\[(?:\.\.\.)?([A-Za-z][A-Za-z0-9_]*)\]\.astro$/.exec(name);
  const placeholders = page.match(/\[/g)?.length ?? 0;
  if (match?.[1] === undefined || placeholders !== 1) {
    return undefined;
  }
  return { file: page, param: match[1] };
}

function slugCandidates(frontmatter: string): readonly ContentSlug[] {
  const names = new Set<string>();
  for (const match of frontmatter.matchAll(FIELD)) {
    const name = match[1] ?? match[2]?.replace(/\\(.)/g, '$1');
    if (name !== undefined && names.size < TEMPLATE_READ_LIMITS.candidatesMax) {
      names.add(name);
    }
  }
  const fields = [...names].flatMap((name): readonly ContentSlug[] => [
    { kind: 'field', name, treatment: 'exact' },
    { kind: 'field', name, treatment: 'slugified' },
  ]);
  return [{ kind: 'entry-id' }, ...fields];
}
