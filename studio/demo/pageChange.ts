// What it takes to show an edited page without Astro. Both sources are parsed, the
// trees are matched, and the difference becomes a plan the DOM half can apply to the
// baked page. Anything Astro would have to re-render lands in `notShown` instead of
// the plan, because a demo that guesses a rendering would be showing something the
// real product would not.
import { assert } from '../vendor/stacki/shared/core/assert';
import { pathFor } from '../src/features/project/previewSelection';
import { frontmatterRange } from '../src/features/source/frontmatter';
import { flatten, parsePage, type ParserNode } from '../src/features/source/source';
import { componentFileOf, filledSlots, type ComponentCatalog } from '../src/features/bake/componentTemplates';
import type { Attr } from '../vendor/stacki/shared/page/pageNodeTypes';
import { loopRun } from './loopOrder';
import { connectedPath } from '../vendor/stacki/src/features/props/textConnect';
import { canRenderEdit, canRenderUse, type ComponentEdit, type ComponentUse } from './componentRender';

export const PAGE_CHANGE_LIMITS = {
  nodesMax: 10_000,
  /** The tree is authored markup; deeper than this is not a page anyone wrote. */
  depthMax: 200,
} as const;

export const NOT_SHOWN = {
  component: 'Changing component properties needs Astro to render them.',
  dynamic: 'Expressions, loops and conditions need Astro to run them.',
  frontmatter: 'Frontmatter runs when Astro builds the page.',
  newComponent: 'A new component needs Astro to render it.',
  script: 'Scripts need a rebuild to run.',
  syntax: 'This source does not parse yet, so the page keeps its last good version.',
  placement: 'This change has no place on the finished page.',
  markup: 'Changing a component’s structure needs Astro to render it on the pages that use it.',
  content: 'This collection edit is saved; where the site does not show the field as written, it shows after the next build.',
} as const;

export type NotShownReason = (typeof NOT_SHOWN)[keyof typeof NOT_SHOWN];

/** Marks a placement anchor that names a node this plan creates. A new node often has
 * the path a baked sibling had, and the two must never be mistaken for each other. */
export const CREATED_ANCHOR = 'new:';

export interface CreatedElement {
  readonly kind: 'element';
  readonly tag: string;
  readonly path: string;
  readonly attributes: readonly (readonly [string, string])[];
  readonly children: readonly CreatedNode[];
}
/** A new component instance, rendered from the bake's templates. */
export interface CreatedComponent extends ComponentUse {
  readonly kind: 'component';
  readonly children: readonly { readonly slot: string; readonly node: CreatedNode }[];
}
export type CreatedNode =
  | CreatedElement
  | CreatedComponent
  | { readonly kind: 'text'; readonly value: string }
  /** A baked node that now sits inside a new one: it moves, it is not rebuilt. */
  | { readonly kind: 'moved'; readonly from: string };

/** What the plan needs beyond the two sources: the page, and what the bake can render. */
export interface PlanContext {
  readonly file: string;
  readonly catalog: ComponentCatalog;
  /** The document of the template entry shown, for instances baked per entry. */
  readonly entry?: string | undefined;
}

export interface Placement {
  /** The moved node's baked path, or the new node to build. */
  readonly node: { readonly kind: 'move'; readonly from: string } | { readonly kind: 'create'; readonly created: CreatedNode };
  /** Baked path, or CREATED_ANCHOR and the created path, of the sibling to go before. */
  readonly before: string | undefined;
  /** Baked or created path of the sibling to go after, used when `before` is absent. */
  readonly after: string | undefined;
  /** Baked path of the parent element, used when the node has no siblings on the page. */
  readonly parent: string | undefined;
}

export interface PageChange {
  readonly notShown: readonly NotShownReason[];
  readonly attributes: readonly { readonly path: string; readonly name: string; readonly value: string | undefined }[];
  readonly texts: readonly { readonly owner: string | undefined; readonly before: string; readonly after: string }[];
  readonly removals: readonly (
    { readonly kind: 'node'; readonly path: string } | { readonly kind: 'text'; readonly owner: string | undefined; readonly value: string }
  )[];
  readonly placements: readonly Placement[];
  /** Baked path to the path the node has now. */
  readonly paths: readonly (readonly [string, string])[];
  /** Instances to re-render from their templates, by baked path. */
  readonly components: readonly ComponentEdit[];
  /** Loops that show the bake's copies of their items in a new order. */
  readonly loops: readonly LoopReorder[];
}

