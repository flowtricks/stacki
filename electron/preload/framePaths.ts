// Paths of the page's nodes, as the markers write them.

// The path a node's parent has: `0.1.5` for `0.1.5.6`, inside the same file's
// namespace. A file's top node (`0`, `Card.astro|0`) has none.
export const parentPath = (nodePath: string): string | undefined => {
  const bar = nodePath.lastIndexOf('|');
  const indexes = nodePath.slice(bar + 1);
  const dot = indexes.lastIndexOf('.');
  if (dot < 0) {
    return undefined;
  }
  if (!/^\d+(\.\d+)*$/.test(indexes)) {
    return undefined;
  }
  return nodePath.slice(0, bar + 1) + indexes.slice(0, dot);
};
