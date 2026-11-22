// Which prop an image on the canvas comes from, and which one is its alt text. A double click on an image
// names the marker paths the image carries: its own node in the file that draws it, and the node of every
// component instance that rendered it, up to the open file. This follows those paths back through the
// components' templates (a Card hands `image` to a VisualImage, which hands it on to an Img, which prints
// `<img src={src} alt={alt}>`) to the one prop of the instance on the open file that decides the picture, and
// finds the alt text's prop the same way, whatever either prop is called (canvasImageExpression.ts).
//
// Nothing runs project code. What cannot be followed to a place the editor may write is refused, with the
// reason, so a double click never rewrites something it did not understand.

import type { Attr, ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { err, ok, type Result } from '../../../shared/core/result';
import { isEditableThroughProps, type ClosedComponentReach } from '../../../shared/properties/closedComponentReach';
import { componentReference } from './componentReference';
import { REPEATS, childrenOf, isInstance, type PropNode, type PropSiteContext } from './canvasPropSites';
import {
  MEMBERS_MAX,
  ALIAS_DEPTH_MAX,
  componentScope,
  objectLiteral,
  traceValue,
  unwrapped,
  type ComponentScope,
  type ValueSource,
} from './canvasImageExpression';

/** Components an image is followed through, from the page's instance down to the file that draws it. */
export const IMAGE_HOPS_MAX = 6;

/** What the page's own prop or attribute holds for the picture right now. */
export type ImageValueState = 'default' | 'literal' | 'asset';

/** Where an image's alt text is edited. */
export type AltTarget =
  /** A prop of the instance (`imageAlt`, `alt`, `altText`: whatever the component calls it). `member` when the alt is a field of an object prop. */
  | { readonly kind: 'prop'; readonly prop: string; readonly member?: string }
  /** The element's own `alt` attribute, present or to be added. */
  | { readonly kind: 'attribute' }
  /** The component prints no alt text from a prop: there is none to edit from here. */
  | { readonly kind: 'none' }
  /** The component writes its alt text itself, the same for every instance. */
  | { readonly kind: 'fixed'; readonly file: string }
  /** The alt text is computed, or comes from something that cannot be followed. */
  | { readonly kind: 'blocked'; readonly expression: string };

export type ImageTarget =
  /** The image comes from a prop of the instance `instanceId` on the open file: that prop is what the popup edits. */
  | {
      readonly kind: 'instance';
      readonly instanceId: string;
      readonly componentName: string;
      readonly componentPath: string;
      readonly srcProp: string;
      readonly srcMember?: string;
      readonly state: ImageValueState;
      readonly alt: AltTarget;
    }
  /** The image is an element (or an Astro `<Image>`) of the open file: its own `src` and `alt` attributes are edited. */
  | { readonly kind: 'element'; readonly nodeId: string; readonly tag: string; readonly state: ImageValueState; readonly alt: AltTarget };

export type ImageRefusal =
  /** The picture is written in a component's file: it is the same for every instance, so only that file may change it. */
  | { readonly kind: 'fixed'; readonly file: string }
  /** The open file binds the picture to an expression (`image={cards[0].photo}`, a CMS field, a loop item). */
  | { readonly kind: 'bound'; readonly expression: string }
  /** The image is drawn once for each pass of a loop or expression, so one edit would stand for many. */
  | { readonly kind: 'loop' }
  /** The image belongs to a file the open one only embeds (a layout), and no instance of the open file supplies it. */
  | { readonly kind: 'outside'; readonly file: string }
  /** The component computes the picture (a function, a ternary), so no prop decides it. */
  | { readonly kind: 'computed'; readonly file: string; readonly expression: string }
  /** The component cannot be read (a package's, or a file the editor does not open). */
  | { readonly kind: 'unreadable'; readonly file: string };

export interface ImageTraceContext extends PropSiteContext {
  /** The marker prefix of the open file's paths: empty for a page, `src/components/X.astro` for an entered component. */
  readonly openRel: string;
  /** The open file, against which its imports resolve. */
  readonly file: string;
  readonly nodes: readonly PropNode[];
  readonly imports: readonly ImportDecl[];
}

interface Hop {
  /** The component instance node that hands props down. */
  readonly instance: PropNode & { readonly name: string };
  readonly component: ScanComponent;
  /** The file the instance is written in: the open file for the first hop, else the previous component's. */
  readonly scope: ComponentScope | undefined;
}

/**
 * The target of a double click on an image whose markers are `paths`, or why none can be edited.
 * `paths` are the marker paths the image element carries, every file's, in any order.
 */
export async function traceImage(context: ImageTraceContext, paths: readonly string[]): Promise<Result<ImageTarget, ImageRefusal>> {
  const marked = markedPaths(paths, context.openRel);
  const own = deepest(marked.own);
  if (own === undefined) {
    const outer = [...marked.others.keys()][0];
    return err({ kind: 'outside', file: outer ?? '' });
  }
  const walked = walk(context.nodes, own);
  const top = walked.at(-1);
  if (top === undefined) {
    return err({ kind: 'outside', file: '' });
  }
  const repeated = walked.find((node) => REPEATS.includes(node.kind));
  if (repeated !== undefined) {
    return err({ kind: 'loop' });
  }
  if (isImageNode(top)) {
    return elementTarget(top, context.imports);
  }
  if (!isInstance(top)) {
    return err({ kind: 'outside', file: '' });
  }
  return instanceTarget(context, top, marked.others);
}

/** A refusal the popup explains: the open file's own code, a loop of the page, or a file the page only embeds decides the picture. */
export type ShownImageRefusal = Extract<ImageRefusal, { readonly kind: 'bound' | 'loop' | 'outside' }>;

/** What a double click on an image does with its trace. */
export type ImageDecision =
  /** A prop of the instance, or the open file's own element, decides the picture: the popup edits it. */
  | { readonly kind: 'edit'; readonly target: ImageTarget }
  /** The open file decides the picture through something the popup cannot write: the popup says why. */
  | { readonly kind: 'explain'; readonly refusal: ShownImageRefusal }
  /** A closed component draws the picture itself (or its source has not been read): nothing on this instance changes it, so nothing opens. */
  | { readonly kind: 'nothing'; readonly reach: ClosedComponentReach };

/**
 * The popup's answer to a trace. An image inside a closed component opens the popup only when a prop of this instance
 * decides it (closedComponentReach.ts, the rule the text hover and the text editor follow too); a picture the component
 * writes, computes or cannot be read for opens nothing, not even an explanation, since the instance has nothing to change.
 */
export function imageDecision(traced: Result<ImageTarget, ImageRefusal>): ImageDecision {
  if (traced.ok) {
    const reach = traced.value.kind === 'instance' ? 'prop' : undefined;
    assert(reach === undefined || isEditableThroughProps(reach), 'A picture a prop decides is the instance’s to change');
    return { kind: 'edit', target: traced.value };
  }
  const refusal = traced.error;
  switch (refusal.kind) {
    case 'bound':
    case 'loop':
    case 'outside':
      return { kind: 'explain', refusal };
    case 'fixed':
    case 'computed':
    case 'unreadable': {
      // Only the walk through a closed component's templates refuses these: the component, not the page, decides the picture.
      const reach: ClosedComponentReach = 'internal';
      assert(!isEditableThroughProps(reach), 'A picture the component decides is not the instance’s to change');
      return { kind: 'nothing', reach };
    }
    default: {
      const exhaustive: never = refusal;
      return exhaustive;
    }
  }
}

async function instanceTarget(
  context: ImageTraceContext,
  instance: PropNode & { readonly name: string; readonly id: string },
  others: ReadonlyMap<string, readonly (readonly number[])[]>,
): Promise<Result<ImageTarget, ImageRefusal>> {
  const first = componentReference({
    name: instance.name,
    project: context.projectPath,
    file: context.file,
    imports: context.imports,
    components: context.components,
  });
  if (first === undefined || first.origin?.kind === 'package') {
    return err({ kind: 'unreadable', file: first?.path ?? instance.name });
  }
  const hops: Hop[] = [{ instance, component: first, scope: undefined }];
  let image: { readonly node: PropNode; readonly scope: ComponentScope; readonly component: ScanComponent } | undefined;
  for (let step = 0; image === undefined && step < IMAGE_HOPS_MAX; step++) {
    const hop = hops[hops.length - 1];
    assert(hop !== undefined, 'There is always a hop to follow');
    const source = await context.read(hop.component.path);
    const trail = deepest(others.get(context.relative(hop.component.path)) ?? []);
    if (source === undefined || trail === undefined) {
      return err({ kind: 'unreadable', file: hop.component.path });
    }
    const node = walk(source.nodes, trail).at(-1);
    const scope = componentScope(source.extraFrontmatter);
    if (node === undefined) {
      return err({ kind: 'unreadable', file: hop.component.path });
    }
    if (isImageNode(node)) {
      image = { node, scope, component: hop.component };
    } else if (isNamedComponent(node)) {
      const next = componentReference({
        name: node.name,
        project: context.projectPath,
        file: hop.component.path,
        imports: source.imports,
        components: context.components,
      });
      if (next === undefined || next.origin?.kind === 'package') {
        return err({ kind: 'unreadable', file: next?.path ?? node.name });
      }
      hops.push({ instance: node, component: next, scope });
    } else {
      return err({ kind: 'unreadable', file: hop.component.path });
    }
  }
  if (image === undefined) {
    return err({ kind: 'unreadable', file: hops[hops.length - 1]?.component.path ?? '' });
  }
  const source = climb(attributeSource(image.node, 'src', image.scope), hops, image.component.path, 'fixed');
  if (!source.ok) {
    return source;
  }
  const alt = altOf(climb(attributeSource(image.node, 'alt', image.scope), hops, image.component.path, 'none'));
  const state = pageValueState(instance, source.value.prop, context.imports);
  if (!state.ok) {
    return state;
  }
  return ok({
    kind: 'instance',
    instanceId: instance.id,
    componentName: instance.name,
    componentPath: first.path,
    srcProp: source.value.prop,
    ...(source.value.member === undefined ? {} : { srcMember: source.value.member }),
    state: state.value,
    alt,
  });
}

// The picture's own prop on the page instance, or why it cannot be one: climbing from the file that
// draws the image up through each instance that hands the value down.
function climb(
  source: ValueSource | undefined,
  hops: readonly Hop[],
  file: string,
  whenAbsent: 'fixed' | 'none',
): Result<{ readonly prop: string; readonly member?: string }, ImageRefusal> {
  assert(hops.length > 0, 'An image is reached through at least one instance');
  assert(hops.length <= IMAGE_HOPS_MAX + 1, 'An image is followed through a bounded number of instances');
  let current: ValueSource | undefined = source;
  let owner = file;
  for (let at = hops.length - 1; at >= 0; at--) {
    const hop = hops[at];
    assert(hop !== undefined, 'The hop being climbed exists');
    if (current === undefined) {
      // Nothing is handed down: the picture is the component's own, and an alt text it never prints is not there to edit.
      return err(whenAbsent === 'fixed' ? { kind: 'fixed', file: owner } : { kind: 'unreadable', file: owner });
    }
    if (current.kind === 'literal') {
      return err({ kind: 'fixed', file: owner });
    }
    if (current.kind === 'blocked') {
      return err({ kind: 'computed', file: owner, expression: current.expression });
    }
    if (at === 0) {
      return ok(current.member === undefined ? { prop: current.prop } : { prop: current.prop, member: current.member });
    }
    const handed = attributeSource(hop.instance, current.prop, hop.scope ?? emptyScope);
    const host = hops[at - 1];
    assert(host !== undefined, 'A hop above the first has a host');
    owner = host.component.path;
    current = joinMember(handed, current.member);
  }
  return err({ kind: 'fixed', file: owner });
}

const emptyScope: ComponentScope = { propLocals: new Map(), consts: new Map(), defaults: new Map() };

// A value an instance hands down, read in the host's scope, with the member the inner file asked of it.
function joinMember(handed: ValueSource | undefined, member: string | undefined): ValueSource | undefined {
  if (handed === undefined || member === undefined || handed.kind !== 'prop') {
    return handed;
  }
  return handed.member === undefined
    ? { kind: 'prop', prop: handed.prop, member }
    : { kind: 'blocked', expression: `${handed.prop}.${handed.member}.${member}` };
}

function altOf(found: Result<{ readonly prop: string; readonly member?: string }, ImageRefusal>): AltTarget {
  if (found.ok) {
    return found.value.member === undefined ? { kind: 'prop', prop: found.value.prop } : { kind: 'prop', prop: found.value.prop, member: found.value.member };
  }
  const { error } = found;
  switch (error.kind) {
    case 'fixed':
      return { kind: 'fixed', file: error.file };
    case 'computed':
      return { kind: 'blocked', expression: error.expression };
    case 'bound':
      return { kind: 'blocked', expression: error.expression };
    case 'loop':
    case 'outside':
    case 'unreadable':
      return { kind: 'none' };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}

function elementTarget(node: PropNode, imports: readonly ImportDecl[]): Result<ImageTarget, ImageRefusal> {
  const id = node.id;
  if (id === undefined) {
    return err({ kind: 'outside', file: '' });
  }
  const state = pageValueState(node, 'src', imports);
  if (!state.ok) {
    return state;
  }
  const alt = node.props?.['alt'];
  return ok({
    kind: 'element',
    nodeId: id,
    tag: node.name ?? 'img',
    state: state.value,
    alt: alt?.type === 'expr' || alt?.type === 'spread' ? altExpression(alt) : { kind: 'attribute' },
  });
}

// An `alt={…}` on the page's own element: kept as an attribute the field shows; only code that cannot be shown as a value is blocked.
function altExpression(alt: Attr): AltTarget {
  return alt.type === 'expr' && /^[A-Za-z_$][\w$]*$/.test(alt.value.trim())
    ? { kind: 'attribute' }
    : { kind: 'blocked', expression: 'value' in alt ? alt.value : '' };
}

// What the open file holds for a picture prop: nothing (the component's default shows), a string, or an imported
// asset the panel's own pick replaces. Any other expression is the page's code, which a pick would overwrite.
function pageValueState(node: PropNode, name: string, imports: readonly ImportDecl[]): Result<ImageValueState, ImageRefusal> {
  const attr = node.props?.[name];
  if (attr === undefined) {
    const spread = Object.keys(node.props ?? {}).find((key) => key.startsWith('...'));
    return spread === undefined ? ok('default') : err({ kind: 'bound', expression: spread });
  }
  if (attr.type === 'string') {
    return ok('literal');
  }
  if (attr.type === 'expr') {
    const expression = unwrapped(attr.value);
    const base = expression.replace(/\.src$/, '');
    return imports.some((declaration) => declaration.name === base) ? ok('asset') : err({ kind: 'bound', expression });
  }
  return err({ kind: 'bound', expression: 'value' in attr ? attr.value : name });
}

/**
 * What a node gives an attribute, in the scope of the file the node is written in: its own attribute, or the
 * member of a spread object, whichever comes last, as JSX applies them. Undefined when it gives none.
 */
export function attributeSource(node: PropNode, name: string, scope: ComponentScope): ValueSource | undefined {
  let found: ValueSource | undefined;
  const entries = Object.entries(node.props ?? {}).slice(0, MEMBERS_MAX);
  for (const [key, attr] of entries) {
    if (key === name) {
      found =
        attr.type === 'string'
          ? { kind: 'literal', text: attr.value }
          : attr.type === 'expr'
            ? traceValue(attr.value, scope)
            : { kind: 'literal', text: undefined };
    } else if (attr.type === 'spread') {
      const spread = spreadMember(attr.value, name, scope, 0);
      found = spread ?? found;
    }
  }
  return found;
}

// A member of a spread object: an object literal's entry (the last one wins), a const that is one, or, for a prop that is an object, that prop's member.
function spreadMember(expression: string, name: string, scope: ComponentScope, depth: number): ValueSource | undefined {
  assert(depth >= 0, 'The spread depth is never negative');
  assert(depth <= LIMITS.treeDepthMax, 'The spread depth stays within the structural bound');
  if (depth > ALIAS_DEPTH_MAX) {
    return undefined;
  }
  const text = unwrapped(expression);
  const literal = objectLiteral(text);
  if (literal !== undefined) {
    return literalMember(literal, name, scope, depth);
  }
  const traced = traceValue(text, scope);
  if (traced.kind === 'prop' && traced.member === undefined) {
    return { kind: 'prop', prop: traced.prop, member: name };
  }
  const aliased = /^[A-Za-z_$][\w$]*$/.test(text) ? scope.consts.get(text) : undefined;
  return aliased === undefined ? undefined : spreadMember(aliased, name, scope, depth + 1);
}

function literalMember(entries: NonNullable<ReturnType<typeof objectLiteral>>, name: string, scope: ComponentScope, depth: number): ValueSource | undefined {
  let found: ValueSource | undefined;
  for (const entry of entries) {
    if (entry.kind === 'member' && entry.name === name) {
      found = traceValue(entry.expression, scope);
    } else if (entry.kind === 'spread') {
      found = spreadMember(entry.expression, name, scope, depth + 1) ?? found;
    }
  }
  return found;
}

function isImageNode(node: PropNode): boolean {
  if (node.kind === 'element') {
    return node.name === 'img';
  }
  return node.kind === 'component' && 'astroAsset' in node && node.astroAsset === true;
}

function isNamedComponent(node: PropNode): node is PropNode & { readonly name: string } {
  return node.kind === 'component' && typeof node.name === 'string';
}

// The marker paths split by the file they are written in: the open file's (as trails) and each other file's.
function markedPaths(paths: readonly string[], openRel: string) {
  assert(paths.length <= 512, 'An image carries a bounded number of marker paths');
  const own: (readonly number[])[] = [];
  const others = new Map<string, (readonly number[])[]>();
  for (const path of paths) {
    const bar = path.indexOf('|');
    const file = bar === -1 ? '' : path.slice(0, bar);
    const trail = path
      .slice(bar + 1)
      .split('.')
      .map(Number);
    if (trail.some((index) => !Number.isSafeInteger(index) || index < 0)) {
      continue;
    }
    if (file === openRel) {
      own.push(trail);
    } else {
      others.set(file, [...(others.get(file) ?? []), trail]);
    }
  }
  return { own, others };
}

// The longest trail: the deepest node that encloses the image in that file.
function deepest(trails: readonly (readonly number[])[]): readonly number[] | undefined {
  let best: readonly number[] | undefined;
  for (const trail of trails) {
    if (best === undefined || trail.length > best.length) {
      best = trail;
    }
  }
  return best;
}

// The nodes from the first of a trail down to its last, or fewer where the tree has no such node.
function walk(nodes: readonly PropNode[], trail: readonly number[]): readonly PropNode[] {
  const walked: PropNode[] = [];
  let list: readonly PropNode[] = nodes;
  for (const index of trail) {
    const node = list[index];
    if (node === undefined) {
      return [];
    }
    walked.push(node);
    list = childrenOf(node);
  }
  return walked;
}
