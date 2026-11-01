// A general callback is code with markup holes. Interleave it without moving
// returns, declarations, comments, or awaits across their original scopes.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { MapNode, ParserNode } from './astroParserTypes';
import { normalizeHead } from './astroScan';

export function serializeMapCallback(node: MapNode, render: (child: ParserNode, index: number) => string): string {
  const parts = node.bodyParts;
  assert(parts !== undefined, 'General callbacks carry their JavaScript parts');
  assert(parts.length === node.children.length + 1, 'Every markup root has surrounding code');
  assert(parts.length <= LIMITS.treeNodesMax + 1, 'Callback serialization is bounded');
  assert(node.head.endsWith('('), 'A normalized callback head ends with its body placeholder');
  const head = node.headSource && normalizeHead(node.headSource) === node.head ? node.headSource : node.head;
  const output = ['{', head.slice(0, -1)];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    assert(part !== undefined, 'Callback part index is in bounds');
    output.push(part);
    const child = node.children[index];
    if (child !== undefined) {
      output.push(render(child, index));
    }
  }
  return output.join('');
}
