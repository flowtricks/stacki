// The audit's site checks: what no single file holds. Whether the Astro config
// installs a sitemap, whether a robots.txt is served, which pages share a
// title or a description, and whether any page writes structured data. Each
// takes facts the runner gathered (a config's text, the public files, the
// titles the scan and the rendered pass read) and returns findings; none
// reads anything itself.
import { assert } from '../core/assert';
import { AUDIT_LIMITS, auditFinding, type AuditFinding } from './auditFindings';
import type { AuditFileSummary } from './auditStatic';

export interface SiteFacts {
  /** The Astro config, project-relative, and its text; undefined when the project has none. */
  readonly astroConfig: { readonly file: string } | undefined;
  /** Whether a sitemap is made: an integration, a sitemap endpoint, or one the dev server serves. */
  readonly sitemap: boolean;
  /** Whether `/robots.txt` is served: a public file, an endpoint, an integration, or the dev server's answer. */
  readonly robots: boolean;
  /** Each page's file, route, title and description as far as they are known. */
  readonly pages: readonly SitePage[];
  /** The launch checklist's facts, gathered for the whole site; undefined outside the site scope. */
  readonly launch: LaunchFacts | undefined;
  /** The static walk's notes for every file audited. */
  readonly summaries: readonly AuditFileSummary[];
}

export interface LaunchFacts {
  readonly favicon: boolean;
  readonly notFound: boolean;
  readonly analytics: boolean;
  /** Where a fix belongs when one is missing: the layout that writes the head, else the config. */
  readonly headFile: string;
}

export interface SitePage {
  readonly file: string;
  readonly route: string;
  readonly title: string | undefined;
  readonly description: string | undefined;
  /** Whether the rendered page writes application/ld+json; undefined when it was not rendered. */
  readonly structuredData?: boolean; /** Whether the rendered page links an icon, and runs analytics; undefined when it was not rendered. */
  readonly icon?: boolean;
  readonly analytics?: boolean;
  /** The social image it names, with the finding to report should it not load. */
  readonly socialImage?: { readonly url: string; readonly finding: AuditFinding } | undefined;
}

/** Every site-level finding. */
export function auditSite(facts: SiteFacts): readonly AuditFinding[] {
  assert(facts.pages.length <= AUDIT_LIMITS.filesMax, 'auditSite: the pages are bounded');
  const findings: AuditFinding[] = [];
  const config = facts.astroConfig;
  if (config !== undefined && !facts.sitemap) {
    findings.push(siteFinding('sitemap', config.file, 'No sitemap integration, sitemap endpoint or served sitemap'));
  }
  if (!facts.robots) {
    findings.push(siteFinding('robots', 'public/robots.txt', 'Neither public/robots.txt, a robots.txt endpoint nor a robots integration'));
  }
  // The rendered pages are the truth when there are any; the source's own notes otherwise.
  const rendered = facts.pages.filter((page) => page.structuredData !== undefined);
  const structured = rendered.length > 0 ? rendered.some((page) => page.structuredData === true) : facts.summaries.some((summary) => summary.structuredData);
  const heads = rendered.length > 0 ? rendered : facts.summaries.filter((summary) => summary.head);
  if (heads.length > 0 && !structured) {
    findings.push(siteFinding('structured-data', facts.pages[0]?.file ?? config?.file ?? 'src', 'No page writes application/ld+json structured data'));
  }
  findings.push(...launchFindings(facts.launch));
  findings.push(...duplicates(facts.pages, 'title'), ...duplicates(facts.pages, 'description'));
  assert(findings.length <= facts.pages.length * 2 + 6, 'auditSite: at most two per page and three for the site');
  return findings;
}

function siteFinding(check: AuditFinding['check'], file: string, detail: string): AuditFinding {
  return auditFinding({ check, file, fileKind: 'site', element: undefined, detail, source: 'static', fix: undefined });
}

// One finding per page whose title (or description) another page shares, naming the others.
function duplicates(pages: readonly SitePage[], field: 'title' | 'description'): readonly AuditFinding[] {
  const byValue = new Map<string, SitePage[]>();
  for (const page of pages) {
    const value = page[field]?.trim();
    if (value !== undefined && value.length > 0) {
      const list = byValue.get(value) ?? [];
      list.push(page);
      byValue.set(value, list);
    }
  }
  const check = field === 'title' ? 'title-duplicate' : 'description-duplicate';
  const found: AuditFinding[] = [];
  for (const [value, list] of byValue) {
    if (list.length < 2) {
      continue;
    }
    for (const page of list) {
      const others = list.filter((other) => other !== page).map((other) => other.route);
      const shown = value.length > 60 ? `${value.slice(0, 59)}…` : value;
      found.push(
        auditFinding({
          check,
          file: page.file,
          fileKind: 'page',
          element: undefined,
          detail: `"${shown}" is also on ${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}`,
          source: 'static',
          fix: undefined,
        }),
      );
    }
  }
  assert(found.length <= pages.length, 'duplicates: at most one per page');
  return found;
}

