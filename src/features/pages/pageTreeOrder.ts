import type { PageOrder } from '../../../shared/properties/pageOrder';
import type { PageTreeNode, PageTreePage } from './pageTree';
import { comparePageNames, leadsFolders } from './pageOrder';

export type PageTreeEntry =
  | { readonly kind: 'page'; readonly key: string; readonly page: PageTreePage }
  | {
      readonly kind: 'folder';
      readonly key: string;
      readonly name: string;
      readonly node: PageTreeNode;
    };

export function orderedPageTree(tree: PageTreeNode, relative: string, order: PageOrder): readonly PageTreeEntry[] {
  const pages = [...tree.pages].sort((left, right) => comparePageNames(left.base, right.base));
  const pageEntry = (page: PageTreePage): PageTreeEntry => ({ kind: 'page', key: page.name, page });
  const folders = [...tree.directories.entries()].sort(([left], [right]) => left.localeCompare(right));
  const defaults: readonly PageTreeEntry[] = [
    ...pages.filter((page) => leadsFolders(page.base)).map(pageEntry),
    ...folders.map(([name, node]): PageTreeEntry => ({
      kind: 'folder',
      key: `${relative ? relative + '/' : ''}${name}/`,
      name,
      node,
    })),
    ...pages.filter((page) => !leadsFolders(page.base)).map(pageEntry),
  ];
  const rank = new Map(order.entries.map((key, index) => [key, index]));
  // Stable sorting retains the default order for newly discovered files and folders.
  return [...defaults].sort((left, right) => (rank.get(left.key) ?? order.entries.length) - (rank.get(right.key) ?? order.entries.length));
}
