import type { ScanPage } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS, pathText, record } from '../../../shared/core/boundary';
import { pageSegments } from '../../lib/pageName';

export interface PageTreePage extends ScanPage {
  readonly base: string;
}

export interface PageTreeNode {
  readonly directories: ReadonlyMap<string, PageTreeNode>;
  readonly pages: readonly PageTreePage[];
}

interface MutablePageTreeNode {
  readonly directories: Map<string, MutablePageTreeNode>;
  readonly pages: PageTreePage[];
}

export interface PageDragPayload {
  readonly path: string;
  readonly name: string;
}

export function buildPageTree(pages: readonly ScanPage[], folders: readonly string[]): PageTreeNode {
  const root = createNode();
  for (const folder of folders) {
    directoryNode(root, folder);
  }
  for (const page of pages) {
    const parts = pageSegments(page.name);
    const base = parts.at(-1);
    assert(base !== undefined, 'Page tree: page has a basename');
    const directory = directoryNode(root, parts.slice(0, -1).join('/'));
    directory.pages.push({ ...page, base });
  }
  return root;
}

export function countTreePages(node: PageTreeNode): number {
  const pending: PageTreeNode[] = [node];
  let visited = 0;
  let count = 0;
  while (pending.length > 0) {
    visited += 1;
    assert(visited <= BOUNDARY_LIMITS.itemsMax, 'Page tree: directory count exceeds limit');
    const current = pending.pop();
    assert(current !== undefined, 'Page tree: pending directory exists');
    count += current.pages.length;
    assert(Number.isSafeInteger(count), 'Page tree: page count is a safe integer');
    pending.push(...current.directories.values());
  }
  return count;
}

export function collectPageTreeDirectories(node: PageTreeNode): ReadonlySet<string> {
  const directories = new Set<string>();
  const pending: Array<readonly [string, PageTreeNode]> = [['', node]];
  while (pending.length > 0) {
    assert(directories.size <= BOUNDARY_LIMITS.itemsMax, 'Page tree: directory count exceeds limit');
    const current = pending.pop();
    assert(current !== undefined, 'Page tree: pending directory exists');
    const [parent, currentNode] = current;
    for (const [name, child] of currentNode.directories) {
      const rel = parent ? `${parent}/${name}` : name;
      directories.add(rel);
      pending.push([rel, child]);
    }
  }
  return directories;
}

export function parsePageDragText(input: string): PageDragPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    const value = record(parsed);
    const name = pathText(value['name']);
    pageSegments(name);
    return { path: pathText(value['path']), name };
  } catch {
    return undefined;
  }
}

export function pageExtension(base: string): string {
  return base.match(/\.(astro|mdx?)$/i)?.[0] ?? '.astro';
}

export function pageDirectory(rel: string): string {
  return rel.split('/').slice(0, -1).join('/');
}

function createNode(): MutablePageTreeNode {
  return { directories: new Map(), pages: [] };
}

function directoryNode(root: MutablePageTreeNode, rel: string): MutablePageTreeNode {
  let node = root;
  if (!rel) {
    return node;
  }
  for (const part of pageSegments(rel)) {
    const existing = node.directories.get(part);
    if (existing) {
      node = existing;
    } else {
      const created = createNode();
      node.directories.set(part, created);
      node = created;
    }
  }
  return node;
}
