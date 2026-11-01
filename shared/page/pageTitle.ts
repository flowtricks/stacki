// Display names come from the page's layout, while route names remain file identities.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { decodeEntities } from './htmlText';
import type { Attr } from './pageNode';

interface TitleNode {
  readonly id?: string;
  readonly kind: string;
  readonly props?: Readonly<Record<string, Attr>> | undefined;
}

export function layoutPageTitle(nodes: readonly TitleNode[], inheritedTitle?: string): string | undefined {
  assert(nodes.length <= LIMITS.treeNodesMax, 'Page title: node count is bounded');
  const layout = nodes.find((node) => node.id === 'layout');
  if (layout?.kind !== 'component') {
    return undefined;
  }
  const title = layout.props?.['title'];
  if (title === undefined) {
    return inheritedTitle;
  }
  if (title?.type !== 'string') {
    // Runtime expressions cannot supply a stable page label without executing site code.
    return undefined;
  }
  assert(title.value.length <= LIMITS.attrCharsMax, 'Page title: attribute is bounded');
  const value = decodeEntities(title.value).trim();
  return value.length > 0 ? value : undefined;
}
