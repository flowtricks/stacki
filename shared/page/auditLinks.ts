// Where a link goes, for the broken-link check, and the links a component
// instance makes through its props.
//
// One verdict serves the static pass (a literal `<a href>`), the instance pass
// below (a literal prop a component writes into its own `<a href>`) and the
// rendered pass (every `<a href>` the page ends up rendering), so the three
// agree on what counts as broken: a same-site path no page, route or public file
// serves; a path that breaks the project's trailing-slash rule; a path outside
// the configured base; a `#fragment` no element on the page carries. Anything
// that leaves the site (another origin, mailto:, tel:, javascript:) and the
// files the dev server generates are not this check's to judge.
//
// The instance pass is static and conservative: it follows a prop only where
// the component writes it straight into an href (`href={href}`, `{href}`), or
// passes it unchanged to a nested component that does. A prop the component
// rewrites (`href={`/en${href}`}`), spreads, or reads from an expression is left
// to the rendered pass, which sees the value the page actually links to.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { auditFinding, type AuditFinding } from './auditFindings';
import { lineOf, lineStarts, nodeChildren } from './auditMarkup';
import type { AuditFileInput } from './auditStatic';
import { destructuredProps } from './auditTrace';
import type { PageNode, PairedNode } from './pageNodeTypes';

/** What the project says about the paths it serves. */
export interface LinkFacts {
  /** Route patterns of the project's pages: `/`, `/blog/[slug]`, `/docs/[...path]`. */
  readonly routes: readonly string[];
  /** URL paths of the files under public/ (`/files/guide.pdf`). */
  readonly publicFiles: Pick<ReadonlySet<string>, 'has'>;
  /** Astro's `trailingSlash`: `always` and `never` make the other spelling a 404. */
  readonly trailingSlash?: string | undefined;
  /** Astro's `base` (`/docs`): every same-site path is served under it. */
  readonly base?: string | undefined;
}

/** Where a link goes, as far as the project's own files tell. */
export type LinkTarget =
  /** Not this check's to judge: another origin, another scheme, a generated file, or nothing to go on. */
  | { readonly tag: 'ignored' }
  /** A fragment on the page itself: `#team`. */
  | { readonly tag: 'here'; readonly id: string }
  /** A path the project serves; `route` is it without the base, `id` its fragment when it has one. */
  | { readonly tag: 'found'; readonly url: string; readonly route: string; readonly id: string | undefined }
  /** A path nothing in the project serves; `url` is the path a browser would ask for. */
  | { readonly tag: 'missing'; readonly url: string };

/** Fragments that need no element: `#` and `#top` scroll to the top of any page. */
const FRAGMENTS_FREE: ReadonlySet<string> = new Set(['', 'top']);
/** Paths the dev server or Astro generates, which no project file names. */
const GENERATED_PREFIXES: readonly string[] = ['/_astro/', '/_image', '/@', '/node_modules/', '/__'];
/** Components one instance trace follows into: a card inside a section inside a layout is three. */
export const LINK_HOPS_MAX = 6;
const SITE_ORIGIN = 'http://site.invalid';

/** Where `href` goes, written on a page at route `from` (undefined where the page is not known, as in a component's own file). */
export function linkTarget(href: string, facts: LinkFacts, from: string | undefined): LinkTarget {
  assert(href.length <= 64 * 1024, 'linkTarget: an href is bounded');
  const written = href.trim();
  if (written.length === 0 || facts.routes.length === 0) {
    return { tag: 'ignored' };
  }
  if (written.startsWith('#')) {
    const id = decoded(written.slice(1));
    return FRAGMENTS_FREE.has(id) ? { tag: 'ignored' } : { tag: 'here', id };
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(written) || written.startsWith('//')) {
    return { tag: 'ignored' }; // Another origin or another scheme (mailto:, tel:, javascript:).
  }
  const absolute = absoluteURL(written, from);
  if (absolute === undefined) {
    return { tag: 'ignored' };
  }
  const route = withoutBase(absolute.pathname, facts.base);
  if (route === undefined) {
    return { tag: 'missing', url: absolute.pathname };
  }
  if (GENERATED_PREFIXES.some((prefix) => route.startsWith(prefix))) {
    return { tag: 'ignored' };
  }
  const path = decoded(route);
  const id = absolute.hash.length > 1 ? decoded(absolute.hash.slice(1)) : undefined;
  if (facts.publicFiles.has(path)) {
    return { tag: 'found', url: absolute.pathname, route: path, id: undefined };
  }
  if (!slashAllowed(path, facts.trailingSlash) || !routeExists(path, facts.routes)) {
    return { tag: 'missing', url: absolute.pathname };
  }
  return { tag: 'found', url: absolute.pathname, route: path, id: id !== undefined && FRAGMENTS_FREE.has(id) ? undefined : id };
}

