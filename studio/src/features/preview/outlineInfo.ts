import type { OverlayInfo } from '../../../vendor/stacki/src/features/preview/PreviewOverlays';
import { elementLabel } from '../../../vendor/stacki/src/editor/classNames';
import { isDataBound } from '../../../vendor/stacki/src/editor/bindings';
import { flatten, type ParserNode } from '../source/source';
import { pathFor } from '../project/previewSelection';
export function outlineInfo(nodes: readonly ParserNode[], path: string): OverlayInfo | undefined {
  const node = outlineNode(nodes, path);
  if (!node) {
    return undefined;
  }
  const fragment = node.kind === 'component' && (node.name === 'Fragment' || node.name === '');
  const kind = fragment
    ? 'element'
    : node.kind === 'component' && !node.dynamicTag
      ? 'component'
      : ['map', 'cond', 'branch'].includes(node.kind)
        ? 'map'
        : 'element';
  return {
    label: outlineLabel(node),
    kind,
    tag: node.kind === 'element' || node.kind === 'raw' ? node.name : undefined,
    astroAsset: !!node.astroAsset,
    dynamicTag: !!node.dynamicTag,
    nodeKind: node.kind,
    isLayout: node.id === 'layout',
    bound: kind === 'element' && isDataBound(node),
  };
}
export function outlineNode(nodes: readonly ParserNode[], path: string): ParserNode | undefined {
  const trail = path.slice(path.lastIndexOf('|') + 1);
  return flatten(nodes).find((node) => pathFor(node.id ?? '') === trail);
}
export function outlineLabel(node: ParserNode): string {
  if (node.kind === 'element' || node.kind === 'raw' || node.dynamicTag) {
    return elementLabel({ name: node.name ?? '', ...(node.props ? { props: node.props } : {}) });
  }
  if (node.kind === 'map') {
    const at = node.head.indexOf('.map');
    return at > 0 ? node.head.slice(0, at + 4) : 'loop';
  }
  if (node.kind === 'cond') {
    return `if ${node.test}`;
  }
  if (node.kind === 'expr') {
    return 'code';
  }
  return node.name ?? node.kind;
}
