// Whether a rendered location writes the copy it shows, read from the parsed files the audit
// holds (shared/page/auditRendered.ts, CopyHolding). A node writes its copy when it has text or
// an expression of its own; it only passes copy on when it is a `<slot>`, a `<Fragment set:html>`
// of an expression (how a component re-emits a slot it rendered to a string and scrubbed), or an
// element or instance whose content is nothing but those. A placeholder found at a node that
// passes copy on belongs to the instance that gave it, never to the wrapper.
import { assert } from '../../../shared/core/assert';
import { nodeChildren, nodeProps } from '../../../shared/page/auditMarkup';
import type { CopyHolding } from '../../../shared/page/auditRendered';
import type { AuditFileInput } from '../../../shared/page/auditStatic';
import { nodeAt } from '../../../shared/page/auditTrace';
import type { PageNode } from '../../../shared/page/pageNode';

/** What the node at a location does with copy; undefined where the file is not read or the path leaves its tree. */
export function copyHolding(
  inputs: ReadonlyMap<string, Pick<AuditFileInput, 'nodes'>>,
): (place: { readonly file: string; readonly path: readonly number[] }) => CopyHolding | undefined {
  return (place) => {
    assert(place.path.length > 0, 'copyHolding: a location names a node');
    const file = inputs.get(place.file);
    const node = file === undefined ? undefined : nodeAt(file.nodes, place.path);
    return node === undefined ? undefined : holdingOf(node);
  };
}

/** A node's own holding: given when it passes content on, or holds nothing but nodes that do. */
export function holdingOf(node: PageNode): CopyHolding {
  if (passesContent(node)) {
    return 'given';
  }
  if (node.kind !== 'element' && node.kind !== 'component') {
    return 'own'; // Text and expressions are copy; a loop or a branch renders what it holds.
  }
  const children = nodeChildren(node);
  const writes = children.some((child) => child.kind === 'expr' || (child.kind === 'text' && child.value.trim().length > 0));
  if (writes) {
    return 'own';
  }
  const passing = children.filter(passesContent);
  assert(passing.length <= children.length, 'holdingOf: a subset of the children');
  return passing.length > 0 ? 'given' : 'own';
}

/** A `<slot>`, or a Fragment that `set:html`s an expression: it puts out what it was given. */
function passesContent(node: PageNode): boolean {
  if (node.kind !== 'element' && node.kind !== 'component') {
    return false;
  }
  if (node.name === 'slot') {
    return true;
  }
  const html = Object.entries(nodeProps(node) ?? {}).find(([key]) => key === 'set:html')?.[1];
  return node.name === 'Fragment' && html !== undefined && html.type === 'expr';
}