// The link as a URL on the site: an absolute path as written, a relative one against the page it is on.
function absoluteURL(written: string, from: string | undefined): URL | undefined {
  if (!written.startsWith('/')) {
    if (from === undefined || from.includes('[')) {
      return undefined; // Relative to a page this file does not know, or to a pattern rather than a page.
    }
    assert(from.startsWith('/'), 'absoluteURL: a page route is site-relative');
  }
  try {
    const url = new URL(written, `${SITE_ORIGIN}${from ?? '/'}`);
    return url.origin === SITE_ORIGIN ? url : undefined;
  } catch {
    return undefined; // Not a URL a browser could follow either; the link-name checks still see the element.
  }
}

// The path under the configured base, or undefined when the path is outside it.
function withoutBase(path: string, base: string | undefined): string | undefined {
  const root = (base ?? '/').replace(/\/+$/, '');
  if (root.length === 0) {
    return path;
  }
  if (path === root) {
    return '/';
  }
  return path.startsWith(`${root}/`) ? path.slice(root.length) : undefined;
}

// Astro's trailingSlash: `always` serves `/about/` only, `never` serves `/about` only. A file path is exempt.
function slashAllowed(path: string, rule: string | undefined): boolean {
  if (path === '/' || /\.[a-z\d]+$/i.test(path)) {
    return true;
  }
  if (rule === 'always') {
    return path.endsWith('/');
  }
  if (rule === 'never') {
    return !path.endsWith('/');
  }
  return true;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // A malformed escape is compared as written.
  }
}

/** Whether `path` is served by one of `routes`, dynamic segments matching any value. */
export function routeExists(path: string, routes: readonly string[]): boolean {
  assert(path.startsWith('/'), 'routeExists: asks about an absolute path');
  const wanted = segments(path);
  return routes.some((route) => routeMatches(segments(route), wanted));
}

function segments(path: string): readonly string[] {
  return path
    .replace(/\/index(\.html)?$/, '/')
    .replace(/\.html$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function routeMatches(route: readonly string[], wanted: readonly string[]): boolean {
  for (let index = 0; index < route.length; index++) {
    const segment = route[index] ?? '';
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      return true; // A rest parameter takes every remaining segment, or none.
    }
    const value = wanted[index];
    if (value === undefined) {
      return false;
    }
    if (!/\[[^\]]+\]/.test(segment) && segment !== value) {
      return false;
    }
  }
  return route.length === wanted.length;
}

// --- Links an instance makes through its props --------------------------------------------

export interface InstanceLinkInput {
  /** Every file the run read, by project-relative path. */
  readonly files: ReadonlyMap<string, AuditFileInput>;
  /** The project-relative file a component tag in `from` renders, or undefined. */
  readonly resolve: (from: AuditFileInput, tag: string) => string | undefined;
  readonly facts: LinkFacts;
}

/**
 * A broken link set as a literal prop on a component instance, one finding per instance,
 * located at the instance with the prop to edit, where the component writes the prop
 * straight into a link: `<Button href="/abuot">` with Button's `<a href={href}>`.
 */
