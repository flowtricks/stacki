// The preview's marked copy of a page: the same printing as
// astroSerialize.ts, with each node between avb-s/avb-e comments carrying its
// path, so the canvas can find the source of what it shows.

import type { Attr } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { PREVIEW_STAMP_ATTRIBUTE, stampData, type PreviewStamp } from '../../shared/page/previewToken';
import type { ParserNode, MapNode, CondNode } from './astroParserTypes';
import { serializeAttrs } from './astroAttrs';
import { blockHead } from './astroScan';
import { isInlineRun, loopBodyWrapper, tagInlineRun, serializeNode } from './astroSerialize';
import { serializeMapCallback } from './astroMapSerialize';

// Where one node sits for the marked writer: its path, whether it is slot content (which decides
// how its markers are written), whether it is one of its file's own roots (see `atRoot` below),
// how deep in the tree it is, and the file text its offsets index (see `MarkedSource`).
interface MarkedPlace {
  readonly path: string;
  readonly inSlot: boolean;
  readonly atRoot: boolean;
  readonly depth: number;
  readonly stamp: PreviewStamp | undefined;
  readonly source: MarkedSource;
}

/**
 * The text a located parse read (`parsePage(text, { locs: true })`), whose
 * `start`/`end` offsets every node carries — or undefined for a tree without
 * them. With it, the whitespace between nodes is the file's own; without it,
 * the writer's layout.
 *
 * Why it matters: the marked copy is what the canvas renders in place of the
 * file, so any whitespace it has and the file hasn't is a space on the page
 * that the real build does not show. Each item of
 * `{[...word].map((c) => (\n  <span>{c}</span>\n))}` renders back to back,
 * since the newlines are inside the parentheses, which are JavaScript; the
 * same loop printed with its markers and wrapper on lines of their own put a
 * newline between every pair of inline-block spans, and "today" read
 * "t o d a y" on the canvas.
 */
export type MarkedSource = string | undefined;

/** Where the marked roots of a file or chunk sit: the path of root `index` and
 * the context every root shares. */
export interface MarkedRoots {
  readonly pathOf: (index: number) => string;
  readonly atRoot: boolean;
  readonly stamp: PreviewStamp | undefined;
  readonly source: MarkedSource;
}

/**
 * A list of root nodes, marked, joined by the whitespace between them in the
 * file (or by a line break when the tree has no offsets). The first root
 * starts the text: whatever precedes it is the caller's.
 */
export function serializeNodesMarked(nodes: readonly ParserNode[], roots: MarkedRoots): string {
  assert(nodes.length <= LIMITS.treeNodesMax, 'serializeNodesMarked: node limit');
  const printed = markedSiblings(nodes, { indent: '', outerIndent: '', edges: 'none' }, (index) => ({
    path: roots.pathOf(index),
    inSlot: false,
    atRoot: roots.atRoot,
    depth: 0,
    stamp: roots.stamp,
    source: roots.source,
  }));
  assert(nodes.length > 0 || printed === '', 'serializeNodesMarked: no roots print nothing');
  return printed;
}

// A marker that survives wherever it's put.
//
// A comment is the ideal marker — invisible to :nth-child and friends — but
// Astro's compiler DROPS html comments that are direct children of a
// component, which on a page wrapped in a layout is the entire tree. Verified
// against @astrojs/compiler: kept at the top level and inside elements,
// stripped in slot content. Where a plain comment wouldn't survive, the same
// comment goes in as raw html through a Fragment, which renders nothing of
// its own — so what lands in the DOM is still just a comment.
//
// A marker for a node in a NAMED slot has to carry the `slot` attribute, or it
// lands in the default slot while the node it marks renders in the named one —
// and an attribute needs something to sit on. A <template> was that something
// for a while, and a <template> is an element: it counts for :nth-child,
// :first-child, + and ~, and it sits in the page between the slot's real
// children until the canvas takes it out again. Which is the whole thing
// comments were chosen to avoid, reintroduced in the one place nobody looks.
//
// A <Fragment> takes attributes and renders no element of its own, so it can
// carry both the slot and the comment: what lands in that slot is a comment
// and nothing else.
const markerFor = (path: string, kind: 's' | 'e', { inSlotContent, slotAttr = '' }: { readonly inSlotContent: boolean; readonly slotAttr?: string }) =>
  inSlotContent || slotAttr ? `<Fragment${slotAttr} set:html={${JSON.stringify(`<!--avb-${kind}:${path}-->`)}} />` : `<!--avb-${kind}:${path}-->`;

