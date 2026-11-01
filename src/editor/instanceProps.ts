import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { treeBudget, type TreeView } from './treeView';
import type { DataContext, TreeNode } from './dataSuggest';
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

import { dataTree } from './dataSuggest';
import { partsFromValue } from './bindings';

// Every path the page's data tree knows a value for, flattened. Sample nodes
// carry the value itself; a literal node carries what the source said.
function valuesByPath(context: DataContext, depthMax = 4): ReadonlyMap<string, unknown> {
  const out = new Map<string, unknown>();
  const visit = treeBudget();
  const walk = (nodes: readonly TreeNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'valuesByPath: depth limit');
    for (const node of nodes || []) {
      visit(depth);
      if (node.path && 'value' in node && node.value !== undefined) {
        out.set(node.path, node.value);
      } else if (node.path && node.preview !== undefined && node.preview !== '') {
        out.set(node.path, node.preview);
      }
      if (depth < depthMax && node.children !== undefined) {
        walk(node.children, depth + 1);
      }
    }
  };
  let nodes: readonly TreeNode[];
  try {
    nodes = dataTree(context);
  } catch {
    // A half-written page resolves to nothing; literals below still do.
    return out;
  }
  walk(nodes, 0);
  return out;
}

// A preview string as a value: sampled previews are quoted (`"BloomCraft"`),
// which is how they read in the picker but not what the prop holds.
const unquote = (value: unknown): unknown => (typeof value === 'string' && /^".*"$/.test(value) ? value.slice(1, -1) : value);

/**
 * The props an instance passes, resolved as far as the page can be read.
 * Returns an object of name → value, holding only the ones it is sure of.
 *
 * `context` is the page's own binding context at that instance — its
 * frontmatter, imports, the loops around it, and whatever samples the app has
 * for the collections it reads.
 */
export function resolveInstanceProps(node: TreeView | undefined, context: DataContext = {}): Readonly<Record<string, unknown>> | undefined {
  const props = node?.props;
  if (!props || typeof props !== 'object') {
    return undefined;
  }
  const known = valuesByPath(context);
  const out: Record<string, unknown> = {};

  for (const [name, prop] of Object.entries(props)) {
    if (!prop || name === 'class' || name.startsWith('class:')) {
      continue;
    }
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
    if (prop.type !== 'expr') {
      continue;
    }
    const source = String(prop.value ?? '').trim();
    if (!source) {
      continue;
    }
    // `cols={3}`, `overlap={true}` — a literal that happens to be written as
    // an expression, because that is how those are written.
    if (/^-?\d+(\.\d+)?$/.test(source)) {
      out[name] = Number(source);
      continue;
    }
    if (source === 'true' || source === 'false') {
      out[name] = source === 'true';
      continue;
    }
    if (source === 'null' || source === 'undefined') {
      continue;
    }

    const resolved = resolveInstanceExpression(source, known);
    if (resolved.ok) {
      out[name] = resolved.value;
    }
  }

  return Object.keys(out).length ? out : undefined;
}

export default resolveInstanceProps;

function resolveInstanceExpression(
  source: string,
  known: ReadonlyMap<string, unknown>,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  // Text and data mixed — a template literal, or a path on its own. Each
  // piece is resolved and the answer is what they spell out; one piece the
  // page can't answer for leaves the whole prop unsaid.
  //
  // `?.` is read as a plain `.` here. It says how a path is reached, not
  // which path it is, and the value it reaches is the same one — but the
  // chips split at it, so `featured?.data.title` would arrive in pieces
  // neither of which names anything.
  const parts = partsFromValue({ type: 'expr', value: source.replace(/\?\./g, '.') });
  if (!parts || !parts.length) {
    return { ok: false };
  }
  let text = '';
  // The value of a path on its own; the data it came from may hold a null.
  let whole: unknown;
  let ok = true;
  for (const part of parts) {
    if (part.text !== undefined) {
      text += part.text;
      continue;
    }
    if (part.expr === undefined || !known.has(part.expr)) {
      ok = false;
      break;
    }
    const value = unquote(known.get(part.expr));
    // A path on its own keeps its type: a number stays a number, an object
    // stays an object, so the picker can open it.
    if (parts.length === 1) {
      whole = value;
    } else {
      text += value === null || value === undefined ? '' : String(value);
    }
  }
  if (!ok) {
    return { ok: false };
  }
  if (parts.length === 1) {
    if (whole === null || whole === undefined) {
      return { ok: true, value: text };
    }
    return { ok: true, value: whole };
  }
  return { ok: true, value: text };
}