export function instanceLinkFindings(input: InstanceLinkInput): readonly AuditFinding[] {
  const linking = new Map<string, ReadonlySet<string>>();
  const findings: AuditFinding[] = [];
  for (const file of input.files.values()) {
    const lines = file.source === undefined ? undefined : lineStarts(file.source);
    for (const { node, path } of instances(file.nodes)) {
      const target = input.resolve(file, node.name);
      const callee = target === undefined ? undefined : input.files.get(target);
      if (callee === undefined) {
        continue;
      }
      const props = linkPropsOf(callee, input, linking, 0);
      for (const [key, value] of Object.entries(node.props ?? {})) {
        if (value.type !== 'string' || !props.has(key)) {
          continue;
        }
        const verdict = linkTarget(value.value, input.facts, file.kind === 'page' ? file.route : undefined);
        if (verdict.tag !== 'missing') {
          continue;
        }
        const located: PageNode = node;
        const start = 'start' in located ? located.start : undefined;
        findings.push(
          auditFinding({
            check: 'link-broken',
            file: file.file,
            fileKind: file.kind,
            element: { path, tag: node.name, line: lines === undefined || start === undefined ? undefined : lineOf(lines, start) },
            detail: `href="${value.value}"`,
            source: 'static',
            fix: undefined,
            prop: key,
          }),
        );
      }
    }
  }
  assert(linking.size <= input.files.size, 'instanceLinkFindings: one answer per component file');
  return findings;
}

/** The props a component writes straight into a link, by the key an instance sets: its own `<a href={x}>`, or a nested instance's link prop. */
export function linkPropsOf(
  file: AuditFileInput,
  input: Pick<InstanceLinkInput, 'files' | 'resolve'>,
  memo: Map<string, ReadonlySet<string>>,
  depth: number,
): ReadonlySet<string> {
  // LINK_HOPS_MAX stops the descent below; the tree's own depth bound holds it in any case.
  assert(depth <= LIMITS.treeDepthMax, 'linkPropsOf: the nesting is bounded');
  assert(LINK_HOPS_MAX <= LIMITS.treeDepthMax, 'linkPropsOf: the hop bound sits inside the tree bound');
  const known = memo.get(file.file);
  if (known !== undefined) {
    return known;
  }
  memo.set(file.file, new Set()); // A component that renders itself links nothing more through the cycle.
  const names = destructuredProps(file.frontmatter).names;
  const found = new Set<string>();
  const bound = (code: string): string | undefined => {
    const local = code.trim();
    return /^[A-Za-z_$][\w$]*$/.test(local) ? names.get(local) : undefined;
  };
  for (const { node } of tags(file.nodes)) {
    if (node.kind === 'element' && node.name.toLowerCase() === 'a') {
      const href = Object.entries(node.props ?? {}).find(([key]) => key.toLowerCase() === 'href')?.[1];
      const prop = href?.type === 'expr' ? bound(href.value) : undefined;
      if (prop !== undefined) {
        found.add(prop);
      }
      continue;
    }
    if (node.kind !== 'component' || depth >= LINK_HOPS_MAX) {
      continue;
    }
    const target = input.resolve(file, node.name);
    const callee = target === undefined ? undefined : input.files.get(target);
    if (callee === undefined) {
      continue;
    }
    const nested = linkPropsOf(callee, input, memo, depth + 1);
    for (const [key, value] of Object.entries(node.props ?? {})) {
      const prop = value.type === 'expr' && nested.has(key) ? bound(value.value) : undefined;
      if (prop !== undefined) {
        found.add(prop);
      }
    }
  }
  memo.set(file.file, found);
  return found;
}

function instances(nodes: readonly PageNode[]): readonly { readonly node: PairedNode; readonly path: readonly number[] }[] {
  return tags(nodes).filter((entry) => entry.node.kind === 'component');
}

// Every element and component instance in preorder, with its structural path. Bounded by the tree's own bound.
function tags(nodes: readonly PageNode[]): readonly { readonly node: PairedNode; readonly path: readonly number[] }[] {
  const found: { node: PairedNode; path: readonly number[] }[] = [];
  const pending = nodes.map((node, index) => ({ node, path: [index] as readonly number[] })).reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < 20_000, 'tags: a file stays inside the tree bound');
    const entry = pending.pop();
    assert(entry !== undefined, 'tags: the stack holds an entry');
    if (entry.node.kind === 'component' || entry.node.kind === 'element') {
      found.push({ node: entry.node, path: entry.path });
    }
    pending.push(
      ...nodeChildren(entry.node)
        .map((child, index) => ({ node: child, path: [...entry.path, index] }))
        .reverse(),
    );
  }
  return found;
}