// `inSlot` says this node is a direct child of a component, i.e. slot content —
// which decides how the marker has to be written, since Astro's compiler drops
// a plain html comment there.
//
// Every element and component also carries its path as an attribute, which is
// the marker that survives what happens to the page after Astro is done with
// it. A component doesn't have to render `<slot />` and leave it at that: it
// can render the slot to a string and put the string back with `set:html`,
// which is how it asks "did my slot render anything?" — and the usual way to
// answer is to drop html comments before looking, since a comment is content
// that isn't:
//
//   const content = await slots.render('default');
//   return content.replace(/<!--[\s\S]*?-->/g, '').trim();  // ← markers gone
//
// Nothing on the page then answers to those paths. The navigator reported
// every row inside such a component as rendering nothing, on a page where they
// were plainly on screen, and nothing in there could be clicked or outlined.
//
// It can't be narrowed to slot content, either: what is being scrubbed is
// everything the slot rendered, which includes the output of every component
// inside it. <Tabs> written at the top of its own file, its markers a page
// away from any slot, still lost every one of them for being placed inside a
// <Section>. So the path rides on the markup everywhere — as the same
// `data-avb-p` the collector writes at runtime, and invisible to :nth-child,
// :first-child, + and ~ in a way a marker node could never be.
//
// On a component the attribute is a prop, and reaching the DOM is then up to
// that component — which is why every file's own ROOT elements carry whatever
// name they were called by, alongside their own (`atRoot`). Waiting for the
// author to spread `{...rest}` was not good enough: a slider written without
// one, placed in a <Section> that scrubs comments, had no marker left and no
// attribute either, so nothing on the page answered to it. The navigator
// showed it as rendering nothing while it was plainly on screen, it drew no
// outline, and it could not be clicked.
//
// The markers stay either way: they are what works when nothing interferes,
// they say where a node ENDS, and they carry the nodes an attribute can't
// (text, a loop, a branch).
//
// A marker adds no whitespace of its own: it sits against the node it marks,
// inside whatever whitespace the file put around that node. Anything else is
// a text node the real build does not have, and between inline-block
// elements a text node is a visible space.
function markedText(node: ParserNode, indent: string, place: MarkedPlace): string {
  const { path, inSlot } = place;
  assert(place.depth <= LIMITS.treeDepthMax, 'markedText: depth limit');
  assert(node.kind !== 'chunk-group', 'markedText: a chunk group is synthetic and is never printed');
  // A slotted node can't simply be wrapped: a marker beside it lands in the
  // default slot while the node itself renders in the named one, so the pair
  // ends up around nothing. Its markers travel with it by carrying the same
  // `slot`, and an attribute needs something to sit on.
  //
  // An element doesn't need wrapping at all: tag it with its path directly,
  // which is the same attribute the collector writes onto every element it
  // records. No extra node, nothing for a selector to trip over.
  //
  // Everything else that can hold an attribute — a component — gets the comment
  // form: a <Fragment slot="…" set:html> carries the slot and renders no
  // element, so what lands in that slot is a comment and the node. In a project
  // whose components read a slot by rendering it to a string and scrubbing the
  // comments out (a common way to ask "did my slot render anything?"), that
  // comment is scrubbed with them — and the path still arrives, because the
  // instance carries it as a prop and its own root writes it onto the DOM.
  //
  // Which leaves the node that can hold no attribute at all: <Fragment
  // slot="…">, which puts nothing of its own on the page and takes no props
  // this could ride on. Its markers go INSIDE it, as its first and last
  // children — the Fragment renders nothing but its contents, so they travel
  // into the named slot with them and need no `slot` of their own. Nothing is
  // added to the slot but two comments.
  //
  // That was a <template> pair, and a <template> is an element: it is a child,
  // it is counted by :nth-child and :last-child, and it is matched by `> *`.
  // CSS written for the children a component is given — which is most CSS
  // written for a component — sees one child that isn't there in the real
  // build. Nothing this writes may be a child.
  const route = serializeNodeMarkedRoute(node, place);
  const body = markedBody(node, indent, place, route);
  if (route.tagInPlace || route.markWithin) {
    return body;
  }
  const slotAttr = route.slotAttr;
  return markedGlue(body, markerFor(path, 's', { inSlotContent: inSlot, slotAttr }), markerFor(path, 'e', { inSlotContent: inSlot, slotAttr }));
}

