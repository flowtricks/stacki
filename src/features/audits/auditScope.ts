// What an audit covers. The panel offers the whole site (the default) or the
// current page; the runner knows two more (all pages, components). Each scope each
// names the files the static pass reads, the routes the rendered pass fetches,
// and whether the site checks run. "Current page" also reads every component
// and layout the open file imports, one level at a time to a fixed depth, so a
// problem inside a card on the page is found in the card's own file.
import { assert } from '../../../shared/core/assert';
import { AUDIT_LIMITS } from '../../../shared/page/auditFindings';
import type { ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent, ScanResult } from '../../../shared/properties/projectScan';

export const AUDIT_SCOPES = ['page', 'pages', 'components', 'site'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** A stored scope; anything unknown is the whole site, the default. */
export function parseAuditScope(value: string): AuditScope {
  const found = AUDIT_SCOPES.find((scope) => scope === value);
  return found ?? 'site';
}

/** One file the static pass reads. */
export interface AuditTarget {
  /** Absolute, as the scan and readPage name it. */
  readonly path: string;
  /** Project-relative, `/`-separated. */
  readonly file: string;
  readonly kind: 'page' | 'component' | 'layout';
  readonly route: string | undefined;
}

export interface AuditPlan {
  readonly targets: readonly AuditTarget[];
  /** Routes the rendered pass fetches, each with its page file. */
  readonly routes: readonly { readonly route: string; readonly file: string }[];
  readonly site: boolean;
  /** Files past AUDIT_LIMITS.filesMax that the run left out. */
  readonly skipped: number;
}

/** Imports one component file's audit follows, to this depth from the open file. */
export const IMPORT_DEPTH_MAX = 3;

/** Project-relative form of an absolute path inside the project. */
export function relativeTo(projectPath: string, path: string): string {
  assert(projectPath.length > 0, 'relativeTo: a project has a path');
  const root = projectPath.replace(/[\\/]+$/, '');
  const relative = path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? path.slice(root.length + 1) : path;
  return relative.split('\\').join('/');
}

function componentTarget(projectPath: string, component: ScanComponent): AuditTarget {
  return { path: component.path, file: relativeTo(projectPath, component.path), kind: component.isLayout === true ? 'layout' : 'component', route: undefined };
}

/** The plan for `scope`. `open` is the open file, when there is one. */
export function auditPlan(input: {
  readonly scope: AuditScope;
  readonly projectPath: string;
  readonly scan: ScanResult;
  readonly open: { readonly path: string; readonly kind: 'page' | 'component' } | undefined;
}): AuditPlan {
  const { scan, projectPath } = input;
  const pages = scan.pages.map((page): AuditTarget => ({ path: page.path, file: relativeTo(projectPath, page.path), kind: 'page', route: page.route }));
  const components = [...scan.layouts, ...scan.components]
    .filter((entry) => entry.origin?.kind !== 'package')
    .map((entry) => componentTarget(projectPath, entry));
  let targets: readonly AuditTarget[];
  switch (input.scope) {
    case 'page':
      targets = openTargets(input, pages, components);
      break;
    case 'pages':
      targets = pages;
      break;
    case 'components':
      targets = components;
      break;
    case 'site':
      targets = [...pages, ...components];
      break;
    default: {
      const exhaustive: never = input.scope;
      return exhaustive;
    }
  }
  const unique = [...new Map(targets.map((target) => [target.path, target])).values()];
  const kept = unique.slice(0, AUDIT_LIMITS.filesMax);
  const routes = kept
    .filter((target) => target.kind === 'page' && target.route !== undefined && !target.route.includes('['))
    .slice(0, AUDIT_LIMITS.renderedPagesMax)
    .map((target) => ({ route: target.route ?? '/', file: target.file }));
  assert(kept.length <= AUDIT_LIMITS.filesMax, 'auditPlan: the files are bounded');
  return { targets: kept, routes: input.scope === 'components' ? [] : routes, site: input.scope === 'site', skipped: unique.length - kept.length };
}

// The open file alone at first; its imports join as the runner reads them (importedTargets).
function openTargets(
  input: { readonly open: { readonly path: string; readonly kind: 'page' | 'component' } | undefined },
  pages: readonly AuditTarget[],
  components: readonly AuditTarget[],
): readonly AuditTarget[] {
  const open = input.open;
  if (open === undefined) {
    return [];
  }
  const found = [...pages, ...components].find((target) => target.path === open.path);
  return found === undefined ? [] : [found];
}

/** The component and layout files `imports` name, matched by file name against the scan. */
export function importedTargets(imports: readonly ImportDecl[], projectPath: string, scan: ScanResult): readonly AuditTarget[] {
  const entries = [...scan.layouts, ...scan.components];
  const found: AuditTarget[] = [];
  for (const decl of imports) {
    if (!decl.path.endsWith('.astro')) {
      continue;
    }
    const base = decl.path.split('/').pop() ?? '';
    const entry = entries.find((candidate) => candidate.path.endsWith(`/${base}`) || candidate.path.endsWith(`\\${base}`));
    if (entry !== undefined) {
      found.push(componentTarget(projectPath, entry));
    }
  }
  assert(found.length <= imports.length, 'importedTargets: at most one file per import');
  return found;
}
