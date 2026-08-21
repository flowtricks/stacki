// What a piece of a page reads from around it.
//
// Markup pulled out into a component leaves its scope behind. `{title}` in a
// page reads the page's `title`; in Card.astro it reads nothing at all, and the
// build stops on a name that isn't defined. The values it was reading are
// exactly the props the new component wants — `const { title } = Astro.props`
// on one side, `title={title}` on the other — and both ends can be written
// automatically, because the name at the instance site is the same name it
// already was.
//
// Only names actually IN SCOPE at the page count. An identifier that isn't one
// of them is a method, a global or a typo, and passing it as a prop would say
// it's a value the page has. And names bound INSIDE the piece are its own: a
// `.map()` that moves across takes its item with it.

import { parseDeclarations, scopeChips } from './dataSuggest.js';

// `data.map((item, index) => (` → its parts. Kept here rather than imported so
// this module stands alone; a loop head the app can't model contributes no
// bindings, which is the safe way to be wrong (a prop too many, never one too
// few).
function loopHead(head) {
  const m = String(head || '').match(
    /^([\s\S]*?)\.map\(\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*([A-Za-z_$][\w$]*)\s*)?\)\s*=>\s*\($/
  );
  return m ? { data: m[1].trim(), item: m[2], index: m[3] || '' } : null;
}

/** Every expression a node states in its OWN scope (its children may differ). */
function expressionsOf(node) {
  const out = [];
  for (const value of Object.values(node.props || {})) {
    if (value?.type === 'expr') out.push(String(value.value ?? ''));
  }
  if (node.kind === 'expr') out.push(String(node.value ?? ''));
  if (node.kind === 'cond') out.push(String(node.test ?? ''));
  // A loop's data is read outside the loop; its body runs inside it.
  if (node.kind === 'map') out.push(loopHead(node.head)?.data ?? String(node.head ?? ''));
  // `Some {count} words` — the holes in a text run are expressions too.
  if (node.kind === 'text' && String(node.value ?? '').includes('{')) {
    for (const m of String(node.value).matchAll(/\{([^{}]*)\}/g)) out.push(m[1]);
  }
  return out;
}

/**
 * The names in `scope` that this subtree reads — the props to give the
 * component it's about to become, in the order they're first read so the
 * destructure reads like the markup does.
 *
 * `scope` is what the page has at that point: its frontmatter declarations,
 * its imports, and the item of any loop the piece sits inside.
 */
export function propsForExtraction(node, scope) {
  const inScope = scope instanceof Set ? new Set(scope) : new Set(scope || []);
  if (!inScope.size || !node) return [];
  const found = [];
  const take = (text, shadowed) => {
    for (const chip of scopeChips(text, inScope)) {
      const root = chip.path.split('.')[0];
      if (shadowed.has(root) || found.includes(root)) continue;
      found.push(root);
    }
  };

  const walk = (n, shadowed) => {
    if (!n || typeof n !== 'object') return;
    for (const text of expressionsOf(n)) take(text, shadowed);
    let inner = shadowed;
    if (n.kind === 'map') {
      // The item and index belong to this loop, and so does anything its body
      // declares — all of it travels with the markup.
      const head = loopHead(n.head);
      const bound = [head?.item, head?.index].filter(Boolean);
      const body = Array.isArray(n.body) ? n.body.join('\n') : '';
      const declared = body ? [...parseDeclarations(body).keys()] : [];
      // A loop's own body lines read from OUTSIDE it (that's how it gets data).
      for (const line of Array.isArray(n.body) ? n.body : []) {
        take(line, new Set([...shadowed, ...bound]));
      }
      if (bound.length || declared.length) inner = new Set([...shadowed, ...bound, ...declared]);
    }
    for (const child of n.children || []) walk(child, inner);
  };

  walk(node, new Set());
  return found;
}

/** The frontmatter line a component with these props opens with. */
export function propsDestructure(props) {
  const names = (props || []).filter(Boolean);
  if (!names.length) return '';
  return `const { ${names.join(', ')} } = Astro.props;`;
}
