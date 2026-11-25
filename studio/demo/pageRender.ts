// The DOM half of showing an edit: applies a PageChange to a parsed copy of the baked
// page. The result is a rendering in the same form Astro's would be, and morph.js
// patches it onto the live page exactly as it does in Studio.
import { assert } from '../vendor/stacki/shared/core/assert';
import { BAKE_SECTION_ATTRIBUTE } from '../src/features/bake/bakeProtocol';
import { joinOutput, slotMarker, type TemplateOutput } from '../src/features/bake/componentTemplates';
import {
  CREATED_ANCHOR,
  NOT_SHOWN,
  type LoopReorder,
  type CreatedComponent,
  type CreatedNode,
  type NotShownReason,
  type PageChange,
  type Placement,
} from './pageChange';

const ANCHOR = /^avb-([se]):(.*)$/;
const TEXT_WALK_MAX = 20_000;
const ELEMENT_WALK_MAX = 100_000;
/** Whitespace and comments between an element and its anchors, in nodes. */
const ANCHOR_REACH_MAX = 200;
/** New markup nests no deeper than a page may (PAGE_CHANGE_LIMITS.depthMax). */
const BUILD_DEPTH_MAX = 200;

export type ElementIndex = Map<string, Element[]>;

/** Every element under each bare page path. Component paths hold a `|` and stay out. */
function indexElements(document: Document, component?: string): ElementIndex {
  const index: ElementIndex = new Map();
  const prefix = component === undefined ? undefined : `${component}|`;
  const elements = document.querySelectorAll('[data-avb-p]');
  for (let position = 0; position < elements.length && position < ELEMENT_WALK_MAX; position++) {
    const element = elements[position];
    for (const token of element?.getAttribute('data-avb-p')?.split(' ') ?? []) {
      // A page's own paths are bare; a component's carry its file, and every instance
      // on the page carries the same ones.
      const path = prefix === undefined ? (token.includes('|') ? undefined : token) : token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
      if (element !== undefined && path !== undefined) {
        index.set(path, [...(index.get(path) ?? []), element]);
      }
    }
  }
  return index;
}

/** A component's own text and attribute edits, applied to every instance of it on the
 * page. Anything that changes its structure is Astro's to render, and is refused whole. */
export function applyComponentChange(document: Document, file: string, change: PageChange): boolean {
  const structural = change.placements.length + change.removals.length + change.paths.length + change.components.length + change.loops.length;
  if (structural > 0 || change.notShown.length > 0) {
    return false;
  }
  const index = indexElements(document, file);
  for (const attribute of change.attributes) {
    for (const element of index.get(attribute.path) ?? []) {
      if (attribute.value === undefined) {
        element.removeAttribute(attribute.name);
      } else {
        element.setAttribute(attribute.name, attribute.value);
      }
    }
  }
  return change.texts.every((text) => text.owner !== undefined && replaceAllText(document, index, text));
}

