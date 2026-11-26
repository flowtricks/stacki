// Where a finding's fix belongs, in the words a row shows: the pages a component or layout is
// on, which page to show when going into one, what tells one instance from another that reads
// the same, and what a broken link points at. Pure, so the panel's rows and its go-to are
// tested without drawing them.
import { assert } from '../../../shared/core/assert';
import type { AuditFileKind, AuditFinding } from '../../../shared/page/auditFindings';
import { nodeChildren } from '../../../shared/page/auditMarkup';
import { withIgnore, withoutIgnore, type AuditIgnores } from '../../../shared/properties/auditIgnores';
import type { PageNode } from '../../../shared/page/pageNode';

/** Routes one group's line names before the rest are counted. */
export const ROUTES_NAMED_MAX = 2;
const WORDS_CHARS_MAX = 24;
const WORD_NODES_MAX = 200;

/**
 * The routes `file` shows on. The pages its findings were seen on when a render saw them
 * (a component can leave itself out of a page that imports it), else the pages whose markup
 * renders it.
 */
export function routesUsing(
  file: string,
  findings: readonly Pick<AuditFinding, 'routes'>[],
  usage: ReadonlyMap<string, readonly string[]> | undefined,
): readonly string[] {
  assert(file.length > 0, 'routesUsing: a file is named');
  const seen = new Set(findings.flatMap((finding) => finding.routes ?? []));
  return seen.size > 0 ? [...seen].sort() : (usage?.get(file) ?? []);
}

/** The first routes by name, and how many more there are. */
export function namedRoutes(routes: readonly string[]): { readonly named: string; readonly more: number } {
  const named = routes.slice(0, ROUTES_NAMED_MAX).join(', ');
  return { named, more: Math.max(routes.length - ROUTES_NAMED_MAX, 0) };
}

/** What kind of place a group is: its heading's second line starts with it. */
export function placeKind(file: string, kind: AuditFileKind | undefined): 'page' | 'layout' | 'component' | 'file' {
  if (kind === 'page' || file.startsWith('src/pages/')) {
    return 'page';
  }
  if (!file.endsWith('.astro')) {
    return 'file';
  }
  return kind === 'layout' || file.startsWith('src/layouts/') ? 'layout' : 'component';
}

/**
 * The page the canvas must show before a component is opened on it: undefined when the page
 * already shown uses it, or when no page is known to. A page with a fixed route is preferred
 * to a pattern, and an ordinary one to the 404 page.
 */
export function hostRoute(routes: readonly string[], shown: string | undefined): string | undefined {
  if (shown !== undefined && routes.includes(shown)) {
    return undefined;
  }
  const fixed = routes.filter((route) => !route.includes('['));
  return fixed.find((route) => route !== '/404') ?? fixed[0];
}

/** The first words written inside a node, to tell one Button from the next: `Get started`. */
export function nodeWords(node: PageNode): string | undefined {
  const pending: PageNode[] = [...nodeChildren(node)].reverse();
  for (let visited = 0; pending.length > 0 && visited < WORD_NODES_MAX; visited++) {
    const child = pending.pop();
    assert(child !== undefined, 'nodeWords: the stack holds a node');
    if (child.kind === 'text') {
      const words = child.value.replace(/\s+/g, ' ').trim();
      if (words.length > 0) {
        return words.length > WORDS_CHARS_MAX ? `${words.slice(0, WORDS_CHARS_MAX - 1)}…` : words;
      }
    }
    pending.push(...[...nodeChildren(child)].reverse());
  }
  return undefined;
}

/** For rows that would read the same, which one each is (`2 of 5`); rows that read differently get none. */
export function copyNumbers<T>(rows: readonly T[], reads: (row: T) => string): ReadonlyMap<T, { readonly index: number; readonly count: number }> {
  const same = new Map<string, T[]>();
  for (const row of rows) {
    const key = reads(row);
    const held = same.get(key) ?? [];
    held.push(row);
    same.set(key, held);
  }
  const numbers = new Map<T, { readonly index: number; readonly count: number }>();
  for (const group of same.values()) {
    if (group.length > 1) {
      group.forEach((row, at) => numbers.set(row, { index: at + 1, count: group.length }));
    }
  }
  assert(numbers.size <= rows.length, 'copyNumbers: at most one number per row');
  return numbers;
}

/** What a broken link points at, and whether it is the page or the section on it that is missing. */
export function brokenLink(
  finding: Pick<AuditFinding, 'check' | 'detail'>,
  missingPage: string | undefined,
): { readonly url: string; readonly missing: 'page' | 'section' } | undefined {
  const url = finding.check === 'link-broken' ? /href="([^"]*)"/.exec(finding.detail)?.[1] : undefined;
  if (url === undefined || url.length === 0) {
    return undefined;
  }
  return { url, missing: url.includes('#') && missingPage === undefined ? 'section' : 'page' };
}

/**
 * The ignores with `finding` shown again. An entry saved before findings moved to where their
 * value is written covered several of them at once: removing it for one keeps the others
 * ignored, each under its own id, with the same reason.
 */
export function ignoresWithout(
  value: AuditIgnores,
  finding: Pick<AuditFinding, 'id' | 'repeatOf' | 'formerIds'>,
  findings: readonly Pick<AuditFinding, 'id' | 'formerIds'>[],
): AuditIgnores {
  const former = finding.formerIds ?? [];
  // A repeat may be hidden by the first match's entry: that is the one to take away.
  const own = [finding.id, ...(finding.repeatOf === undefined ? [] : [finding.repeatOf])];
  let next = [...own, ...former].reduce(withoutIgnore, value);
  for (const entry of value.ignored.filter((candidate) => former.includes(candidate.id))) {
    for (const sibling of findings) {
      if (sibling.id !== finding.id && (sibling.formerIds ?? []).includes(entry.id)) {
        next = withIgnore(next, { id: sibling.id, reason: entry.reason });
      }
    }
  }
  assert(
    next.ignored.every((entry) => entry.id !== finding.id),
    'ignoresWithout: the finding has no entry left',
  );
  return next;
}
