// Heuristic static analysis powering the loop "Data" suggestions: top-level
// frontmatter declarations and imports, ancestor loop variables, and — by
// reading object literals — the keys nested inside them, so `service`
// suggests `service.tags` without executing any code.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { toRecord, toArray } from '../../shared/core/record';
import {
  DATA_SUGGEST_LIMITS,
  parseDeclarations,
  type ImportLike,
  mayHoldData,
  type Destructure,
  parseDestructures,
  looksCallable,
  collectionCallIn,
  referenceCallIn,
} from './dataSource';
import { sampleAt, sampleKey, type TreeNode, sampleNode, literalNode } from './dataSample';
import {
  queriesInScope,
  namesInScope,
  type DataContext,
  type SchemaField,
  autoQueryName,
} from './dataScope';
export {
  QUERY_MARK,
  type MarkedQuery,
  markedQueries,
  removeMarkedQuery,
  queriesInScope,
  namesInScope,
  type DataContext,
  type SchemaField,
  type ScopeChip,
  scopeChips,
  autoQueryName,
  collectionsInScope,
  type ImportedCall,
  importedCallsInScope,
} from './dataScope';

export {
  sampleAt,
  sampleKey,
  type ReferenceNeed,
  referencesInScope,
  sampleKind,
  samplePreview,
  type TreeNode,
} from './dataSample';

export {
  parseDeclarations,
  type DeclarationSpan,
  findDeclaration,
  findImportOf,
  firstObjectIn,
  type ObjectEntry,
  objectEntries,
  type Destructure,
  parseDestructures,
  collectionCallIn,
  referenceCallIn,
} from './dataSource';

