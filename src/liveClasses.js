// Whether a node puts an element of its OWN on the page.
//
// `<Fragment>` and `<slot>` do not. They render what is inside them and nothing
// else, so no element on the page is theirs: nothing carries their name,
// nothing has their classes, nothing measures as them.
//
// The page can only answer about elements, and it answers by path — so asked
// what `<Fragment slot="column2">` rendered with, the canvas finds the element
// between its markers and hands back what it found. That element is the root
// `<div class="feature-image_wrap">` of the component the Fragment holds, and
// it answers to the Fragment's path on purpose: it is how a click inside the
// slot finds its way back to the node that put it there.
//
// So the canvas cannot tell them apart, and it should not have to. The model
// knows: a Fragment is a Fragment. Without that, the navigator labelled the
// Fragment's row `feature-image_wrap` and drew the component beneath it — a
// component's own root shown as a page element wrapping the component.

/** @param {{name?: string}|null|undefined} node */
export function rendersOwnElement(node) {
  if (!node) return false;
  return node.name !== 'Fragment' && node.name !== 'slot';
}

/**
 * What each node rendered with, keyed by node id — the map the navigator labels
 * its rows from, and the breadcrumb and the canvas chip after it.
 *
 * `classesByPath` is what the page reported; `prefix` is the open component's
 * namespace, or '' for a page.
 */
export function liveClassesById(classesByPath, nodes, prefix = '') {
  const byId = new Map();
  const walk = (list, trail) => {
    (list || []).forEach((node, i) => {
      const t = [...trail, i];
      const hit = classesByPath[prefix + t.join('.')];
      // Only for a node that put an element of its own there: what the page
      // reports for a Fragment is whatever the Fragment holds.
      if (hit && hit.length && rendersOwnElement(node)) byId.set(node.id, hit);
      if (Array.isArray(node.children)) walk(node.children, t);
    });
  };
  walk(nodes, []);
  return byId;
}

export default rendersOwnElement;
