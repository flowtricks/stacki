import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { canvasTypedText, type CanvasTextDraft } from '../../ui/canvasTextDraft';
import { textValueCanonical } from '../../../shared/page/htmlText';
import type { InlineNode } from './richContentModel';

export function canvasDraftInline(
  nodes: readonly InlineNode[],
  draft: CanvasTextDraft | undefined,
): readonly InlineNode[] {
  if (draft?.kind !== 'text') {
    return nodes;
  }
  let remaining = LIMITS.treeNodesMax;
  const visit = (entries: readonly InlineNode[], depth: number): readonly InlineNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'Canvas content draft depth limit exceeded');
    assert(entries.length <= remaining, 'Canvas content draft node limit exceeded');
    remaining -= entries.length;
    return entries.map((node) => {
      if (node.kind === 'element') {
        return { ...node, children: node.children && visit(node.children, depth + 1) };
      }
      if ('id' in node && node.id === draft.nodeID && node.value === draft.sourceValue) {
        // Expression chips keep their original binding when the panel serializes
        // them. Only their visible label previews the edited shared value.
        const typed = canvasTypedText(draft.sourceValue, draft.value);
        return node.kind === 'expr'
          ? { ...node, preview: typed }
          : { ...node, value: textValueCanonical(typed) };
      }
      return node;
    });
  };
  return visit(nodes, 0);
}