type MarkedRoute = ReturnType<typeof serializeNodeMarkedRoute>;

function markedBody(node: ParserNode, indent: string, place: MarkedPlace, route: MarkedRoute): string {
  const { path, atRoot, depth, stamp, source } = place;
  assert(depth <= LIMITS.treeDepthMax, 'markedBody: depth limit');
  // Serialized with the path attribute already on it (see above). <Fragment>
  // and <slot> are left out: neither puts an element on the page, so there is
  // nothing for the attribute to ride on.
  if (
    (node.kind === 'component' || node.kind === 'element') &&
    !node.chunkFile &&
    !node.chunkAggregate &&
    Array.isArray(node.children) &&
    // Inline runs serialize as one line — markers between words would break
    // spacing (each marker's surrounding newlines render as a space).
    !(node.children.length > 0 && isInlineRun(node.children, depth + 1))
  ) {
    const children = node.children;
    const open = `<${node.name}${serializeAttrs(route.markedProps, route.attrOrder)}>`;
    const close = `</${node.name}>`;
    const inner =
      children.length === 0
        ? emptyInner(node, source)
        : markedSiblings(children, { indent: indent + '  ', outerIndent: indent, edges: 'markup' }, (i) => ({
            path: `${path}.${i}`,
            inSlot: node.kind === 'component',
            atRoot: node.name === 'Fragment' && atRoot,
            depth: depth + 1,
            stamp,
            source,
          }));
    // A slotted Fragment's own markers, riding inside it (see markWithin).
    // Inside a component, which is what a Fragment is, a plain comment is
    // dropped by the compiler — so they go in the way slot content does.
    if (route.markWithin) {
      return open + markedGlue(inner, markerFor(path, 's', { inSlotContent: true }), markerFor(path, 'e', { inSlotContent: true })) + close;
    }
    return open + inner + close;
  }
  switch (node.kind) {
    case 'map':
      return markedMap(node, indent, place);
    case 'cond':
      return markedCond(node, indent, place);
    case 'branch':
      // No markup of its own — just its contents, wrapped by the marker pair
      // every node gets. A branch sits inside a condition's parentheses,
      // which are JavaScript: the whitespace at its edges is not the page's.
      return markedSiblings(node.children || [], { indent, outerIndent: indent, edges: 'none' }, (i) => ({ ...place, path: `${path}.${i}`, depth: depth + 1 }));
    case 'component':
    case 'element':
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'raw': {
      const base = route.carryPath ? { ...node, props: route.markedProps, attrOrder: route.attrOrder } : node;
      return markedLeaf(base, indent, place);
    }
    case 'chunk-group':
      assert(false, 'markedBody: a chunk group is never printed');
      return '';
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// Where the whitespace at the ends of a list of siblings belongs: inside an
// element's tags it is the page's (`markup`); inside a loop's or a
// condition's parentheses, or before a file's first root, it is not (`none`).
type SiblingEdges = 'markup' | 'none';

/**
 * Siblings, each marked, with the whitespace between them that the file has —
 * and at the ends too, when `edges` says that whitespace is on the page. A
 * tree without offsets is joined the way the writer lays a file out: a line
 * per node.
 */
function markedSiblings(
  nodes: readonly ParserNode[],
  layout: { readonly indent: string; readonly outerIndent: string; readonly edges: SiblingEdges },
  placeOf: (index: number) => MarkedPlace,
): string {
  assert(nodes.length <= LIMITS.treeNodesMax, 'markedSiblings: node limit');
  // A chunk group is synthetic, not in the page source: it prints nothing and
  // has no gap of its own. Indexes still count it, since paths do.
  const printed = nodes.flatMap((node, index) => (node.kind === 'chunk-group' ? [] : [{ node, text: markedText(node, layout.indent, placeOf(index)) }]));
  if (printed.length === 0) {
    return '';
  }
  const first = printed[0];
  const last = printed[printed.length - 1];
  assert(first !== undefined, 'markedSiblings: a non-empty list has a first sibling');
  assert(last !== undefined, 'markedSiblings: a non-empty list has a last sibling');
  const source = placeOf(0).source;
  const gaps = locatedGaps(
    printed.map(({ node }) => node),
    source,
  );
  if (gaps !== undefined) {
    const lead = layout.edges === 'markup' ? gaps.lead : '';
    const trail = layout.edges === 'markup' ? gaps.trail : '';
    return lead + printed.map(({ text }, index) => (index === 0 ? text : (gaps.between[index - 1] ?? '') + text)).join('') + trail;
  }
  const lead = layout.edges === 'markup' ? `\n${layout.indent}` : '';
  const trail = layout.edges === 'markup' ? `\n${layout.outerIndent}` : '';
  return lead + printed.map(({ text }) => text).join(`\n${layout.indent}`) + trail;
}

function markedMap(node: MapNode, indent: string, place: MarkedPlace): string {
  const { path, atRoot, depth, stamp, source } = place;
  assert(depth <= LIMITS.treeDepthMax, 'markedMap: depth limit');
  if (node.bodyParts !== undefined) {
    const text = serializeMapCallback(node, (child, index) => {
      const marked =
        child.kind === 'chunk-group' ? '' : markedText(child, '', { path: `${path}.${index}`, inSlot: true, atRoot, depth: depth + 1, stamp, source });
      return '<Fragment>' + marked + '</Fragment>';
    });
    assert(text.startsWith('{'), 'markedMap: a callback loop is written in braces');
    return text;
  }
  // Loop children render once per item, so their marker pairs repeat in
  // the DOM — the collector unions every instance into one region.
  //
  // The body goes inside a <Fragment>, for the same reason the branches of
  // a `cond` do: what an iteration returns is a marker, the child, and
  // another marker, and `(a b c)` is a list where one expression is wanted.
  // Astro's own compiler accepts it — it reads the children as one template
  // — but Astro 7's Rust compiler (@astrojs/compiler-rs) does not, and the
  // page fails to build with a bare "Unexpected token".
  //
  // Inside that Fragment the children are slot content, where a plain html
  // comment is dropped by both compilers, so the markers have to go in as
  // `set:html` — hence inSlot. Missing that is silent: the page builds and
  // the loop renders, but nothing inside it can be outlined.
  //
  // And the Fragment is written tight against what it holds. Its contents
  // render, whitespace included, where the parentheses around an unwrapped
  // body are JavaScript and render nothing: only a `<>` the file wrote itself
  // has whitespace at its edges that the page shows.
  const children = node.children || [];
  const wrapped = children.length > 0 && (source === undefined ? loopBodyWrapper(node) !== undefined : node.fragment !== undefined);
  const bodyIndent = indent + (node.body && node.body.length ? '      ' : '    ');
  const inner = markedSiblings(children, { indent: bodyIndent + '  ', outerIndent: bodyIndent, edges: wrapped ? 'markup' : 'none' }, (i) => ({
    path: `${path}.${i}`,
    inSlot: true,
    atRoot,
    depth: depth + 1,
    stamp,
    source,
  }));
  const body = `<Fragment>${inner}</Fragment>`;
  if (node.body && node.body.length) {
    const statements = node.body.map((line) => `${indent}    ${line}`);
    return [
      '{',
      `${indent}  ${blockHead(node.head)}`,
      ...statements,
      `${indent}    return (`,
      bodyIndent + body,
      `${indent}    );`,
      `${indent}  })`,
      `${indent}}`,
    ].join('\n');
  }
  return ['{', `${indent}  ${node.head}`, bodyIndent + body, `${indent}  ))`, `${indent}}`].join('\n');
}

function markedCond(node: CondNode, indent: string, place: MarkedPlace): string {
  const { path, atRoot, depth, stamp, source } = place;
  assert(depth <= LIMITS.treeDepthMax, 'markedCond: depth limit');
  // Both branches keep their parens here whether or not they hold anything:
  // the branch's own marker templates are inside them, so they're never the
  // empty `()` the plain writer has to avoid.
  //
  // …and inside those parens goes a <Fragment>. A branch always emits at
  // least three things — its opening marker, its contents, its closing
  // marker — and `cond && ( a b c )` is not valid JSX: the parens hold one
  // expression, not a list. Without the wrapper the compiler stops at the
  // first token after the markers ("Expected `,` or `)` but found `{`") and
  // the page won't build. Fragment renders no element, so the markers stay
  // siblings of the content in the DOM, which is what the canvas needs. It
  // is written tight against them, as a loop's is (see markedMap): the
  // parens are JavaScript, and nothing at their edges is on the page.
  const branches = node.children || [];
  const inner = indent + '    ';
  // Slot content of that Fragment, so the markers must be the `set:html`
  // form — a plain comment directly inside a component is dropped, which
  // left everything in a branch unoutlinable.
  // A root written as a condition — `{render && (<div/>)}` — is still the
  // root: what the branch renders is what the caller placed.
  const branchOut = (branch: ParserNode | undefined, i: number): string =>
    inner +
    '<Fragment>' +
    (branch === undefined ? '' : markedText(branch, inner + '  ', { path: `${path}.${i}`, inSlot: true, atRoot, depth: depth + 1, stamp, source })) +
    '</Fragment>';
  const lines = ['{', indent + '  ' + node.test + (node.op === '&&' ? ' && (' : ' ? ('), branchOut(branches[0], 0)];
  if (node.op === '&&') {
    lines.push(indent + '  )');
  } else {
    lines.push(indent + '  ) : (', branchOut(branches[1], 1), indent + '  )');
  }
  lines.push(indent + '}');
  assert(node.op === '&&' || branches.length <= 2, 'markedCond: a ternary has two branches');
  return lines.join('\n');
}

function serializeNodeMarkedRoute(node: ParserNode, { path, atRoot, depth, stamp }: MarkedPlace) {
  const slotValue = node.props?.['slot'];
  const slotted = slotValue && slotValue.type === 'string' && !!slotValue.value;
  const tagInPlace = slotted && node.kind === 'element';
  const slotAttr = slotted ? ` slot="${slotValue.value}"` : '';
  // A slotted node with no element and no props of its own — its markers can
  // only ride inside it, which needs children to ride in.
  const markWithin =
    slotted &&
    (node.name === 'Fragment' || node.name === 'slot') &&
    Array.isArray(node.children) &&
    node.children.length > 0 &&
    !isInlineRun(node.children, depth + 1);
  const carryPath = (node.kind === 'element' || node.kind === 'component') && node.name !== 'Fragment' && node.name !== 'slot';
  // Where the node forwards its rest props, the caller's path for this
  // instance arrives inside the spread, and both want the same attribute. So
  // the one written here names BOTH — its own path and whatever came in on
  // Astro.props — and then has to be the one that survives.
  //
  // Which side of the spread that is depends on what the spread is. An
  // element's attributes are text: two `data-avb-p=` land in the tag and an
  // html parser keeps the FIRST, so this one goes before the spread. A
  // component's are an object: the later key overwrites, so this one goes
  // after it. Getting that backwards is silent — the tag is there, holding
  // the wrong file's path. With <Tabs> open, its root div kept the page's
  // path and a click on it resolved to nothing, which is how the canvas says
  // "you're done in here": the component closed itself the moment you clicked
  // inside it.
  const forwards = Object.keys(node.props || {}).some((key) => key.startsWith('...'));
  // A root carries its caller's name whether or not the author asked for it:
  // this element IS what the caller placed, so the caller's path for it has
  // nowhere better to be. On a page the same expression reads undefined and
  // falls away, since a page has no caller.
  const carriesCaller = forwards || atRoot;
  const pathProp: Attr = carriesCaller
    ? {
        type: 'expr',
        value: `[${JSON.stringify(path)}, Astro.props["data-avb-p"]].filter(Boolean).join(" ")`,
      }
    : { type: 'string', value: path };
  const carriesStamp = carryPath && atRoot && stamp !== undefined;
  const stampProp: Attr | undefined = carriesStamp
    ? {
        type: 'expr',
        value: `[${JSON.stringify(stampData(stamp))}, ` + `Astro.props[${JSON.stringify(PREVIEW_STAMP_ATTRIBUTE)}]]` + '.filter(Boolean).join("\\n")',
      }
    : undefined;
  const markerNames = carriesStamp ? ['data-avb-p', PREVIEW_STAMP_ATTRIBUTE] : ['data-avb-p'];
  const markerProps = stampProp ? { 'data-avb-p': pathProp, [PREVIEW_STAMP_ATTRIBUTE]: stampProp } : { 'data-avb-p': pathProp };
  // The path attribute is put where this function decided to put it, not where
  // the file's order would have it — it was never in the file.
  const attrOrder =
    !carryPath || !node.attrOrder
      ? node.attrOrder
      : forwards && node.kind === 'element'
        ? [...markerNames, ...node.attrOrder]
        : [...node.attrOrder, ...markerNames];
  const markedProps = !carryPath ? node.props : forwards && node.kind === 'element' ? { ...markerProps, ...node.props } : { ...node.props, ...markerProps };
  return {
    tagInPlace,
    markWithin,
    slotAttr,
    carryPath,
    markedProps,
    attrOrder,
  };
}

// A node with no marked children: text, an expression, a comment, a raw
// block, a void or chunk element, or an element whose children are an inline
// run. A located one is the file's own text wherever nothing is added to it,
// so not a character of whitespace moves.
function markedLeaf(base: ParserNode, indent: string, { path, atRoot, depth, source }: MarkedPlace): string {
  assert(depth <= LIMITS.treeDepthMax, 'markedLeaf: depth limit');
  const span = spanOf(base, source);
  if (span !== undefined && writtenVerbatim(base)) {
    return span.text;
  }
  const inlineKids =
    (base.kind === 'component' || base.kind === 'element') &&
    !base.chunkFile &&
    !base.chunkAggregate &&
    Array.isArray(base.children) &&
    base.children.length > 0 &&
    isInlineRun(base.children, depth + 1);
  if (inlineKids && (base.kind === 'element' || base.kind === 'component')) {
    assert(base.children !== undefined, 'Inline run has children');
    const tagged = tagInlineRun(base.children, path, {
      atRoot: base.name === 'Fragment' && atRoot,
      depth: depth + 1,
    });
    const located = inlineRunLocated(tagged, source, depth + 1);
    if (located !== undefined) {
      return `<${base.name}${serializeAttrs(base.props, base.attrOrder)}>${located}</${base.name}>`;
    }
    return printed({ ...base, source: undefined, children: tagged }, indent, depth);
  }
  return printed(base, indent, depth);
}

// The kinds whose range of the file is exactly what the marked copy writes:
// text and raw blocks are markup on both sides. An expression or a comment is
// not: its range can be the bare JavaScript inside a branch's parentheses —
// `( /* note */ <nav/> )` reads as an expression with no braces of its own —
// and copied into the Fragment that holds the branch, those characters are
// text on the page. Those are written from their value, which carries its
// braces; the whitespace around them still comes from the file.
function writtenVerbatim(node: ParserNode): boolean {
  switch (node.kind) {
    case 'text':
    case 'raw':
      return true;
    case 'expr':
    case 'comment':
    case 'raw-line':
    case 'component':
    case 'element':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return false;
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

// An inline run's children as the file wrote them, each element carrying the
// path tagInlineRun gave it, and every space between, before and after them
// the file's own. Undefined when the run has no offsets to take them from.
function inlineRunLocated(nodes: readonly ParserNode[], source: MarkedSource, depth: number): string | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'inlineRunLocated: depth limit');
  const gaps = locatedGaps(nodes, source);
  if (gaps === undefined) {
    return undefined;
  }
  let out = gaps.lead;
  for (const [index, node] of nodes.entries()) {
    if (index > 0) {
      out += gaps.between[index - 1] ?? '';
    }
    const text = inlineNodeLocated(node, source, depth);
    if (text === undefined) {
      return undefined;
    }
    out += text;
  }
  assert(out.length > 0, 'inlineRunLocated: a run with children prints them');
  return out + gaps.trail;
}

function inlineNodeLocated(node: ParserNode, source: MarkedSource, depth: number): string | undefined {
  const span = spanOf(node, source);
  if (span === undefined) {
    return undefined;
  }
  if (node.kind === 'text') {
    return span.text;
  }
  if (node.kind === 'expr') {
    return node.value; // In braces, as isInlineRun requires; see writtenVerbatim.
  }
  // isInlineRun admits text, simple expressions and inline elements only.
  assert(node.kind === 'element', 'inlineNodeLocated: an inline run holds text, expressions and elements');
  const open = `<${node.name}${serializeAttrs(node.props, node.attrOrder)}`;
  if (node.children === undefined) {
    return `${open} />`;
  }
  if (node.children.length === 0) {
    return `${open}>${emptyInner(node, source)}</${node.name}>`;
  }
  const inner = inlineRunLocated(node.children, source, depth + 1);
  return inner === undefined ? undefined : `${open}>${inner}</${node.name}>`;
}

// What the file holds between an element's tags when it holds no nodes:
// whitespace, which the page shows as one space between inline neighbours.
// Without offsets, the inner the parser kept for the plain writer, if any.
function emptyInner(node: ParserNode, source: MarkedSource): string {
  const span = spanOf(node, source);
  if (span === undefined) {
    return node.source !== undefined && node.source.trim() === '' ? node.source : '';
  }
  const close = span.text.lastIndexOf('</');
  assert(close > 0, 'emptyInner: a paired element ends with its closing tag');
  return whitespaceBefore(span.text, close);
}

// The plain writer's lines for a node, as text whose first line carries no
// indent: the caller puts the node where it goes.
function printed(node: ParserNode, indent: string, depth: number): string {
  const lines: string[] = [];
  serializeNode(node, indent, lines, depth);
  const text = lines.join('\n');
  return text.startsWith(indent) ? text.slice(indent.length) : text;
}

/** A located node's range and text, or undefined when either is missing. */
function spanOf(node: ParserNode, source: MarkedSource): { readonly start: number; readonly end: number; readonly text: string } | undefined {
  if (source === undefined) {
    return undefined;
  }
  const { start, end } = node;
  if (start === undefined || end === undefined) {
    return undefined;
  }
  assert(start <= end, 'spanOf: a node starts before it ends');
  assert(end <= source.length, 'spanOf: offsets index the text they were read from');
  return { start, end, text: source.slice(start, end) };
}

/**
 * The whitespace the file has in front of the first node, between each pair,
 * and after the last — or undefined when a node has no offsets, or two
 * neighbours have something other than whitespace between them (then the
 * offsets don't describe these nodes as written, and nothing is taken from
 * them).
 */
function locatedGaps(
  nodes: readonly ParserNode[],
  source: MarkedSource,
): { readonly lead: string; readonly between: readonly string[]; readonly trail: string } | undefined {
  if (source === undefined) {
    return undefined;
  }
  const spans = nodes.map((node) => spanOf(node, source));
  const located = spans.filter((span) => span !== undefined);
  if (located.length < nodes.length) {
    return undefined;
  }
  const first = located[0];
  const last = located[located.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const between: string[] = [];
  for (let index = 1; index < located.length; index++) {
    const left = located[index - 1];
    const right = located[index];
    assert(left !== undefined, 'locatedGaps: index is in bounds');
    assert(right !== undefined, 'locatedGaps: index is in bounds');
    if (right.start < left.end) {
      return undefined;
    }
    const gap = source.slice(left.end, right.start);
    if (whitespaceBefore(gap, gap.length) !== gap) {
      return undefined;
    }
    between.push(gap);
  }
  return { lead: whitespaceBefore(source, first.start), between, trail: whitespaceAfter(source, last.end) };
}

// HTML's whitespace: what a browser collapses into one space. A no-break
// space is not in it; that one is content.
const HTML_WHITESPACE = new Set([' ', '\t', '\n', '\f', '\r']);

/** The run of whitespace that ends at `offset`. */
function whitespaceBefore(text: string, offset: number): string {
  assert(offset <= text.length, 'whitespaceBefore: offset is in the text');
  let start = offset;
  while (start > 0 && HTML_WHITESPACE.has(text[start - 1] ?? '')) {
    start--;
  }
  return text.slice(start, offset);
}

/** The run of whitespace that starts at `offset`. */
function whitespaceAfter(text: string, offset: number): string {
  assert(offset <= text.length, 'whitespaceAfter: offset is in the text');
  let end = offset;
  while (end < text.length && HTML_WHITESPACE.has(text[end] ?? '')) {
    end++;
  }
  return text.slice(offset, end);
}

/**
 * `text` with `start` and `end` against its content: after any whitespace it
 * opens with and before any it closes with. The whitespace stays exactly
 * where it was, outside the markers, so the markers add none. Text that is
 * all whitespace goes between them whole.
 */
export function markedGlue(text: string, start: string, end: string): string {
  const lead = whitespaceAfter(text, 0);
  if (lead.length === text.length) {
    return start + text + end;
  }
  const trail = whitespaceBefore(text, text.length);
  const content = text.slice(lead.length, text.length - trail.length);
  assert(content.length > 0, 'markedGlue: text with something besides whitespace keeps it');
  return lead + start + content + end + trail;
}
