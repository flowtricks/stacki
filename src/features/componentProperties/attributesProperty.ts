// The component's attributes prop as the Properties panel lists it: Astro's
// rest props (`...rest` in the props destructure, propDeclaration.ts), with
// its tooltip from the `@attributes` tag above `interface Props`, and the
// elements that spread it, read from the open component's page model. An
// element's defaults are the attributes written before its spread
// (attributesBinding.ts); with several connected elements the panel edits
// them together, so it reports whether they already agree.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr } from '../../../shared/page/pageNode';
import { readAttributesBinding } from '../../editor/attributesBinding';
import type { EditorNode } from '../../editor/pageView';
import { readRestBinding, restTooltip, type AttributeDefault } from '../../editor/propDeclaration';

/** One element that spreads the attributes prop. */
export interface AttributesConnection {
  readonly id: string;
  readonly tag: string;
  /** The tag and its first class, as the navigator shows an element: `a.button`. */
  readonly label: string;
  readonly props: Readonly<Record<string, Attr>>;
  readonly defaults: readonly AttributeDefault[];
}

/** The attributes prop, when the component has one. */
export interface AttributesProperty {
  readonly local: string;
  readonly tooltip: string;
  readonly connections: readonly AttributesConnection[];
}

/** The component's attributes prop and the elements connected to it, or undefined without `...rest`. */
export function readAttributesProperty(frontmatter: string, nodes: readonly EditorNode[] | undefined): AttributesProperty | undefined {
  const rest = readRestBinding(frontmatter);
  if (rest === undefined) {
    return undefined;
  }
  assert(/^[A-Za-z_$][\w$]*$/.test(rest.local), 'readAttributesProperty: a rest binding is an identifier');
  const connections: AttributesConnection[] = [];
  // Iterative and bounded: the page model is at most treeNodesMax nodes.
  const pending: EditorNode[] = [...(nodes ?? [])].reverse();
  for (let visited = 0; pending.length > 0; visited += 1) {
    assert(visited <= LIMITS.treeNodesMax, 'readAttributesProperty: the page model is bounded');
    const node = pending.pop();
    assert(node !== undefined, 'readAttributesProperty: a pending node exists');
    const binding = node.kind === 'element' ? readAttributesBinding(node.props, rest.local) : undefined;
    if (binding !== undefined && node.props !== undefined) {
      connections.push({ id: node.id, tag: node.name ?? '', label: elementLabel(node), props: node.props, defaults: binding.defaults });
    }
    for (const child of [...(node.children ?? [])].reverse()) {
      pending.push(child);
    }
  }
  return { local: rest.local, tooltip: restTooltip(frontmatter), connections };
}

/** Whether every connected element has the same defaults, in the same order. */
export function defaultsAgree(connections: readonly AttributesConnection[]): boolean {
  const first = connections[0];
  if (first === undefined) {
    return true;
  }
  return connections.every((connection) => sameDefaults(connection.defaults, first.defaults));
}

/** Whether two default lists name the same attributes with the same values, in order. */
export function sameDefaults(left: readonly AttributeDefault[], right: readonly AttributeDefault[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => entry.name === right[index]?.name && entry.value === right[index]?.value);
}

function elementLabel(node: EditorNode): string {
  const tag = node.name ?? 'element';
  const classValue = node.props?.['class'];
  const first = classValue?.type === 'string' ? classValue.value.trim().split(/\s+/)[0] : undefined;
  return first === undefined || first === '' ? tag : `${tag}.${first}`;
}
