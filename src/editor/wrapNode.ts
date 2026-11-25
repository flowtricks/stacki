import { assert } from '../../shared/core/assert';
import type { NodeId } from '../../shared/core/brand';
import { withNode } from './insertGestures';
import type { EditGesture } from './pageEdits';
import type { EditorModel, EditorNode } from './pageView';
import { findEditorNodeById } from './pageState';
import { canConvertText, canWrapNode, type TextTag, type WrapperTag } from './wrapRules';
export { canConvertText, canWrapNode, type TextTag, type WrapperTag } from './wrapRules';

/** One undoable wrap, retaining the selected node's identity and named slot. */
export function wrapNodeGesture(model: EditorModel, nodeId: string, wrapper: { readonly id: NodeId; readonly name: WrapperTag }): EditGesture {
  assert(canWrapNode(model.nodes, nodeId, wrapper.name), 'The node accepts this wrapper');
  assert(wrapper.id !== nodeId, 'A wrapper has its own identity');
  const node = findEditorNodeById(model.nodes, nodeId);
  assert(node !== undefined, 'The wrapped node exists');
  const wrapped = wrappedNode(node, wrapper);
  const slot = node.props?.['slot'];
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      // Move the slot and wrap its node as one request, so an undo restores
      // both together without overlapping ancestor and child replacements.
      if (slot !== undefined) {
        return [{ tag: 'replace-node', target, node: wrapped }];
      }
      return [{ tag: 'wrap-nodes', target, last: target, name: wrapper.name }];
    },
    apply: (current) => withNode(current, nodeId, (node) => wrappedNode(node, wrapper)),
  };
}

/** Bare text given a tag, as one undoable edit. The text node's handle moves
 * inside the new element, which takes the wrapper's handle. */
export function textWrapGesture(model: EditorModel, nodeId: string, wrapper: { readonly id: NodeId; readonly name: TextTag }): EditGesture {
  assert(canConvertText(model.nodes, nodeId, wrapper.name), 'The text accepts this tag');
  assert(wrapper.id !== nodeId, 'A wrapper has its own identity');
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      return target === undefined ? undefined : [{ tag: 'wrap-text', target, name: wrapper.name }];
    },
    apply: (current) => withNode(current, nodeId, (node) => ({ ...wrapper, kind: 'element', props: {}, children: [node] })),
  };
}

function wrappedNode(node: EditorNode, wrapper: { readonly id: NodeId; readonly name: WrapperTag }): EditorNode {
  assert(node.kind === 'element' || node.kind === 'component', 'A wrapper contains a tag');
  assert(wrapper.id.length > 0, 'A wrapper has an id');
  const { slot, ...props } = node.props ?? {};
  // Source spans describe the original attributes. Once slot moves, keeping
  // its old span would make the rewritten child fail the boundary parser.
  const { attrSpans: previousSpans, ...child } = node;
  void previousSpans;
  return {
    ...wrapper,
    kind: 'element',
    props: slot === undefined ? {} : { slot },
    children: [slot === undefined ? node : { ...child, props }],
  };
}
