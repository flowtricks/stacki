// What the Navigator calls a node and draws beside it: the icon and label of its row.
// The Navigator's tree (src/features/structure/StructureTree.tsx) and the Audits panel's occurrence rows both
// read them from here, so a node is named the same in both places.
import React from 'react';
import type { PageNode, PairedNode } from '../../shared/page/pageNode';
import { classLabel, elementLabel } from '../editor/classNames';
import { isFragmentNode } from '../editor/liveClasses';
import {
  BranchIcon,
  CodeIcon,
  CommentIcon,
  CornerIcon,
  CustomElementIcon,
  ElementComponentIcon,
  FileIcon,
  RepeatIcon,
  TextIcon,
  astroAssetIcon,
  elementIcon,
} from './Icons';

export interface NodeDescription {
  readonly icon: React.ReactNode;
  readonly label: string;
}

/** A node's Navigator icon and label; `live` is the class list the page rendered it with, when known. */
export function describeNode(node: PageNode, live: readonly string[] | undefined): NodeDescription {
  if (isFragmentNode(node)) {
    return { icon: <CustomElementIcon size={12} />, label: 'Fragment' }; // i18n-ignore: the name of Astro's <Fragment> element, a code word.
  }
  switch (node.kind) {
    case 'text':
      return { icon: <TextIcon size={12} />, label: truncate(node.value, 34) };
    case 'comment':
      return { icon: <CommentIcon size={12} />, label: truncate(node.value.trim(), 30) };
    case 'raw':
      return { icon: <CodeIcon size={12} />, label: node.name };
    case 'raw-line':
      return { icon: <CodeIcon size={12} />, label: truncate(node.value, 30) };
    case 'element':
      return describeElement(node, live);
    case 'chunk-group':
      return { icon: <FileIcon size={12} />, label: node.name };
    case 'expr':
      return { icon: <CodeIcon size={12} />, label: truncate(node.value.replace(/\s+/g, ' '), 34) };
    case 'map': {
      const at = node.head.indexOf('.map');
      return {
        icon: <RepeatIcon size={12} />,
        label: at > 0 ? node.head.slice(0, at + 4) : truncate(node.head, 24),
      };
    }
    case 'cond':
      return { icon: <BranchIcon size={12} />, label: truncate(`if ${node.test}`, 40) };
    case 'branch':
      return { icon: <CornerIcon size={12} />, label: node.name === 'else' ? 'else' : 'then' };
    case 'component':
      return describeComponent(node, live);
  }
}

function describeElement(node: PairedNode, live?: readonly string[]) {
  return { icon: elementIcon(node.name), label: truncate(labelWithLive(node, live), 40) };
}

// The source's label, or the class the page rendered with when the source only has a tag.
function labelWithLive(node: PairedNode, live: readonly string[] | undefined): string {
  const source = elementLabel(node);
  const rendered = live?.[0];
  if (source !== node.name) {
    return source;
  }
  return rendered === undefined ? source : classLabel(rendered);
}

function describeComponent(node: PairedNode, live?: readonly string[]) {
  if (node.dynamicTag) {
    return { icon: <CustomElementIcon size={12} />, label: truncate(labelWithLive(node, live), 40) };
  }
  // Central icons snap to 12/16/20, so a requested 14 drew at 16 beside the 12px element icons. Rows use 12.
  if (node.astroAsset) {
    return { icon: astroAssetIcon(node.name, 12), label: node.name };
  }
  return { icon: <ElementComponentIcon size={12} />, label: node.name };
}

/** A label cut to `lengthMax` characters, ending in an ellipsis when cut. */
export function truncate(value: string, lengthMax: number): string {
  return value.length > lengthMax ? `${value.slice(0, lengthMax - 1)}…` : value;
}