// Every rendered copy of the text, one per instance, rather than the first a page has.
function replaceAllText(document: Document, index: ElementIndex, change: PageChange['texts'][number]): boolean {
  const wanted = collapse(decodeEntities(document, change.before));
  let replaced = false;
  for (const root of ownerRoots(document, index, change.owner)) {
    for (const match of textNodes(root, wanted)) {
      match.data = editedText(match.data, decodeEntities(document, change.after));
      replaced = true;
    }
  }
  return replaced;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(document: Document, text: string): string {
  const holder = document.createElement('textarea');
  holder.innerHTML = text.replaceAll('<', '&lt;');
  return holder.value;
}

function textNodes(root: Node, wanted: string): Text[] {
  const walker = root.ownerDocument?.createTreeWalker(root, 4);
  const found: Text[] = [];
  let visited = 0;
  while (walker?.nextNode() && visited++ < TEXT_WALK_MAX) {
    const node = walker.currentNode;
    if (node instanceof Text && collapse(node.data) === wanted) {
      found.push(node);
    }
  }
  return found;
}

// The source says which element owns the text; the build decides where inside a
// component it lands. So the search is by content, one match per rendered copy.
function ownerRoots(document: Document, index: ElementIndex, owner: string | undefined): readonly Node[] {
  return owner === undefined ? [document.body] : (index.get(owner) ?? []);
}

function replaceText(document: Document, index: ElementIndex, change: PageChange['texts'][number]): boolean {
  const wanted = collapse(decodeEntities(document, change.before));
  let replaced = false;
  for (const root of ownerRoots(document, index, change.owner)) {
    const match = textNodes(root, wanted)[0];
    if (match !== undefined) {
      match.data = editedText(match.data, decodeEntities(document, change.after));
      replaced = true;
    }
  }
  return replaced;
}

// The baked text's own edge whitespace is kept: the build may have trimmed or
// reflowed it. A new edge space the bake never had is the source's word gap,
// as when "Edit Astro sites visually" becomes "Edit Astro sites " beside a new
// <strong>visually</strong>; dropping it would glue the words together.
export function editedText(baked: string, after: string): string {
  const leadBaked = /^\s*/.exec(baked)?.[0] ?? '';
  const tailBaked = /\s*$/.exec(baked)?.[0] ?? '';
  const trimmed = after.trim();
  if (trimmed.length === 0) {
    return leadBaked + tailBaked;
  }
  const lead = leadBaked.length > 0 ? leadBaked : /^\s/.test(after) ? ' ' : '';
  const tail = tailBaked.length > 0 ? tailBaked : /\s$/.test(after) ? ' ' : '';
  return lead + trimmed + tail;
}

function anchorIn(node: ChildNode | null, side: 's' | 'e', path: string): boolean {
  return node?.nodeType === 8 && node.nodeValue === `avb-${side}:${path}`;
}

function nearbyAnchor(element: Element, side: 's' | 'e', path: string): ChildNode | undefined {
  let node: ChildNode | null = side === 's' ? element.previousSibling : element.nextSibling;
  for (let step = 0; node !== null && step < ANCHOR_REACH_MAX; step++) {
    if (anchorIn(node, side, path)) {
      return node;
    }
    if (node.nodeType !== 3 && node.nodeType !== 8) {
      return undefined;
    }
    node = side === 's' ? node.previousSibling : node.nextSibling;
  }
  return undefined;
}

// A node on the page is its element and the comment pair around it, and the two travel
// together: a stranded pair would point the editor at whatever now sits between it.
function runOf(element: Element, path: string): readonly ChildNode[] {
  const start = nearbyAnchor(element, 's', path);
  const end = nearbyAnchor(element, 'e', path);
  if (start === undefined || end === undefined) {
    return [element];
  }
  const run: ChildNode[] = [];
  for (let node: ChildNode | null = start; node !== null && run.length < ANCHOR_REACH_MAX * 2; node = node.nextSibling) {
    run.push(node);
    if (node === end) {
      break;
    }
  }
  return run;
}

function runsAt(index: ElementIndex, path: string): readonly (readonly ChildNode[])[] {
  const anchored = path.startsWith(CREATED_ANCHOR) ? path.slice(CREATED_ANCHOR.length) : path;
  return outermost(index.get(path) ?? []).map((element) => runOf(element, anchored));
}

// A component that forwards its caller's attributes puts the instance's path on more
// than its root (Section's inner container carries it too). The instance is its
// outermost carrier: moving an inner one as well would pull it out of its own root.
function outermost(elements: readonly Element[]): readonly Element[] {
  return elements.filter((element) => !elements.some((other) => other !== element && other.contains(element)));
}

function placeRun(placement: Placement, run: readonly ChildNode[], index: ElementIndex): boolean {
  const before = placement.before === undefined ? undefined : runsAt(index, placement.before)[0]?.[0];
  const after = placement.after === undefined ? undefined : runsAt(index, placement.after).at(-1)?.at(-1);
  const parent = placement.parent === undefined ? undefined : index.get(placement.parent)?.[0];
  if (before !== undefined) {
    before.before(...run);
  } else if (after !== undefined) {
    after.after(...run);
  } else if (parent !== undefined) {
    parent.append(...run);
  } else {
    return false;
  }
  return true;
}

/** Shows the bake's copies of a loop's items in the loop's new order. The copies are the
 * runs at the body's paths, one per item in the baked order; those the order leaves out
 * stay off the page, which every rendering starts again from the bake. */
function reorderLoop(document: Document, index: ElementIndex, loop: LoopReorder): boolean {
  const runs = loop.paths.map((path) => runsAt(index, path));
  if (runs.some((list) => list.length !== loop.baked.length)) {
    return false; // Not one copy per baked item: the page is not what the bake made.
  }
  const copies = loop.baked.map((_item, position) => runs.flatMap((list) => [...(list[position] ?? [])]));
  const first = copies[0]?.[0];
  if (first === undefined) {
    return false;
  }
  const mark = document.createComment('stacki-loop');
  first.before(mark);
  for (const copy of copies) {
    for (const node of copy) {
      node.remove();
    }
  }
  for (const item of loop.order) {
    const copy = copies[loop.baked.indexOf(item)];
    assert(copy !== undefined, 'Every shown item has a baked copy');
    mark.before(...copy);
  }
  mark.remove();
  return true;
}

/** Renders a new component instance from the bake's templates, or undefined. */
export type ComponentBuilder = (use: CreatedComponent) => TemplateOutput | undefined;

interface Build {
  readonly document: Document;
  readonly index: ElementIndex;
  readonly scope: string | undefined;
  readonly components: ComponentBuilder;
}

/** The nodes a created node becomes on the page, or undefined when it cannot be shown. */
function buildNode(build: Build, node: CreatedNode, depth: number): ChildNode[] | undefined {
  if (depth > BUILD_DEPTH_MAX) {
    return undefined;
  }
  switch (node.kind) {
    case 'text':
      return [build.document.createTextNode(decodeEntities(build.document, node.value))];
    case 'moved':
      return [...(runsAt(build.index, node.from)[0] ?? [])];
    case 'element': {
      const element = build.document.createElement(node.tag);
      for (const [name, value] of node.attributes) {
        element.setAttribute(name, value);
      }
      element.setAttribute('data-avb-p', node.path);
      if (build.scope !== undefined) {
        element.setAttribute(`data-astro-cid-${build.scope}`, '');
      }
      for (const child of node.children) {
        element.append(...(buildNode(build, child, depth + 1) ?? []));
      }
      return [element];
    }
    case 'component':
      return buildComponent(build, node, depth);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// The template's markup with each slot left as a marker comment, parsed in a
// `<template>` so no context rewrites it, then each marker swapped for the children
// written into that slot, inside the anchor pair the editor addresses the node by.
function buildComponent(build: Build, node: CreatedComponent, depth: number): ChildNode[] | undefined {
  const output = build.components(node);
  if (output === undefined) {
    return undefined;
  }
  const holder = build.document.createElement('template');
  holder.innerHTML = joinOutput(output, slotMarker);
  const content = holder.content;
  const markers = [...content.querySelectorAll('template[data-stacki-slot]')].slice(0, ELEMENT_WALK_MAX);
  for (const marker of markers) {
    const slot = marker.getAttribute('data-stacki-slot') ?? 'default';
    const children = node.children.filter((child) => child.slot === slot).flatMap((child) => buildNode(build, child.node, depth + 1) ?? []);
    marker.replaceWith(...children);
  }
  // Moved, not cloned: a child that came from the page must leave its old place.
  return [build.document.createComment(`avb-s:${node.path}`), ...content.childNodes, build.document.createComment(`avb-e:${node.path}`)];
}

/** Files the new node's elements under its created anchor, apart from the baked paths. */
function indexBuilt(index: ElementIndex, path: string, nodes: readonly ChildNode[]): void {
  const found: Element[] = [];
  for (const node of nodes) {
    if (node instanceof Element) {
      for (const element of [node, ...node.querySelectorAll('[data-avb-p]')]) {
        if ((element.getAttribute('data-avb-p') ?? '').split(' ').includes(path)) {
          found.push(element);
        }
      }
    }
  }
  if (found.length > 0) {
    index.set(`${CREATED_ANCHOR}${path}`, found);
  }
}

function applyPlacement(build: Build, placement: Placement): boolean {
  if (placement.node.kind === 'move') {
    const runs = runsAt(build.index, placement.node.from);
    return runs.length > 0 && runs.every((run) => placeRun(placement, run, build.index));
  }
  const created = placement.node.created;
  const built = buildNode(build, created, 0);
  if (built === undefined) {
    return false;
  }
  const placed = placeRun(placement, built, build.index);
  if (placed && (created.kind === 'element' || created.kind === 'component')) {
    indexBuilt(build.index, created.path, built);
  }
  return placed;
}

function renamePaths(document: Document, index: ElementIndex, paths: readonly (readonly [string, string])[]): void {
  const renames = new Map(paths);
  for (const [from, elements] of index) {
    const to = renames.get(from);
    if (to !== undefined) {
      for (const element of elements) {
        const tokens = (element.getAttribute('data-avb-p') ?? '').split(' ').map((token) => (token === from ? to : token));
        element.setAttribute('data-avb-p', tokens.join(' '));
      }
    }
  }
  const walker = document.createTreeWalker(document, 128);
  let visited = 0;
  while (walker.nextNode() && visited++ < ELEMENT_WALK_MAX) {
    const comment = walker.currentNode;
    const match = ANCHOR.exec(comment.nodeValue ?? '');
    const to = match === null ? undefined : renames.get(match[2] ?? '');
    if (to !== undefined) {
      comment.nodeValue = `avb-${match?.[1] ?? 's'}:${to}`;
    }
  }
}

/** Applies the plan in place and says what could not be shown. Every lookup runs against
 * the baked paths, so renames come last, when nothing needs the old names any more. */
export function applyPageChange(
  document: Document,
  change: PageChange,
  scope: string | undefined,
  components: ComponentBuilder = () => undefined,
): readonly NotShownReason[] {
  const index = indexElements(document);
  const build: Build = { document, index, scope, components };
  const notShownLoops = change.loops.filter((loop) => !reorderLoop(document, index, loop));
  const notShown = new Set(change.notShown);
  if (notShownLoops.length > 0) {
    notShown.add(NOT_SHOWN.dynamic);
  }
  for (const attribute of change.attributes) {
    for (const element of index.get(attribute.path) ?? []) {
      if (attribute.value === undefined) {
        element.removeAttribute(attribute.name);
      } else {
        element.setAttribute(attribute.name, attribute.value);
      }
    }
  }
  for (const text of change.texts) {
    if (!replaceText(document, index, text)) {
      notShown.add(NOT_SHOWN.placement);
    }
  }
  for (const placement of change.placements) {
    if (!applyPlacement(build, placement)) {
      notShown.add(placement.node.kind === 'create' && placement.node.created.kind === 'component' ? NOT_SHOWN.newComponent : NOT_SHOWN.placement);
    }
  }
  for (const removal of change.removals) {
    if (removal.kind === 'node') {
      for (const element of index.get(removal.path) ?? []) {
        for (const node of runOf(element, removal.path)) {
          node.remove();
        }
      }
    } else {
      const wanted = collapse(decodeEntities(document, removal.value));
      for (const root of ownerRoots(document, index, removal.owner)) {
        textNodes(root, wanted)[0]?.remove();
      }
    }
  }
  renamePaths(document, index, change.paths);
  return [...notShown];
}

export function replaceSection(document: Document, section: string, css: string): void {
  const styles = document.querySelectorAll(`style[${BAKE_SECTION_ATTRIBUTE}]`);
  for (let position = 0; position < styles.length; position++) {
    const style = styles[position];
    if (style?.getAttribute(BAKE_SECTION_ATTRIBUTE) === section) {
      style.textContent = css;
    }
  }
}