const MAP_HEAD_RE = /^([\s\S]+?)\.map\(\s*\(\s*([\w$]+)\s*(?:,\s*([\w$]+)\s*)?\)\s*=>\s*\($/;

/**
 * The names an expression field can offer while it is typed, for the scope it
 * sits in: this file's props, its frontmatter values, the item of any loop
 * around it — the same things the data picker lists, flattened into labels and
 * carrying their preview as the note beside each one.
 *
 * Frontmatter names the tree leaves out (functions, imported components) come
 * after them: the picker can't offer those because they aren't data, but a
 * condition or an expression is free to name any of them.
 */
export function scopeCompletions(context: DataContext = {}): { label: string; detail: string }[] {
  const out: { label: string; detail: string }[] = [];
  const seen = new Set<string>();
  const add = (label: string | undefined, detail: string): void => {
    if (!label || seen.has(label)) {
      return;
    }
    seen.add(label);
    out.push({ label, detail });
  };
  const walk = (nodes: readonly TreeNode[] | undefined, depth: number): void => {
    for (const node of nodes ?? []) {
      add(node.path, node.preview ? String(node.preview).slice(0, 40) : (node.section ?? ''));
      if (depth < DATA_SUGGEST_LIMITS.completionDepthMax && Array.isArray(node.children)) {
        walk(node.children, depth + 1);
      }
    }
  };
  try {
    walk(dataTree(context), 0);
  } catch {
    /* a half-written frontmatter parses to nothing; the names below still do */
  }
  for (const name of namesInScope(context.frontmatter ?? '', context.imports ?? [])) {
    add(name, 'frontmatter');
  }
  return out;
}

// `const { Content, headings } = await render(post)` — made while the page
// renders, so there is nothing to sample. The shape is Astro's own and fixed,
// and the field names are the point: a table of contents is built out of
// heading.depth and heading.slug. Names and types only; no invented values.
const RENDER_SHAPE: Record<string, readonly { key: string; kind: string }[]> = {
  headings: [
    { key: 'depth', kind: 'number' },
    { key: 'slug', kind: 'text' },
    { key: 'text', kind: 'text' },
  ],
};

function shapeNode(name: string, fields: readonly { key: string; kind: string }[]): TreeNode {
  const item: TreeNode = {
    path: `${name}[0]`,
    key: '0',
    kind: 'object',
    preview: '',
    children: fields.map((field) => ({
      path: `${name}[0].${field.key}`,
      key: field.key,
      kind: field.kind,
      preview: '',
      children: undefined,
    })),
  };
  return { path: name, key: name, kind: 'list', preview: '', children: [item] };
}

// `const toc = headings.filter(h => h.depth < 4)` — fewer of the same thing.
// Whatever `headings` turned out to be, `toc` is that too, so the fields under
// one belong under the other.
// The pattern is assembled from two literal pieces only to fit the line width; each piece is a
// complete regular expression on its own, and the joined source is the original pattern.
const KEEPS_SHAPE = new RegExp(
  /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*/.source +
    /(filter|slice|sort|reverse|concat|toSorted|toReversed|flat)\s*\(/.source,
  '',
);

// `const featured = portfolio.find(…) ?? portfolio[0]` — ONE of the same thing.
// The picker knew `portfolio` was a list of entries and could open it, and knew
// nothing at all about `featured`: it offered it as a bare value with no fields
// under it, so the one entry the page is actually built around was the one
// thing you couldn't pick a title out of.
const PICKS_ONE =
  /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:\.\s*(?:find|at|pop|shift)\s*\(|\[\s*\d+\s*\])/;

function addUnique(list: TreeNode[], node: TreeNode | undefined, seen: Set<string>): void {
  if (!node || seen.has(node.path)) {
    return;
  }
  seen.add(node.path);
  list.push(node);
}

// What a prop's declared type says one of these is made of. A component has
// no entry on the canvas to read real values from, so its own `interface
// Props` is the only description of its data there is — and a loop over
// `times?: ServiceTime[]` offered nothing at all without it.
function shapeChildren(field: SchemaField | undefined, base: string): TreeNode[] | undefined {
  if (!field?.shape?.length) {
    return undefined;
  }
  const shape = field.shape;
  const fields = (at: string): TreeNode[] =>
    shape.map((field) => ({
      path: `${at}.${field.name}`,
      key: field.name,
      kind: field.type === 'code' ? 'value' : (field.type ?? 'value'),
      preview: '',
      children: undefined,
    }));
  // A list is written the way a sample of one is, so everything downstream —
  // the loop item's fields, the picker's own walk — reads it the same way.
  return field.shapeIsList
    ? [
        {
          path: `${base}[0]`,
          key: '0',
          kind: 'object',
          preview: '',
          children: fields(`${base}[0]`),
        },
      ]
    : fields(base);
}

// 1. This file's own props. Real values when the canvas is showing an entry
//    that carries them; the declared type otherwise.
function buildPropNodes(
  destructures: readonly Destructure[],
  schema: readonly SchemaField[],
  sample: unknown,
  seen: Set<string>,
): TreeNode[] {
  const props: TreeNode[] = [];
  const sampleRecord = toRecord(sample);
  const known = (name: string): boolean =>
    sampleRecord !== undefined && Object.prototype.hasOwnProperty.call(sample, name);
  for (const destructure of destructures) {
    if (!/^Astro\.props\b/.test(destructure.from)) {
      continue;
    }
    if (known(destructure.name) && sampleRecord) {
      addUnique(
        props,
        sampleNode(destructure.name, destructure.name, sampleRecord[destructure.name], 0),
        seen,
      );
      continue;
    }
    const field = schema.find((field) => field.name === destructure.name);
    const shape = shapeChildren(field, destructure.name);
    addUnique(
      props,
      {
        path: destructure.name,
        key: destructure.name,
        kind:
          shape && field?.shapeIsList
            ? 'list'
            : destructure.kind === 'rest'
              ? 'rest props'
              : field?.type || destructure.kind || 'prop',
        preview: field?.default !== undefined ? String(field.default) : '',
        children: shape,
      },
      seen,
    );
  }
  // A prop the file declares but destructures elsewhere (or reads off
  // Astro.props directly) is still a prop of this file.
  for (const field of schema) {
    if (seen.has(field.name)) {
      continue;
    }
    addUnique(
      props,
      known(field.name) && sampleRecord
        ? sampleNode(field.name, field.name, sampleRecord[field.name], 0)
        : {
            path: field.name,
            key: field.name,
            kind: field.shape && field.shapeIsList ? 'list' : field.type || 'prop',
            preview: field.default !== undefined ? String(field.default) : '',
            children: shapeChildren(field, field.name),
          },
      seen,
    );
  }
  return props;
}

// A reference followed through the data: `getEntry(post.data.author)` is this
// post's author, so the fields shown are that author's. Undefined when the
// declaration follows no reference the samples resolve.
function referenceNode(
  name: string,
  value: string,
  samples: Record<string, unknown>,
  sample: unknown,
): TreeNode | undefined {
  const ref = referenceCallIn(value);
  if (ref === undefined) {
    return undefined;
  }
  const at = sampleAt(sample, ref.path);
  const targetList = toArray(at);
  const target = targetList
    ? targetList.find((candidate) => toRecord(candidate)?.['collection'])
    : at;
  const targetRecord = toRecord(target);
  const targetCollection = targetRecord?.['collection'];
  const targetId = targetRecord?.['id'];
  if (typeof targetCollection !== 'string') {
    return undefined;
  }
  const resolved =
    samples[sampleKey(targetCollection, typeof targetId === 'string' ? targetId : undefined)];
  if (!resolved) {
    return undefined;
  }
  const many = ref.fn === 'getEntries';
  const node = sampleNode(name, name, many ? [resolved] : resolved, 0);
  node.preview = `${targetCollection} ${many ? 'entries' : 'entry'}`;
  return node;
}

// 2. The frontmatter's own values, and one level of any object literal.
function buildValueNodes(
  decls: ReadonlyMap<string, string>,
  destructures: readonly Destructure[],
  imports: readonly ImportLike[],
  samples: Record<string, unknown>,
  sample: unknown,
  seen: Set<string>,
  valueSamples: Record<string, unknown> = {},
): TreeNode[] {
  const values: TreeNode[] = [];
  for (const [name, value] of decls) {
    if (looksCallable(value)) {
      continue; // getStaticPaths and friends are code, not data
    }
    // What a call to an import returned, as the dev server ran it: a CMS
    // query's real entries, with every field they carry.
    const returned = valueSamples[name];
    if (returned !== undefined && returned !== null) {
      addUnique(values, sampleNode(name, name, returned, 0), seen);
      continue;
    }
    // A collection read by name gets the real thing: one entry, sampled, with
    // the query's own shape around it — `getCollection` hands back a list.
    const call = collectionCallIn(value);
    const entry = call ? samples[call.name] : undefined;
    if (call && entry) {
      const many = call.fn !== 'getEntry';
      const node = sampleNode(name, name, many ? [entry] : entry, 0);
      // "blog entries", not "1 item" — the sample is one of them, not all.
      node.preview = `${call.name} ${many ? 'entries' : 'entry'}`;
      addUnique(values, node, seen);
      continue;
    }
    const referenced = referenceNode(name, value, samples, sample);
    if (referenced !== undefined) {
      addUnique(values, referenced, seen);
      continue;
    }
    addUnique(values, literalNode(name, name, value, 0), seen);
  }
  for (const destructure of destructures) {
    if (/^Astro\.props\b/.test(destructure.from)) {
      continue;
    }
    const shape = /\brender\s*\(/.test(destructure.from)
      ? RENDER_SHAPE[destructure.name]
      : undefined;
    addUnique(
      values,
      shape
        ? shapeNode(destructure.name, shape)
        : {
            path: destructure.name,
            key: destructure.name,
            kind: destructure.kind || 'value',
            preview: '',
            children: undefined,
          },
      seen,
    );
  }
  addImportNodes(values, decls, imports, seen);
  return values;
}

// The imports that may hold data, for a value read straight from one.
function addImportNodes(
  values: TreeNode[],
  decls: ReadonlyMap<string, string>,
  imports: readonly ImportLike[],
  seen: Set<string>,
): void {
  for (const imp of imports) {
    if (imp.name === undefined || decls.has(imp.name)) {
      continue;
    }
    if (!mayHoldData(imp)) {
      continue;
    }
    addUnique(
      values,
      { path: imp.name, key: imp.name, kind: 'import', preview: '', children: undefined },
      seen,
    );
  }
}

// A value that is another value narrowed — `headings.filter(…)` — gets that
// value's fields. Done after everything else is in, so it doesn't matter
// which was declared first. Returns new lists; a value derived from one
// derived earlier sees the fields it was given (the lookup is updated as it
// goes, in declaration order).
function withDerivedShapes(
  decls: ReadonlyMap<string, string>,
  props: readonly TreeNode[],
  values: readonly TreeNode[],
): { readonly props: TreeNode[]; readonly values: TreeNode[] } {
  const byName = new Map<string, TreeNode>();
  // By identity: a prop and a value may share a path.
  const replaced = new Map<TreeNode, TreeNode>();
  for (const node of [...props, ...values]) {
    byName.set(node.path, node);
  }
  for (const [name, value] of decls) {
    const node = byName.get(name);
    if (!node || node.children) {
      continue;
    }
    const shaped = derivedShape(node, String(value).trim(), byName);
    if (shaped !== undefined) {
      byName.set(name, shaped);
      replaced.set(node, shaped);
    }
  }
  const latest = (node: TreeNode): TreeNode => replaced.get(node) ?? node;
  const derived = { props: props.map(latest), values: values.map(latest) };
  assert(derived.props.length === props.length, 'Deriving shapes keeps every prop');
  assert(derived.values.length === values.length, 'Deriving shapes keeps every value');
  return derived;
}

// The fields `node` takes from the value its declaration narrows or picks
// from, or undefined when it reads no known shape.
function derivedShape(
  node: TreeNode,
  declaration: string,
  byName: ReadonlyMap<string, TreeNode>,
): TreeNode | undefined {
  const name = node.path;
  const match = declaration.match(KEEPS_SHAPE);
  const baseName = match?.[1];
  const base = baseName !== undefined ? byName.get(baseName) : undefined;
  if (base?.children) {
    const children = rebase(base.children, base.path, name);
    return { ...node, kind: base.kind, preview: base.preview, children };
  }
  // One OF a list is one of whatever the list holds, so the fields to show
  // are the item's — `featured` opens onto the same fields as `portfolio`'s
  // first entry, because that is what it is.
  const one = declaration.match(PICKS_ONE);
  const oneName = one?.[1];
  const from = oneName !== undefined ? byName.get(oneName) : undefined;
  const item = from?.kind === 'list' && from.children?.length === 1 ? from.children[0] : undefined;
  if (!item?.children) {
    return undefined;
  }
  // "portfolio entries" describes the list; this is one of them.
  const preview = /\bentries$/.test(from?.preview ?? '')
    ? (from?.preview ?? '').replace(/\bentries$/, 'entry')
    : item.preview || '';
  return { ...node, kind: item.kind, preview, children: rebase(item.children, item.path, name) };
}

// 4. Every other collection in the project, whether or not this page reads
//    one. Data anywhere in the site is reachable from here: picking from one
//    of these writes the query that fetches it, and the path is then an
//    ordinary binding like any other.
function buildCollectionNodes(
  collections: readonly { readonly name: string; readonly count?: number }[],
  fm: string,
  imports: readonly ImportLike[],
  samples: Record<string, unknown>,
  seen: Set<string>,
): TreeNode[] {
  const out: TreeNode[] = [];
  const queried = queriesInScope(fm);
  const taken = namesInScope(fm, imports);
  for (const collection of collections) {
    if (queried.has(collection.name)) {
      continue; // already read here, so it is above
    }
    const identifier = autoQueryName(collection.name, taken);
    taken.add(identifier);
    const entry = samples[collection.name];
    const node: TreeNode = entry
      ? sampleNode(identifier, collection.name, [entry], 0)
      : { path: identifier, key: collection.name, kind: 'list', preview: '', children: undefined };
    node.key = collection.name;
    node.preview = collection.count === undefined ? 'collection' : `${collection.count} entries`;
    node.section = 'collections';
    // What picking anything under this node has to write first.
    node.query = { collection: collection.name, name: identifier };
    // Nothing fetched yet: the picker asks for it when this row is opened,
    // rather than the app loading every collection in the project up front.
    node.lazy = !entry;
    addUnique(out, node, seen);
  }
  return out;
}

// Every field any entry in a list has, each shown with a value from the entry
// being looked at — `at`, which the item's own arrows step — and from whichever
// other entry has it when that one doesn't. A field the first entry left out is
// still a field of the item; a value from another entry is better than a blank
// row; and which entry you are reading is a thing you can move.
function everyField(entries: readonly TreeNode[] | undefined, at = 0): TreeNode[] | undefined {
  const first = entries?.[0];
  if (!first) {
    return undefined;
  }
  const out: TreeNode[] = [];
  const seenKeys = new Set<string>();
  // The entry being read leads, in its own order, so stepping to it shows what
  // it holds rather than what the first one holds.
  const chosen = entries[at];
  const order = chosen !== undefined && at !== 0 ? [chosen, ...entries] : entries;
  for (const entry of order) {
    // Written as a field of the FIRST entry, whatever entry it came from —
    // the whole branch, not just its top: the tree is rebased onto the loop's
    // item name from there, and a path through `[3]` would name one particular
    // service rather than the item.
    const home = entries[at] ?? first;
    const kids =
      entry === home
        ? (entry.children ?? [])
        : (rebase(entry.children, entry.path, home.path) ?? []);
    for (const child of kids) {
      if (seenKeys.has(child.key)) {
        continue;
      }
      seenKeys.add(child.key);
      out.push(child);
    }
  }
  return out.length ? out : undefined;
}

// 3. Loop items, resolved against everything above: an enclosing
//    `posts.map((post) => …)` hands `post` one element of `posts`, so the
//    item shows that element's fields with its values.
function buildLoopNodes(
  ancestorHeads: readonly string[],
  props: readonly TreeNode[],
  values: readonly TreeNode[],
  itemIndex: Record<string, number> | undefined,
  seen: Set<string>,
): TreeNode[] {
  const byPath = new Map<string, TreeNode>();
  const index = (list: readonly TreeNode[], depth: number): void => {
    assert(depth <= LIMITS.treeDepthMax, 'Data tree exceeds depth limit');
    for (const node of list) {
      byPath.set(node.path, node);
      if (node.children) {
        index(node.children, depth + 1);
      }
    }
  };
  index(props, 0);
  index(values, 0);

  // Innermost first: the loop you are standing in is the one whose item you
  // are most likely reaching for, and an outer loop is further away in every
  // sense.
  const loops: TreeNode[] = [];
  for (const head of [...ancestorHeads].reverse()) {
    const match = String(head).trim().match(MAP_HEAD_RE);
    const sourceName = match?.[1];
    const item = match?.[2];
    if (!match || sourceName === undefined || item === undefined) {
      continue;
    }
    const source = byPath.get(sourceName.trim());
    const first = source?.kind === 'list' ? source.children?.[0] : undefined;
    // Which entry of the list the item is being read as. One list, one place
    // in it — the arrows on the row move it (see `nav` below).
    const entries = source?.kind === 'list' ? (source.children ?? []) : [];
    const at = Math.min(Math.max(itemIndex?.[item] ?? 0, 0), Math.max(entries.length - 1, 0));
    const shown = entries[at] ?? first;
    addUnique(
      loops,
      {
        path: item,
        key: item,
        kind: first ? first.kind : 'loop item',
        preview: shown ? shown.preview : '',
        // What the arrows on this row say, and what they have to step through.
        // Only when there is more than one entry to look at: a list of one, or a
        // shape with no values behind it at all, has nowhere to go.
        ...(entries.length > 1 ? { nav: { index: at, count: entries.length } } : {}),
        // Re-rooted onto the item's name: `posts[0].title` is `post.title` here.
        // Every entry contributes: a field the first one happens not to have — a
        // campus on one service and not another — is still a field of the item,
        // and leaving it out meant typing `service.campus` from memory to reach
        // a value the picker was already holding.
        children: shown ? rebase(everyField(entries, at), shown.path, item) : undefined,
      },
      seen,
    );
    const indexName = match[3];
    if (indexName !== undefined) {
      addUnique(
        loops,
        { path: indexName, key: indexName, kind: 'number', preview: '0', children: undefined },
        seen,
      );
    }
  }
  return loops;
}

/**
 * Everything in scope at the selection that a prop can be bound to, as a tree.
 *
 * context: {frontmatter, imports, ancestorHeads, propsSample, propsSchema}
 *   propsSample — the page's real Astro.props for the entry on the canvas,
 *                 from getStaticPaths (see page:dynamicPaths). Absent for a
 *                 static page or a component, where the shape is all there is.
 *   propsSchema — this file's own `interface Props`, so a component's props
 *                 still say what they are (`overlap` — boolean) without one.
 *   collectionSamples — {blog: <one sampled entry>}, so a page that lists a
 *                 collection shows what one of them holds.
 *
 * Ordered by what you are likeliest to want: this file's props, the item of
 * each enclosing loop, the frontmatter's own values, then imports.
 */
export function dataTree(context: DataContext | undefined): TreeNode[] {
  const fm = context?.frontmatter ?? '';
  const decls = parseDeclarations(fm);
  const destructures = parseDestructures(fm);
  const sample = context?.propsSample;
  const schema = context?.propsSchema ?? [];
  const samples = context?.collectionSamples ?? {};
  const imports = context?.imports ?? [];
  const seen = new Set<string>();

  const derived = withDerivedShapes(
    decls,
    buildPropNodes(destructures, schema, sample, seen),
    buildValueNodes(decls, destructures, imports, samples, sample, seen, context?.valueSamples),
  );
  const props = derived.props;
  const values = [
    ...derived.values,
    ...buildCollectionNodes(context?.collections ?? [], fm, imports, samples, seen),
  ];
  const loops = buildLoopNodes(
    context?.ancestorHeads ?? [],
    props,
    values,
    context?.itemIndex,
    seen,
  );

  // The loop item leads: inside a loop, it is what the markup is FOR — every
  // field in there is a field of that item. Then this file's props, then
  // everything else it holds.
  return [...loops, ...props, ...values];
}

// What can be looped over: a list, or a value whose shape the app cannot see
// and which may well be one (an import, a query result, a loop item). Text,
// numbers, dates and objects cannot.
const LOOPABLE = new Set(['list', 'value', 'import', 'loop item', 'prop', 'rest props']);

export interface PickableNode extends TreeNode {
  pickable: boolean;
}

/**
 * The tree with only the branches that lead somewhere loopable, for the loop
 * editor's Data field. Ancestors are kept so the list can be reached — you
 * navigate through `post` and `post.data` to get to `post.data.tags` — but
 * they are marked unpickable, because looping over an object is not a thing.
 */
export function listsOnly(nodes: readonly TreeNode[] | undefined): PickableNode[] {
  return listsOnlyAt(nodes, 0);
}

function listsOnlyAt(nodes: readonly TreeNode[] | undefined, depth: number): PickableNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'Data tree exceeds depth limit');
  const out: PickableNode[] = [];
  for (const node of nodes ?? []) {
    const children = listsOnlyAt(node.children, depth + 1);
    const pickable = LOOPABLE.has(node.kind);
    if (!pickable && !children.length) {
      continue;
    }
    out.push({ ...node, pickable, children: children.length ? children : undefined });
  }
  return out;
}

// `posts[0].data.title` seen from inside the loop is `post.data.title`.
function rebase(
  nodes: readonly TreeNode[] | undefined,
  from: string,
  to: string,
  depth = 0,
): TreeNode[] | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'Data tree exceeds depth limit');
  if (!nodes) {
    return undefined;
  }
  return nodes.map((node) => ({
    ...node,
    path: to + node.path.slice(from.length),
    children: rebase(node.children, from, to, depth + 1),
  }));
}
