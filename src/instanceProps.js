// What a component is being given, where it is being edited.
//
// Open a component from an instance on the page and the panel knows its props
// by NAME — `heading`, `href`, `image` — and by type, because the file says
// `interface Props`. It knew nothing about their values, so a field showing
// `{heading}` could not say what heading was, and the data picker offered a
// list of identifiers against a card that plainly read "BloomCraft".
//
// The instance is where the answer is. `<LinkCard heading={project.data.title}
// href={`/portfolio/${project.id}`} variant="cover" />` says exactly what each
// prop is given; the page's own scope says what those expressions come to. A
// literal answers for itself, a path is looked up in the data the page is
// showing, and anything this can't work out is left out rather than guessed —
// a wrong value is worse than none, because it reads as fact.

import { dataTree } from './dataSuggest.js';
import { partsFromValue } from './bindings.js';

// Every path the page's data tree knows a value for, flattened. Sample nodes
// carry the value itself; a literal node carries what the source said.
function valuesByPath(context, depth = 4) {
  const out = new Map();
  const walk = (nodes, level) => {
    for (const node of nodes || []) {
      if (node.path && node.value !== undefined) out.set(node.path, node.value);
      else if (node.path && node.preview !== undefined && node.preview !== '') {
        out.set(node.path, node.preview);
      }
      if (level < depth && Array.isArray(node.children)) walk(node.children, level + 1);
    }
  };
  try {
    walk(dataTree(context), 0);
  } catch {
    /* a half-written page resolves to nothing; the literals below still do */
  }
  return out;
}

// A preview string as a value: sampled previews are quoted (`"BloomCraft"`),
// which is how they read in the picker but not what the prop holds.
const unquote = (v) =>
  typeof v === 'string' && /^".*"$/.test(v) ? v.slice(1, -1) : v;

/**
 * The props an instance passes, resolved as far as the page can be read.
 * Returns an object of name → value, holding only the ones it is sure of.
 *
 * `context` is the page's own binding context at that instance — its
 * frontmatter, imports, the loops around it, and whatever samples the app has
 * for the collections it reads.
 */
export function resolveInstanceProps(node, context = {}) {
  const props = node?.props;
  if (!props || typeof props !== 'object') return null;
  const known = valuesByPath(context);
  const out = {};

  for (const [name, prop] of Object.entries(props)) {
    if (!prop || name === 'class' || name.startsWith('class:')) continue;
    // Written as text: `variant="cover"` is its own answer.
    if (prop.type === 'string') {
      out[name] = prop.value;
      continue;
    }
    // `render` with no value is `render` — an attribute standing for true.
    if (prop.type === 'bare') {
      out[name] = true;
      continue;
    }
    if (prop.type !== 'expr') continue;
    const src = String(prop.value ?? '').trim();
    if (!src) continue;
    // `cols={3}`, `overlap={true}` — a literal that happens to be written as
    // an expression, because that is how those are written.
    if (/^-?\d+(\.\d+)?$/.test(src)) { out[name] = Number(src); continue; }
    if (src === 'true' || src === 'false') { out[name] = src === 'true'; continue; }
    if (src === 'null' || src === 'undefined') continue;

    // Text and data mixed — a template literal, or a path on its own. Each
    // piece is resolved and the answer is what they spell out; one piece the
    // page can't answer for leaves the whole prop unsaid.
    //
    // `?.` is read as a plain `.` here. It says how a path is reached, not
    // which path it is, and the value it reaches is the same one — but the
    // chips split at it, so `featured?.data.title` would arrive in pieces
    // neither of which names anything.
    const parts = partsFromValue({ type: 'expr', value: src.replace(/\?\./g, '.') });
    if (!parts || !parts.length) continue;
    let text = '';
    let whole = null;
    let ok = true;
    for (const part of parts) {
      if (part.text !== undefined) {
        text += part.text;
        continue;
      }
      if (!known.has(part.expr)) { ok = false; break }
      const value = unquote(known.get(part.expr));
      // A path on its own keeps its type: a number stays a number, an object
      // stays an object, so the picker can open it.
      if (parts.length === 1) whole = value;
      else text += value == null ? '' : String(value);
    }
    if (!ok) continue;
    out[name] = parts.length === 1 && whole !== null ? whole : text;
  }

  return Object.keys(out).length ? out : null;
}

export default resolveInstanceProps;