/** Routes a project marks noindex on purpose: the string literals of an exported `NOINDEX_ROUTES`-style array. */
export function noindexRoutesIn(source: string): readonly string[] {
  assert(source.length <= AUDIT_LIMITS.renderedHtmlCharsMax, 'noindexRoutesIn: a constants file is bounded');
  const match = /export\s+const\s+\w*NO_?INDEX\w*\s*(?::[^=]+)?=\s*\[([^\]]*)\]/i.exec(source);
  if (match === null) {
    return [];
  }
  const routes = [...(match[1] ?? '').matchAll(/['"`]([^'"`]+)['"`]/g)].map((entry) => entry[1] ?? '').filter((route) => route.startsWith('/'));
  assert(
    routes.every((route) => route.length > 0),
    'noindexRoutesIn: every route is a path',
  );
  return routes;
}

/** A string constant a project exports (`export const SITE_TITLE = '…'`), or undefined. */
export function exportedString(source: string, names: readonly string[]): { readonly name: string; readonly value: string } | undefined {
  assert(names.length > 0, 'exportedString: asks for at least one name');
  for (const name of names) {
    assert(/^[A-Z_][A-Z0-9_]*$/.test(name), 'exportedString: asks for a constant name');
    const match = new RegExp(`export\\s+const\\s+${name}\\s*(?::\\s*string\\s*)?=\\s*(['"\`])((?:(?!\\1)[^\\\\]|\\\\.)*)\\1`).exec(source);
    const value = match?.[2];
    if (value !== undefined && !value.includes('${')) {
      return { name, value };
    }
  }
  return undefined;
}

/** Integrations in an Astro config's text that make a sitemap, or a robots.txt. */
export function configMakes(text: string, file: 'sitemap' | 'robots'): boolean {
  assert(text.length <= AUDIT_LIMITS.renderedHtmlCharsMax, 'configMakes: a config is bounded');
  return file === 'sitemap' ? /@astrojs\/sitemap|astro-sitemap/.test(text) : /astro-robots-txt|astro-robots\b/.test(text);
}

/** Endpoint files under src/pages that generate a sitemap, or a robots.txt. */
export const SITE_FILE_ENDPOINTS: Readonly<Record<'sitemap' | 'robots', readonly string[]>> = {
  sitemap: ['sitemap.xml', 'sitemap-index.xml', 'sitemap-0.xml'].flatMap((name) => ['ts', 'js', 'mjs'].map((extension) => `src/pages/${name}.${extension}`)),
  robots: ['ts', 'js', 'mjs'].map((extension) => `src/pages/robots.txt.${extension}`),
};

/** The URLs the dev server is asked for, the served answer being the truth. */
export const SITE_FILE_URLS: Readonly<Record<'sitemap' | 'robots', readonly string[]>> = {
  sitemap: ['/sitemap-index.xml', '/sitemap.xml'],
  robots: ['/robots.txt'],
};

function launchFindings(launch: LaunchFacts | undefined): readonly AuditFinding[] {
  if (launch === undefined) {
    return [];
  }
  const found: AuditFinding[] = [];
  if (!launch.favicon) {
    found.push(siteFinding('launch-favicon', launch.headFile, 'No page links an icon, and public/ has no favicon'));
  }
  if (!launch.notFound) {
    found.push(siteFinding('launch-404', 'src/pages', 'No src/pages/404 page'));
  }
  if (!launch.analytics) {
    found.push(siteFinding('launch-analytics', launch.headFile, 'No analytics snippet in any page, and no analytics integration'));
  }
  assert(found.length <= 3, 'launchFindings: three checks at most');
  return found;
}

/** Analytics integrations an Astro config may install. */
export function configHasAnalytics(text: string): boolean {
  assert(text.length <= AUDIT_LIMITS.renderedHtmlCharsMax, 'configHasAnalytics: a config is bounded');
  return /astro-google-analytics|@vercel\/analytics|astro-analytics|plausible|posthog|fathom|umami|astro-gtag/.test(text);
}
