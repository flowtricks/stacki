// What a click selects, the way Figma picks layers: a click selects at the level of what is selected now (its
// siblings, or the top-level sections when nothing is), a double click goes one level in, and Cmd/Ctrl-click
// goes straight to the deepest element under the pointer. A wrapper drawn exactly over its parent or its only
// child is passed through, so a page's layout wrappers never stand between a click and the section it meant.
import { DESIGN_LIMITS } from './designTypes';

export type PickDepth = 'level' | 'deepest';

/** The element and its ancestors up to the body, outermost first. */
export function chainOf(target: Element): readonly Element[] {
  const chain: Element[] = [];
  for (let element: Element | undefined = target; element !== undefined; element = element.parentElement ?? undefined) {
    if (element.tagName === 'HTML') {
      break;
    }
    chain.unshift(element);
    if (chain.length > DESIGN_LIMITS.elementsMax) {
      throw new Error('Assertion failed: chainOf: an element chain is within the element bound');
    }
  }
  return chain;
}

function sameBox(first: Element, second: Element): boolean {
  const outer = first.getBoundingClientRect();
  const inner = second.getBoundingClientRect();
  return (
    Math.abs(outer.left - inner.left) < 1 &&
    Math.abs(outer.top - inner.top) < 1 &&
    Math.abs(outer.width - inner.width) < 1 &&
    Math.abs(outer.height - inner.height) < 1
  );
}

/** From `index` in `chain`, past every element drawn exactly where the one before it is. */
function passWrappers(chain: readonly Element[], index: number): number {
  let at = index;
  while (at + 1 < chain.length) {
    const current = chain[at];
    const inner = chain[at + 1];
    const outer = chain[at - 1];
    if (current === undefined || inner === undefined) {
      break;
    }
    const overParent = outer !== undefined && sameBox(current, outer);
    const overChild = current.childElementCount === 1 && sameBox(current, inner);
    if (overParent || overChild) {
      at += 1;
    } else {
      break;
    }
  }
  return at;
}

/** What a click on `target` selects, given what is selected now. */
export function pickOnClick(target: Element, selection: readonly Element[], depth: PickDepth): Element {
  const chain = chainOf(target);
  if (chain.length === 0) {
    throw new Error('Assertion failed: pickOnClick: a target inside a body');
  }
  if (depth === 'deepest' || chain.length === 1) {
    return target;
  }
  const selectedInChain = chain.findIndex((element) => selection.includes(element));
  if (selectedInChain >= 0) {
    return chain[selectedInChain] ?? target;
  }
  // The deepest ancestor of the selection that holds the target: the click picks among its children.
  let scope = 0;
  for (const selected of selection) {
    for (let parent = selected.parentElement; parent !== null; parent = parent.parentElement) {
      const index = chain.indexOf(parent);
      if (index >= 0) {
        scope = Math.max(scope, index);
        break;
      }
    }
  }
  const picked = chain[passWrappers(chain, Math.min(scope + 1, chain.length - 1))];
  return picked ?? target;
}

/** What a double click on `target` selects: one level into the selection, toward the target. */
export function pickOnDoubleClick(target: Element, selection: readonly Element[]): Element {
  const chain = chainOf(target);
  const selectedInChain = chain.findIndex((element) => selection.includes(element));
  if (selectedInChain < 0) {
    return pickOnClick(target, selection, 'level');
  }
  if (selectedInChain === chain.length - 1) {
    return target;
  }
  return chain[passWrappers(chain, selectedInChain + 1)] ?? target;
}

/** Elements a selection can hold: never the document's root, its head or a body-less node. */
export function isSelectable(element: Element): boolean {
  const tag = element.tagName;
  return tag !== 'HTML' && tag !== 'HEAD' && tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'LINK' && tag !== 'META' && tag !== 'BASE';
}
