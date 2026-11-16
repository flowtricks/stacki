// The order a page's stylesheets reach the cascade, from the `@import`s between them.
//
// The style panel lists project stylesheets by folder depth and name, which says nothing about
// the order the browser applies them in. A page that loads `global.css`, itself a list of
// `@import`s, applies the imported files in the order the imports are written, and an import
// comes BEFORE the rules of the file that holds it (an `@import` must lead its sheet). The
// panel crowned `live/webflow-shared.css` over `live/shared.css` only because `w` sorts after
// `s`; the page loads `shared.css` last, and it wins.
//
// This module reads the import graph and returns the order a bundler flattens it to: each
// file's imports first, in written order, then the file itself; an unimported file is a root
// and keeps its place among the roots. A file imported twice counts at its first import, which
// is where a bundler (and the browser, for a repeated URL) puts the rules that stay.
//
// Static on purpose: which root the page loads first is the page's own business (a layout's
// `import "../styles/global.css"`), so roots keep the listing order and the browser's answer
// (shared/properties/cascadeOrigin.ts) settles any disagreement the panel then shows.

import { assert } from '../../../../shared/core/assert';

/** One stylesheet: where it lives and what it says. */
export type ImportSource = {
  readonly path: string;
  readonly code: string;
};

/** One `@import`, as written. */
export type ImportStatement = {
  readonly target: string;
  /** The layer the imported rules sit in: its dotted name, `''` for an anonymous layer, absent when unlayered. */
  readonly layer: string | undefined;
};

/** The most imports one stylesheet is read for: a stylesheet is untrusted input. */
export const IMPORTS_PER_FILE_MAX = 512;

// `@import "x.css"`, `@import 'x.css'`, `@import url(x.css)`, `@import url("x.css")`, then an
// optional `layer` or `layer(name)` before any media condition.
const IMPORT_PATTERN = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')\s*(?:layer(?:\(\s*([^)]*?)\s*\))?(?![\w-]))?/gi;

/** The `@import`s of a stylesheet's text, in written order. Comments are skipped. */
export function importsOf(code: string): ImportStatement[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: ImportStatement[] = [];
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    if (found.length >= IMPORTS_PER_FILE_MAX) {
      break;
    }
    const target = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (target.length === 0) {
      continue;
    }
    const wholeMatch = match[0];
    const layered = /\blayer\b/i.test(wholeMatch.slice(wholeMatch.search(/["')]\s*layer/i) + 1));
    found.push({ target, layer: layered ? (match[6] ?? '').trim() : undefined });
  }
  assert(found.length <= IMPORTS_PER_FILE_MAX, 'importsOf: the imports are bounded');
  return found;
}

// A path with `.` and `..` folded away, `/` separators only.
function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') {
      parts.pop();
    } else if (part !== '.' && part !== '') {
      parts.push(part);
    }
  }
  return `/${parts.join('/')}`;
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash <= 0 ? '/' : path.slice(0, slash);
}

/** The file an `@import` names, resolved against its importer, when the page's styles hold it. */
function resolveImport(importer: string, target: string, known: ReadonlySet<string>): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) {
    return undefined; // A remote stylesheet is not a project file.
  }
  const withoutQuery = target.replace(/[?#].*$/, '');
  const base = withoutQuery.startsWith('/') ? withoutQuery : `${directoryOf(importer)}/${withoutQuery}`;
  const direct = normalizePath(base);
  if (known.has(direct)) {
    return direct;
  }
  // A bundler resolves a bare package or `~` path from node_modules, which no project file is.
  return undefined;
}

/** One file's place in the page's cascade. */
export type ImportPlacement = {
  readonly path: string;
  /** Ascending rank in the order the page applies the files. */
  readonly rank: number;
  /** The layer the file's rules sit in through the import that brought it, absent when unlayered. */
  readonly layer: readonly string[] | undefined;
};

/**
 * Where each file of `sources` falls in the cascade. `sources` come in listing order, which
 * orders the roots; the result holds every source once, imports before their importer.
 */
export function orderByImports(sources: readonly ImportSource[]): ImportPlacement[] {
  const byPath = new Map(sources.map((source) => [normalizePath(source.path), source]));
  const known = new Set(byPath.keys());
  const imported = new Set<string>();
  const importsByPath = new Map<string, Array<{ readonly path: string; readonly layer: string | undefined }>>();
  for (const [path, source] of byPath) {
    const resolved: Array<{ readonly path: string; readonly layer: string | undefined }> = [];
    for (const statement of importsOf(source.code)) {
      const target = resolveImport(path, statement.target, known);
      if (target !== undefined && target !== path) {
        resolved.push({ path: target, layer: statement.layer });
        imported.add(target);
      }
    }
    importsByPath.set(path, resolved);
  }

  const placements: ImportPlacement[] = [];
  const visited = new Set<string>();
  // An explicit stack, not recursion: the graph is a project's own, but a cycle or a deep chain
  // must cost a bounded walk. Each file is pushed once, so the loop runs at most 2 * files times.
  const visit = (root: string, rootLayer: readonly string[] | undefined): void => {
    const stack: Array<{ readonly path: string; readonly layer: readonly string[] | undefined; expanded: boolean }> = [
      { path: root, layer: rootLayer, expanded: false },
    ];
    const budget = byPath.size * 2 + 2;
    for (let step = 0; step < budget && stack.length > 0; step += 1) {
      const top = stack[stack.length - 1];
      assert(top !== undefined, 'orderByImports: the stack is non-empty inside the loop');
      if (top.expanded) {
        stack.pop();
        const source = byPath.get(top.path);
        assert(source !== undefined, 'orderByImports: a visited path is a source');
        placements.push({ path: source.path, rank: placements.length, layer: top.layer });
        continue;
      }
      top.expanded = true;
      visited.add(top.path);
      const children = importsByPath.get(top.path) ?? [];
      // Pushed in reverse so the first written import is expanded first.
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined && !visited.has(child.path)) {
          const layer =
            child.layer === undefined ? top.layer : [...(top.layer ?? []), ...(child.layer === '' ? [`\u0000import-${child.path}`] : child.layer.split('.'))];
          stack.push({ path: child.path, layer, expanded: false });
        }
      }
    }
  };

  for (const source of sources) {
    const path = normalizePath(source.path);
    if (!imported.has(path) && !visited.has(path)) {
      visit(path, undefined);
    }
  }
  // A cycle leaves every member imported by another: they are not roots, so they are placed last,
  // in listing order, rather than dropped.
  for (const source of sources) {
    const path = normalizePath(source.path);
    if (!visited.has(path)) {
      visit(path, undefined);
    }
  }
  assert(placements.length === byPath.size, 'orderByImports: every source is placed exactly once');
  return placements;
}