/** A loop's body paths, the array indexes its baked copies stand for, in page order,
 * and the indexes it shows now. */
export interface LoopReorder {
  readonly paths: readonly string[];
  readonly baked: readonly number[];
  readonly order: readonly number[];
}

const EMPTY_CHANGE: PageChange = { notShown: [], attributes: [], texts: [], removals: [], placements: [], paths: [], components: [], loops: [] };

type Matches = Map<ParserNode, ParserNode>;

function isTextValue(node: ParserNode): boolean {
  return node.kind === 'text' && (node.value ?? '').trim().length > 0;
}

function isBlank(node: ParserNode): boolean {
  return node.kind === 'text' && (node.value ?? '').trim().length === 0;
}

/** Style blocks are the style sections' job, not the page tree's. */
function isStyle(node: ParserNode): boolean {
  return node.kind === 'raw' && node.name === 'style';
}

function isPlaced(node: ParserNode): boolean {
  return node.kind === 'element' || node.kind === 'component';
}

function pathOf(node: ParserNode): string {
  return pathFor(node.id ?? '');
}

function attributeSignature(node: ParserNode): string {
  return JSON.stringify(Object.entries(node.props ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

/** What a node is, regardless of where it sits. Equal signatures are the same content. */
function signature(node: ParserNode, depth: number, memo: Map<ParserNode, string>): string {
  assert(depth <= PAGE_CHANGE_LIMITS.depthMax, 'The page nests within the walk limit');
  const known = memo.get(node);
  if (known !== undefined) {
    return known;
  }
  const children = (node.children ?? []).filter((child) => !isBlank(child)).map((child) => signature(child, depth + 1, memo));
  const own = node.kind === 'map' || node.kind === 'cond' ? (node.kind === 'map' ? node.head : node.test) : (node.value ?? node.inner ?? '');
  const text = [node.kind, node.name ?? '', own.trim(), attributeSignature(node), children.join('\u0001')].join('\u0002');
  memo.set(node, text);
  return text;
}

function matchEqualChildren(before: readonly ParserNode[], after: readonly ParserNode[], matches: Matches, memo: Map<ParserNode, string>): void {
  const available = new Map<string, ParserNode[]>();
  for (const node of before) {
    const key = signature(node, 0, memo);
    available.set(key, [...(available.get(key) ?? []), node]);
  }
  for (const node of after) {
    const candidate = available.get(signature(node, 0, memo))?.shift();
    if (candidate !== undefined) {
      matches.set(node, candidate);
    }
  }
}

function matchEditedChildren(before: readonly ParserNode[], after: readonly ParserNode[], matches: Matches): void {
  const claimed = new Set(matches.values());
  const free = before.filter((node) => !claimed.has(node));
  for (const node of after) {
    if (!matches.has(node)) {
      const index = free.findIndex((candidate) => candidate.kind === node.kind && candidate.name === node.name);
      const candidate = free[index];
      if (candidate !== undefined) {
        matches.set(node, candidate);
        free.splice(index, 1);
      }
    }
  }
}

function matchChildren(before: readonly ParserNode[], after: readonly ParserNode[], matches: Matches, memo: Map<ParserNode, string>, depth: number): void {
  assert(depth <= PAGE_CHANGE_LIMITS.depthMax, 'The page nests within the walk limit');
  const left = before.filter((node) => !isBlank(node));
  const right = after.filter((node) => !isBlank(node));
  matchEqualChildren(left, right, matches, memo);
  matchEditedChildren(left, right, matches);
  for (const node of right) {
    const pair = matches.get(node);
    if (pair !== undefined) {
      matchChildren(pair.children ?? [], node.children ?? [], matches, memo, depth + 1);
    }
  }
}

/** A node that left one parent for another matches last, on content alone. */
function matchMoves(before: readonly ParserNode[], after: readonly ParserNode[], matches: Matches, memo: Map<ParserNode, string>): void {
  const claimed = new Set(matches.values());
  const free = new Map<string, ParserNode[]>();
  for (const node of flatten(before)) {
    if (isPlaced(node) && !claimed.has(node)) {
      const key = signature(node, 0, memo);
      free.set(key, [...(free.get(key) ?? []), node]);
    }
  }
  for (const node of flatten(after)) {
    if (isPlaced(node) && !matches.has(node)) {
      const candidate = free.get(signature(node, 0, memo))?.shift();
      if (candidate !== undefined) {
        matches.set(node, candidate);
        matchChildren(candidate.children ?? [], node.children ?? [], matches, memo, 0);
      }
    }
  }
}

function indexOfParents(nodes: readonly ParserNode[]): Map<ParserNode, ParserNode> {
  const parents = new Map<ParserNode, ParserNode>();
  for (const node of flatten(nodes)) {
    for (const child of node.children ?? []) {
      parents.set(child, node);
    }
  }
  return parents;
}

/** The siblings that can stay put: a longest run already in baked order. */
function stableSiblings(indexes: readonly number[]): ReadonlySet<number> {
  const best: number[] = [];
  const previous: number[] = [];
  const lengths: number[] = [];
  indexes.forEach((value, position) => {
    let length = 1;
    previous[position] = -1;
    for (let earlier = 0; earlier < position; earlier++) {
      const candidate = (lengths[earlier] ?? 0) + 1;
      if ((indexes[earlier] ?? 0) < value && candidate > length) {
        length = candidate;
        previous[position] = earlier;
      }
    }
    lengths[position] = length;
  });
  let cursor = lengths.indexOf(Math.max(0, ...lengths));
  while (cursor >= 0) {
    best.push(cursor);
    cursor = previous[cursor] ?? -1;
  }
  return new Set(best);
}

interface Draft {
  readonly notShown: Set<NotShownReason>;
  readonly attributes: { path: string; name: string; value: string | undefined }[];
  readonly texts: { owner: string | undefined; before: string; after: string }[];
  readonly removals: PageChange['removals'][number][];
  readonly placements: Placement[];
  readonly paths: [string, string][];
  readonly components: ComponentEdit[];
  readonly loops: LoopReorder[];
}

function diffAttributes(after: ParserNode, before: ParserNode, walk: Walk): void {
  const { draft } = walk;
  if (after.kind === 'component') {
    diffComponent(after, before, walk);
    return;
  }
  const names = new Set([...Object.keys(before.props ?? {}), ...Object.keys(after.props ?? {})]);
  for (const name of names) {
    const old = before.props?.[name];
    const next = after.props?.[name];
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      if (name.includes(':') || old?.type === 'expr' || old?.type === 'spread' || next?.type === 'expr' || next?.type === 'spread') {
        draft.notShown.add(NOT_SHOWN.dynamic);
      } else {
        const value = next === undefined ? undefined : next.type === 'string' ? next.value : '';
        draft.attributes.push({ path: pathOf(before), name, value });
      }
    }
  }
}

/** A component whose props or filled slots changed is re-rendered from its template.
 * With the bake's catalog at hand, one the templates cannot show is named now, so the
 * edit can be refused before it lands; without it, the rendering names it later. */
function diffComponent(after: ParserNode, before: ParserNode, walk: Walk): void {
  const slots = filledSlots(after.children ?? []);
  const slotsBefore = filledSlots(before.children ?? []);
  if (attributeSignature(after) === attributeSignature(before) && JSON.stringify(slots) === JSON.stringify(slotsBefore)) {
    return;
  }
  if (slots === undefined) {
    walk.draft.notShown.add(NOT_SHOWN.dynamic);
    return;
  }
  const edit: ComponentEdit = { path: pathOf(before), file: walk.imports.get(after.name ?? ''), attrs: after.props ?? {}, slots };
  if (walk.context !== undefined && !canRenderEdit(walk.context.catalog, walk.context.file, edit, walk.context.entry)) {
    walk.draft.notShown.add(NOT_SHOWN.component);
    return;
  }
  walk.draft.components.push(edit);
}

function createNode(node: ParserNode, walk: Walk, depth: number): CreatedNode | undefined {
  assert(depth <= PAGE_CHANGE_LIMITS.depthMax, 'The page nests within the walk limit');
  const { notShown } = walk.draft;
  const pair = walk.matches.get(node);
  if (pair !== undefined && isPlaced(node)) {
    walkMovedInto(node, pair, walk, depth);
    return { kind: 'moved', from: pathOf(pair) };
  }
  if (node.kind === 'text') {
    return { kind: 'text', value: node.value ?? '' };
  }
  if (node.kind === 'comment') {
    return undefined;
  }
  if (node.kind === 'component') {
    return createComponent(node, walk, depth);
  }
  if (node.kind !== 'element') {
    notShown.add(node.kind === 'raw' ? NOT_SHOWN.script : NOT_SHOWN.dynamic);
    return undefined;
  }
  const attributes: [string, string][] = [];
  for (const [name, attribute] of Object.entries(node.props ?? {})) {
    if (attribute.type === 'string') {
      attributes.push([name, attribute.value]);
    } else if (attribute.type === 'bare') {
      attributes.push([name, '']);
    } else {
      notShown.add(NOT_SHOWN.dynamic);
    }
  }
  const children = (node.children ?? []).flatMap((child) => {
    const created = createNode(child, walk, depth + 1);
    return created === undefined ? [] : [created];
  });
  return { kind: 'element', tag: node.name ?? 'div', path: pathOf(node), attributes, children };
}

function createComponent(node: ParserNode, walk: Walk, depth: number): CreatedNode | undefined {
  const slots = filledSlots(node.children ?? []);
  const use = { file: walk.imports.get(node.name ?? ''), path: pathOf(node), attrs: node.props ?? {}, slots: slots ?? [] };
  if (slots === undefined || (walk.context !== undefined && !canRenderUse(walk.context.catalog, use))) {
    walk.draft.notShown.add(NOT_SHOWN.newComponent);
    return undefined;
  }
  const children: { slot: string; node: CreatedNode }[] = [];
  for (const child of node.children ?? []) {
    const created = isBlank(child) ? undefined : createNode(child, walk, depth + 1);
    if (created !== undefined) {
      children.push({ slot: slotOf(child.props?.['slot']), node: created });
    }
  }
  return { kind: 'component', ...use, children };
}

function slotOf(attr: Attr | undefined): string {
  return attr?.type === 'string' ? attr.value : 'default';
}

/** A baked node that a new parent now holds keeps its rendering; only its paths, and
 * whatever changed inside it, follow. */
function walkMovedInto(node: ParserNode, pair: ParserNode, walk: Walk, depth: number): void {
  if (pathOf(pair) !== pathOf(node)) {
    walk.draft.paths.push([pathOf(pair), pathOf(node)]);
  }
  diffAttributes(node, pair, walk);
  walkChildren(pair, pair.children ?? [], node.children ?? [], walk, depth + 1);
}

interface Walk {
  readonly matches: Matches;
  readonly parentsBefore: ReadonlyMap<ParserNode, ParserNode>;
  readonly memo: Map<ParserNode, string>;
  readonly draft: Draft;
  /** Each component name the current source imports, to its file. */
  readonly imports: ReadonlyMap<string, string>;
  readonly context: PlanContext | undefined;
  /** The baked frontmatter: a loop's constant reads the same in both sources, or the
   * frontmatter change is refused on its own. */
  readonly frontmatter: string;
}

function anchorOf(node: ParserNode | undefined, matches: Matches, created: ReadonlySet<ParserNode>): string | undefined {
  if (node === undefined) {
    return undefined;
  }
  const pair = matches.get(node);
  if (pair !== undefined) {
    return pathOf(pair);
  }
  return created.has(node) ? `${CREATED_ANCHOR}${pathOf(node)}` : undefined;
}

function nearest(nodes: readonly ParserNode[], from: number, step: 1 | -1, walk: Walk, created: ReadonlySet<ParserNode>): string | undefined {
  for (let index = from + step; index >= 0 && index < nodes.length; index += step) {
    const node = nodes[index];
    if (node !== undefined && isPlaced(node)) {
      const anchor = anchorOf(node, walk.matches, created);
      if (anchor !== undefined) {
        return anchor;
      }
    }
  }
  return undefined;
}

// Every child of one parent, in its new order. Control flow lives here: helpers
// above decide nothing about what a node's kind means for the plan.
function walkChildren(
  parentBefore: ParserNode | undefined,
  childrenBefore: readonly ParserNode[],
  children: readonly ParserNode[],
  walk: Walk,
  depth: number,
): void {
  assert(depth <= PAGE_CHANGE_LIMITS.depthMax, 'The page nests within the walk limit');
  const visible = children.filter((node) => !isBlank(node));
  const owner = parentBefore === undefined ? undefined : pathOf(parentBefore);
  const siblings = childrenBefore.filter((node) => !isBlank(node));
  const kept = visible.filter((node) => {
    const pair = walk.matches.get(node);
    return isPlaced(node) && pair !== undefined && walk.parentsBefore.get(pair) === parentBefore;
  });
  const order = kept.map((node) => {
    const pair = walk.matches.get(node);
    assert(pair !== undefined, 'A kept node has its baked match');
    return siblings.indexOf(pair);
  });
  const stable = stableSiblings(order);
  const stableNodes = new Set(kept.filter((_node, index) => stable.has(index)));
  const created = new Set<ParserNode>();
  visible.forEach((node, index) => {
    walkNode(node, index, { owner, visible, stableNodes, created }, walk, depth);
  });
}

interface Siblings {
  readonly owner: string | undefined;
  readonly visible: readonly ParserNode[];
  readonly stableNodes: ReadonlySet<ParserNode>;
  readonly created: Set<ParserNode>;
}

function walkNode(node: ParserNode, index: number, place: Siblings, walk: Walk, depth: number): void {
  const { draft, matches } = walk;
  const pair = matches.get(node);
  if (pair === undefined) {
    walkNewNode(node, index, place, walk);
    return;
  }
  if (isTextValue(node) && (pair.value ?? '').trim() !== (node.value ?? '').trim()) {
    draft.texts.push({ owner: place.owner, before: pair.value ?? '', after: node.value ?? '' });
  } else if (
    signature(pair, 0, walk.memo) !== signature(node, 0, walk.memo) &&
    !isPlaced(node) &&
    node.kind !== 'text' &&
    node.kind !== 'map' &&
    node.kind !== 'comment' &&
    !isStyle(node)
  ) {
    // A loop decides for itself (walkOpaque): a new head over literal items can show.
    // A comment renders nothing, so rewording one (a node's label) changes no pixel.
    draft.notShown.add(node.kind === 'raw' ? NOT_SHOWN.script : NOT_SHOWN.dynamic);
  }
  if (pathOf(pair) !== pathOf(node)) {
    draft.paths.push([pathOf(pair), pathOf(node)]);
  }
  if (isPlaced(node)) {
    diffAttributes(node, pair, walk);
    if (!place.stableNodes.has(node)) {
      draft.placements.push({
        node: { kind: 'move', from: pathOf(pair) },
        before: nearest(place.visible, index, 1, walk, place.created),
        after: nearest(place.visible, index, -1, walk, place.created),
        parent: place.owner,
      });
    }
  }
  if (node.kind === 'map' || node.kind === 'cond' || node.kind === 'branch') {
    walkOpaque(pair, node, walk, depth);
  } else {
    walkChildren(pair, pair.children ?? [], node.children ?? [], walk, depth + 1);
  }
}

function walkNewNode(node: ParserNode, index: number, place: Siblings, walk: Walk): void {
  if (node.kind === 'comment' || isStyle(node)) {
    return;
  }
  const created = createNode(node, walk, 0);
  if (created === undefined || created.kind === 'moved') {
    return;
  }
  place.created.add(node);
  walk.draft.placements.push({
    node: { kind: 'create', created },
    before: nearest(place.visible, index, 1, walk, place.created),
    after: nearest(place.visible, index, -1, walk, place.created),
    parent: place.owner,
  });
}

/** A loop or condition stays what the build made of it. Only its paths can follow. */
function walkOpaque(before: ParserNode, after: ParserNode, walk: Walk, depth: number): void {
  assert(depth <= PAGE_CHANGE_LIMITS.depthMax, 'The page nests within the walk limit');
  if (signature(before, 0, walk.memo) !== signature(after, 0, walk.memo)) {
    const loop = loopReorder(before, after, walk);
    if (loop === undefined) {
      walk.draft.notShown.add(NOT_SHOWN.dynamic);
      return;
    }
    walk.draft.loops.push(loop);
  }
  const pairs = (after.children ?? []).map((child, index) => [child, before.children?.[index]] as const);
  for (const [child, pair] of pairs) {
    if (pair !== undefined) {
      if (pathOf(pair) !== pathOf(child)) {
        walk.draft.paths.push([pathOf(pair), pathOf(child)]);
      }
      walkOpaque(pair, child, walk, depth + 1);
    }
  }
}

/** A loop whose head alone changed, over a literal constant, re-ordered from the copies
 * the bake rendered. Every item it now shows must be one the bake showed. */
function loopReorder(before: ParserNode, after: ParserNode, walk: Walk): LoopReorder | undefined {
  if (before.kind !== 'map' || after.kind !== 'map') {
    return undefined;
  }
  const children = (node: ParserNode) => (node.children ?? []).filter((child) => !isBlank(child)).map((child) => signature(child, 0, walk.memo));
  if (JSON.stringify(children(before)) !== JSON.stringify(children(after))) {
    return undefined;
  }
  const baked = loopRun(walk.frontmatter, before.head);
  const current = loopRun(walk.frontmatter, after.head);
  if (baked === undefined || current === undefined || baked.name !== current.name || baked.item !== current.item || baked.index !== current.index) {
    return undefined;
  }
  if (current.index !== '' || current.order.some((index) => !baked.order.includes(index))) {
    return undefined; // An index the body reads, or an item the bake never rendered.
  }
  const paths = (before.children ?? []).filter((child) => isPlaced(child)).map((child) => pathOf(child));
  return paths.length === 0 ? undefined : { paths, baked: baked.order, order: current.order };
}

function collectRemovals(before: readonly ParserNode[], walk: Walk): void {
  const claimed = new Set(walk.matches.values());
  const removed = new Set<ParserNode>();
  for (const node of flatten(before)) {
    const parent = walk.parentsBefore.get(node);
    if (!claimed.has(node) && !isBlank(node) && node.kind !== 'comment' && !isStyle(node) && (parent === undefined || !removed.has(parent))) {
      removed.add(node);
      if (node.kind === 'text') {
        walk.draft.removals.push({ kind: 'text', owner: parent === undefined ? undefined : pathOf(parent), value: node.value ?? '' });
      } else if (isPlaced(node)) {
        walk.draft.removals.push({ kind: 'node', path: pathOf(node) });
      } else {
        walk.draft.notShown.add(node.kind === 'raw' ? NOT_SHOWN.script : NOT_SHOWN.dynamic);
      }
    }
  }
}

const COMPONENT_IMPORT = /^\s*import\s+[A-Z]\w*\s+from\s+["'][^"']+\.astro["'];?\s*$/;

/** Frontmatter that differs only by component imports added (an insertion writes one),
 * or by imports of components the page no longer uses taken away (a tag change prunes
 * them, as Desktop's does), runs the same: an import of a component file has no effect
 * until it is used. */
function sameFrontmatter(baked: string, current: string, page: string): boolean {
  if (baked === current) {
    return true;
  }
  const before = baked.split('\n');
  const kept = new Set(before);
  const now = new Set(current.split('\n'));
  const after = current.split('\n').filter((line) => kept.has(line) || !COMPONENT_IMPORT.test(line));
  const stayed = before.filter((line) => now.has(line) || !COMPONENT_IMPORT.test(line) || usedAsTag(line, page));
  return after.join('\n') === stayed.join('\n');
}

/** Whether the component a removed import line named is still written as a tag. */
function usedAsTag(line: string, page: string): boolean {
  const name = /import\s+([A-Z]\w*)/.exec(line)?.[1];
  assert(name !== undefined, 'A component import names its component');
  return new RegExp(`<${name}[\\s/>]`).test(page);
}

function frontmatterOf(source: string): string {
  const range = frontmatterRange(source);
  return range === undefined ? '' : source.slice(range.start, range.end);
}

function treeOf(source: string): readonly ParserNode[] | undefined {
  const parsed = parsePage(source, { locs: true });
  return parsed.editable ? parsed.model.nodes : undefined;
}

/** The component files a page's default imports name. */
export function componentImports(page: string, source: string): ReadonlyMap<string, string> {
  const parsed = parsePage(source);
  const imports = new Map<string, string>();
  if (!parsed.editable || page === '') {
    return imports;
  }
  for (const declaration of parsed.model.imports) {
    const file = declaration.typeOnly || declaration.imported !== undefined ? undefined : componentFileOf(page, declaration.path);
    if (file !== undefined) {
      imports.set(declaration.name, file);
    }
  }
  return imports;
}

/** The plan that takes a baked page from `baked` to `current`. With a context, edits the
 * bake's templates cannot render are named in `notShown`; without one, they are left
 * in the plan for the rendering to try. */
export function planPageChange(baked: string, current: string, context?: PlanContext): PageChange {
  if (baked === current) {
    return EMPTY_CHANGE;
  }
  const before = treeOf(baked);
  const after = treeOf(current);
  assert(before !== undefined, 'A baked page parsed when it was built');
  if (after === undefined) {
    return { ...EMPTY_CHANGE, notShown: [NOT_SHOWN.syntax] };
  }
  const draft: Draft = { notShown: new Set(), attributes: [], texts: [], removals: [], placements: [], paths: [], components: [], loops: [] };
  if (!sameFrontmatter(frontmatterOf(baked), frontmatterOf(current), current)) {
    draft.notShown.add(NOT_SHOWN.frontmatter);
  }
  const memo = new Map<ParserNode, string>();
  const matches: Matches = new Map();
  matchChildren(before, after, matches, memo, 0);
  matchMoves(before, after, matches, memo);
  const imports = componentImports(context?.file ?? '', current);
  const walk: Walk = { matches, parentsBefore: indexOfParents(before), memo, draft, imports, context, frontmatter: frontmatterOf(baked) };
  walkChildren(undefined, before, after, walk, 0);
  collectRemovals(before, walk);
  return { ...draft, notShown: [...draft.notShown] };
}

/** Why the settings panel cannot change this selection, if it cannot. A component
 * instance is never locked: every prop edit is saved, and each is rendered from the
 * bake's templates where they reach it; one past their bounds keeps the instance's
 * nearest rendering and says so for that edit alone (renderEditsInText). */
export function settingsLockReason(source: string, selection: string, _context?: PlanContext): NotShownReason | undefined {
  if (selection === 'frontmatter') {
    return NOT_SHOWN.frontmatter;
  }
  const nodes = treeOf(source);
  if (nodes === undefined) {
    return NOT_SHOWN.syntax;
  }
  const parents = indexOfParents(nodes);
  const selected = flatten(nodes).find((node) => node.id === selection);
  if (selected === undefined) {
    return undefined;
  }
  // A loop over a literal constant can be filtered, sorted and limited from the copies the
  // bake rendered; what its body holds still needs Astro. Its bound text can still be
  // selected and read: `{item.name}` as the data chip the Content field draws, on the
  // expression and on the element whose words it is. A change to it is noted when made.
  const frontmatter = frontmatterOf(source);
  const literal = (node: ParserNode): boolean => node.kind === 'map' && loopRun(frontmatter, node.head) !== undefined;
  const readable = literal(selected) || boundText(selected);
  let current: ParserNode | undefined = readable ? parents.get(selected) : selected;
  for (let depth = 0; current !== undefined && depth < PAGE_CHANGE_LIMITS.depthMax; depth++) {
    if (current.kind === 'map') {
      if (!readable || !literal(current)) {
        return NOT_SHOWN.dynamic;
      }
    } else if (current.kind === 'cond' || current.kind === 'expr') {
      return NOT_SHOWN.dynamic;
    }
    current = parents.get(current);
  }
  return undefined;
}

/** A text connected to data (textConnect.ts, connectedPath): an expression that is only a
 * data path, or an element whose words are such paths and text alone. */
function boundText(node: ParserNode): boolean {
  if (node.kind === 'expr') {
    return connectedPath(node.value ?? '') !== undefined;
  }
  const children = (node.children ?? []).filter((child) => !isBlank(child));
  if (node.kind !== 'element' || children.length === 0) {
    return false;
  }
  const reference = (child: ParserNode): boolean => child.kind === 'expr' && connectedPath(child.value ?? '') !== undefined;
  return children.every((child) => child.kind === 'text' || reference(child)) && children.some(reference);
}

/** A component's template with its style blocks taken out, for comparing markup. */
export function markupOf(source: string): string {
  return source.replace(/<style\b[\s\S]*?<\/style>/g, '');
}
