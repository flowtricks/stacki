import { bounds, flatten, nodesOf, type TreeAction } from '../source/source';
import { frontmatterRange } from '../source/frontmatter';

export function clientLayout(source: string) {
  const layout = nodesOf(source).find((node) => node.id === 'layout' && node.kind === 'component');
  if (!layout) {
    throw new Error('Client editing requires a page layout. Ask a developer to set one up.');
  }
  return layout;
}
export function assertClientAction(source: string, action: TreeAction) {
  const layout = clientLayout(source);
  const children = new Set(flatten(layout.children ?? []).map((node) => node.id));
  if ('node' in action && !children.has(action.node)) {
    throw new Error('Client mode keeps the page layout and everything outside it protected.');
  }
  if ('target' in action) {
    const insideLayout =
      action.target === layout.id && (!action.placement || action.placement === 'inside');
    if (!insideLayout && !children.has(action.target)) {
      throw new Error('Add and move elements inside the page layout in Client mode.');
    }
  }
}
export function assertClientSourceChange(file: string, before: string, after: string) {
  if (!file.endsWith('.astro')) {
    return;
  }
  if (!file.startsWith('src/pages/')) {
    throw new Error('Component source is protected in Client mode.');
  }
  const previous = clientLayout(before);
  const next = clientLayout(after);
  const left = bounds(previous);
  const right = bounds(next);
  // Generated asset imports may change frontmatter; authored markup outside the
  // layout must remain byte-for-byte intact, and the layout itself must survive.
  const beforeStart = frontmatterRange(before)?.end ?? 0;
  const afterStart = frontmatterRange(after)?.end ?? 0;
  if (
    previous.name !== next.name ||
    before.slice(beforeStart, left.start) !== after.slice(afterStart, right.start) ||
    before.slice(left.end) !== after.slice(right.end)
  ) {
    throw new Error('Client mode cannot change the page layout or elements outside it.');
  }
}
