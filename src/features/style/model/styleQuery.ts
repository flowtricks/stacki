// Inline text has no path attribute, and slot helpers can remove its comment
// markers. Only a known text selection may explicitly ask its rendered parent
// for style values; selector matching and edit identity keep the original path.
import { findNode, getHost } from './host';

// `nodeId` is the node asked about: the selection, or the element the panel is reading
// ahead of a switch (computedStyle.ts prefetchComputedStyles).
export function textStyleContext(path: string, nodeId: string | undefined): { readonly textParentPath?: string } {
  const host = getHost();
  const selected = nodeId ? findNode(host.nodes, nodeId) : undefined;
  if (selected?.kind !== 'text') {
    return {};
  }
  if (host.pathOf?.(selected.id) !== path) {
    return {};
  }
  if (!selected.value?.trim()) {
    return {};
  }
  const separator = path.lastIndexOf('.');
  if (separator <= path.lastIndexOf('|')) {
    return {};
  }
  return { textParentPath: path.slice(0, separator) };
}
