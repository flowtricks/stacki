import { isCanvasPage } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
import { flatten, type ParserNode } from '../source/source';

const transparent = new Set(['cond', 'branch', 'map', 'chunk-group']);
const inert = new Set(['head', 'script', 'style', 'link', 'meta', 'title', 'base', 'template']);

// Match Stacki's component entry: prefer a layout's body, otherwise descend
// through control flow/slots/fragments to the first actual rendered element.
export function openingSelection(file: string, nodes: readonly ParserNode[]) {
  const outer = nodes.find(markup) ?? nodes[0];
  if (isCanvasPage(file)) {
    return outer;
  }
  const body = flatten(nodes).find((node) => node.kind === 'element' && node.name === 'body');
  const queue = [...nodes];
  for (let visited = 0; queue.length && visited < 10_000; visited++) {
    const node = queue.shift();
    if (!node) {
      break;
    }
    if (transparent.has(node.kind) || (markup(node) && ['Fragment', 'slot', ''].includes(node.name ?? ''))) {
      queue.unshift(...(node.children ?? []));
    } else if (markup(node) && !inert.has(node.name ?? '')) {
      return body ?? node;
    }
  }
  return body ?? outer;
}
function markup(node: ParserNode) {
  return node.kind === 'element' || node.kind === 'component';
}
