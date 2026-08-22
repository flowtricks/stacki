import { canContainTag, VOID_TAGS } from './elementSchemas.js';

// Where a new node goes: inside the selection when it accepts children,
// otherwise right after it; with no selection, at the end of the page.
//
// Lives here rather than in App.jsx because the rule is the whole answer to a
// question users ask constantly — "why did that land NEXT to the section
// instead of in it?" — and the answer turns on things no glance at the panel
// can confirm: what a component renders as, and whether it takes default slot
// content at all. A component that reads its slot itself rather than writing
// `<slot />` was reported as taking none, and every insert with one selected
// landed beside it.

/**
 * What a component renders as. Fixed for most (`<Section>` is a `<section>`);
 * decided by a prop for the ones that take a `tag` (`<Heading tag="h1">`), in
 * which case an instance's own value wins over the component's default.
 * Null when it can't be told — several possible tags, or no root element.
 */
export function tagOfComponent(comp, node) {
  const rt = comp?.renderTag;
  if (!rt) return null;
  if (rt.prop && node) {
    const set = node.props?.[rt.prop];
    const v = set && set.type !== 'expr' ? String(set.value || '') : '';
    if (v) return v.toLowerCase();
  }
  return rt.tag || null;
}

const findNode = (nodes, id) => {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (Array.isArray(node.children)) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
};

const findParentOf = (nodes, id, parentId = null) => {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.id === id) return { parentId, index: i };
    if (Array.isArray(n.children)) {
      const r = findParentOf(n.children, id, n.id);
      if (r) return r;
    }
  }
  return null;
};

/** Whether `n` can hold `childTag` (null when the tag can't be told). */
export function acceptsChildren(n, childTag, insertables) {
  if (n.id === 'layout') return true;
  if (n.kind === 'element') {
    const tag = String(n.name).toLowerCase();
    if (VOID_TAGS.has(tag)) return false;
    // A <p> inside an <h1> is invalid HTML the browser would reparent —
    // insert alongside instead of inside.
    return childTag ? canContainTag(tag, childTag) : true;
  }
  // A condition holds nothing itself — its branches do.
  if (n.kind === 'map' || n.kind === 'chunk-group' || n.kind === 'branch') return true;
  if (n.kind === 'component') {
    const comp = (insertables || []).find((c) => c.name === n.name);
    if (!(comp?.slots || []).includes('default')) return false;
    // …and what it renders as still has to be able to hold the child.
    const tag = tagOfComponent(comp, n);
    return tag && childTag ? canContainTag(tag, childTag) : true;
  }
  return false;
}

export function insertTargetFor(model, selId, item, insertables) {
  // The tag being inserted. A component counts too: <Paragraph> renders a
  // <p>, and a <p> is no more allowed inside a heading for being wrapped
  // in a component. Unknown when the tag depends on values only the page
  // knows (`const Tag = isLink ? "a" : "button"`), and unknown means
  // allowed — a wrong refusal is worse than a wrong nesting.
  const childTag =
    item && item.type === 'element'
      ? item.tag
      : item && item.type === 'component'
        ? tagOfComponent((insertables || []).find((c) => c.name === item.name))
        : null;
  const accepts = (n) => acceptsChildren(n, childTag, insertables);
  if (selId && selId !== 'frontmatter') {
    const sel = findNode(model.nodes, selId);
    if (sel && accepts(sel)) {
      return { parentId: sel.id, index: Array.isArray(sel.children) ? sel.children.length : 0 };
    }
    // Otherwise drop in as a sibling — climbing out of any ancestor that
    // can't legally hold it either (a <div> next to a <span> inside a <p>
    // still isn't valid, so it lands after the <p>).
    let childId = selId;
    for (let depth = 0; depth < 50; depth++) {
      const fp = findParentOf(model.nodes, childId);
      if (!fp) break;
      if (fp.parentId === null) return { parentId: null, index: fp.index + 1 };
      const parent = findNode(model.nodes, fp.parentId);
      if (!parent || accepts(parent)) {
        return { parentId: fp.parentId, index: fp.index + 1 };
      }
      childId = fp.parentId;
    }
  }
  return { parentId: null, index: model.nodes.length };
}
