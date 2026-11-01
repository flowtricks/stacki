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
import { isInlineRun, tagInlineRun, serializeNode } from './astroSerialize';
import { serializeMapCallback } from './astroMapSerialize';

// Where one node sits for the marked writer: its path, whether it is slot content (which decides
// how its markers are written), whether it is one of its file's own roots (see `atRoot` below),
// and how deep in the tree it is.
interface MarkedPlace {
  readonly path: string;
  readonly inSlot: boolean;
  readonly atRoot: boolean;
  readonly depth: number;
  readonly stamp: PreviewStamp | undefined;
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
export function serializeNodeMarked(node: ParserNode, indent: string, lines: string[], place: MarkedPlace): void {
  const { path, inSlot, atRoot, depth, stamp } = place;
  assert(depth <= LIMITS.treeDepthMax, 'serializeNodeMarked: depth limit');
  if (node.kind === 'chunk-group') {
    return;
  } // synthetic, not in page source
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
  const { tagInPlace, markWithin, slotAttr, carryPath, markedProps, attrOrder } = serializeNodeMarkedRoute(node, place);
  if (!tagInPlace && !markWithin) {
    lines.push(indent + markerFor(path, 's', { inSlotContent: inSlot, slotAttr }));
  }
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
    const attrs = serializeAttrs(markedProps, attrOrder);
    lines.push(`${indent}<${node.name}${attrs}>`);
    // A slotted Fragment's own markers, riding inside it (see markWithin).
    // Inside a component, which is what a Fragment is, a plain comment is
    // dropped by the compiler — so they go in the way slot content does.
    if (markWithin) {
      lines.push(indent + '  ' + markerFor(path, 's', { inSlotContent: true }));
    }
    node.children.forEach((child, i) =>
      serializeNodeMarked(child, indent + '  ', lines, {
        path: `${path}.${i}`,
        inSlot: node.kind === 'component',
        atRoot: node.name === 'Fragment' && atRoot,
        depth: depth + 1,
        stamp,
      }),
    );
    if (markWithin) {
      lines.push(indent + '  ' + markerFor(path, 'e', { inSlotContent: true }));
    }
    lines.push(`${indent}</${node.name}>`);
  } else if (node.kind === 'map') {
    if (serializeNodeMarkedMap(node, indent, lines, place) === 'complete') {
      return;
    }
  } else if (node.kind === 'cond') {
    serializeNodeMarkedCond(node, indent, lines, place);
  } else if (node.kind === 'branch') {
    // No markup of its own — just its contents, wrapped by the marker pair
    // this function already emits around every node.
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, indent, lines, {
        path: `${path}.${i}`,
        inSlot,
        atRoot,
        depth: depth + 1,
        stamp,
      }),
    );
  } else {
    const base = carryPath ? { ...node, props: markedProps, attrOrder } : node;
    serializeNodeMarkedInline(base, indent, lines, place);
  }
  if (!tagInPlace && !markWithin) {
    lines.push(indent + markerFor(path, 'e', { inSlotContent: inSlot, slotAttr }));
  }
}

function serializeNodeMarkedMap(node: MapNode, indent: string, lines: string[], { path, atRoot, depth, stamp }: MarkedPlace): 'complete' | 'continue' {
  if (node.bodyParts !== undefined) {
    const text = serializeMapCallback(node, (child, index) => {
      const marked: string[] = [];
      serializeNodeMarked(child, '', marked, {
        path: `${path}.${index}`,
        inSlot: true,
        atRoot,
        depth: depth + 1,
        stamp,
      });
      return '<Fragment>' + marked.join('\n') + '</Fragment>';
    });
    lines.push(indent + text);
    return 'continue';
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
  lines.push(indent + '{');
  const loopBody = (bodyIndent: string) => {
    lines.push(bodyIndent + '<Fragment>');
    (node.children || []).forEach((child, i) =>
      serializeNodeMarked(child, bodyIndent + '  ', lines, {
        path: `${path}.${i}`,
        inSlot: true,
        atRoot,
        depth: depth + 1,
        stamp,
      }),
    );
    lines.push(bodyIndent + '</Fragment>');
  };
  if (node.body && node.body.length) {
    lines.push(indent + '  ' + blockHead(node.head));
    for (const line of node.body) {
      lines.push(indent + '    ' + line);
    }
    lines.push(indent + '    return (');
    loopBody(indent + '      ');
    lines.push(indent + '    );');
    lines.push(indent + '  })');
    lines.push(indent + '}');
    return 'complete';
  }
  lines.push(indent + '  ' + node.head);
  loopBody(indent + '    ');
  lines.push(indent + '  ))');
  lines.push(indent + '}');

  return 'continue';
}

function serializeNodeMarkedCond(node: CondNode, indent: string, lines: string[], { path, atRoot, depth, stamp }: MarkedPlace): void {
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
  // siblings of the content in the DOM, which is what the canvas needs.
  const branches = node.children || [];
  const inner = indent + '    ';
  const branchOut = (branch: ParserNode | undefined, i: number) => {
    lines.push(inner + '<Fragment>');
    // Slot content of that Fragment, so the markers must be the `set:html`
    // form — a plain comment directly inside a component is dropped, which
    // left everything in a branch unoutlinable.
    // A root written as a condition — `{render && (<div/>)}` — is still the
    // root: what the branch renders is what the caller placed.
    if (branch) {
      serializeNodeMarked(branch, inner + '  ', lines, {
        path: `${path}.${i}`,
        inSlot: true,
        atRoot,
        depth: depth + 1,
        stamp,
      });
    }
    lines.push(inner + '</Fragment>');
  };
  lines.push(indent + '{');
  lines.push(indent + '  ' + node.test + (node.op === '&&' ? ' && (' : ' ? ('));
  branchOut(branches[0], 0);
  if (node.op === '&&') {
    lines.push(indent + '  )');
  } else {
    lines.push(indent + '  ) : (');
    branchOut(branches[1], 1);
    lines.push(indent + '  )');
  }
  lines.push(indent + '}');
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

function serializeNodeMarkedInline(base: ParserNode, indent: string, lines: string[], { path, atRoot, depth }: MarkedPlace): void {
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
    serializeNode({ ...base, source: undefined, children: tagged }, indent, lines, depth);
  } else {
    serializeNode(base, indent, lines, depth);
  }
}
