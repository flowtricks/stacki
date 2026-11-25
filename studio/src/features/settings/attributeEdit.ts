// The Settings panel's attribute writes, as Studio makes them: the Attributes
// section's rows, a component's props and a field's own attribute (class, slot,
// href) are each planned by the source planner Desktop's documents use
// (shared/engine/planner.ts), with the intents Desktop's edit gestures send
// (src/editor/editGestures.ts):
//
//   - a value set is `set-attribute`: the value alone when its quotes can stay,
//     a new attribute written after the node's last one, on that one's line;
//   - a value cleared is `remove-attribute`, with the space in front of it;
//   - a name changed is `rename-attribute`, the name's bytes alone, after the
//     name it takes over is removed, as Desktop's rename gesture does;
//   - a spread (`{...rest}`) has no name of its own, so the planner refuses to
//     touch it by name; removing one is the node's own bytes rewritten
//     (`rewrite-node`), the spread and the space in front of it taken out.
//
// This runs in the browser, where the server's planner wrapper
// (source/sourcePlanner.ts) cannot: that one hashes with node:crypto. Each plan
// here is made against the one snapshot its intent names, so the checksum
// only has to match itself and a fixed one serves; the shared document, not a
// checksum, is what orders concurrent writes.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { DescribedError } from '../../../vendor/stacki/shared/properties/describedError';
import { described, type Described } from '../../../vendor/stacki/shared/properties/i18n/messageRef';
import { toDigest, toFilePath, toIntentId } from '../../../vendor/stacki/shared/core/brand';
import { LIMITS } from '../../../vendor/stacki/shared/core/limits';
import { toByteSpan, toByteString } from '../../../vendor/stacki/shared/core/span';
import { toIntent, type Operation } from '../../../vendor/stacki/shared/engine/intent';
import { planIntent } from '../../../vendor/stacki/shared/engine/planner';
import { parsePageResult, type Attr, type PageNode } from '../../../vendor/stacki/shared/page/pageNode';
import { toAnchorRef } from '../../../vendor/stacki/shared/page/ref';
import { createSnapshot } from '../../../vendor/stacki/shared/page/snapshot';
import { projectPage, type ProjectedNode } from '../../../vendor/stacki/shared/page/sourceProjection';
import { parsePage } from '../../../vendor/stacki/electron/parse/astroParser';
import { applyEdits, nodeAt, type Edit } from '../source/source';
import type { Component } from '../project/projectClient';

/** Whether the selection shows the free-form Attributes section, by Desktop's rule
 * (settingsValues in src/app/shell/AppPanes.tsx): an element, a dynamic tag (it
 * renders a real element), or an instance whose component forwards `...rest`.
 * Any other instance's attributes are its props, each a field of its own. */
export function takesAttributes(node: PageNode | { readonly kind: 'frontmatter' } | undefined, component: Pick<Component, 'hasRest'> | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  if (node.kind === 'element') {
    return true;
  }
  if (node.kind === 'component') {
    return node.dynamicTag === true || component?.hasRest === true;
  }
  return false;
}

/** The checksum every browser-side plan names; see the header for why one serves. */
const SNAPSHOT_DIGEST = toDigest('0'.repeat(64));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The page with node `id`'s attributes set to `values` in order: a value sets
 * the attribute, undefined removes it. Each write is planned on the page the one
 * before it left, as Desktop's gesture sends them as one request. */
export function writeAttributes(source: string, id: string, values: Readonly<Record<string, Attr | undefined>>): string {
  const entries = Object.entries(values);
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'An attribute write stays inside the per-node bound');
  let next = source;
  for (const [name, value] of entries) {
    next = applyEdits(next, attributeWrite(next, id, name, value));
  }
  return next;
}

/** The page with node `id`'s attribute `from` named `to`, keeping its value and
 * its place. An attribute already named `to` gives up its place to the rename. */
export function renameAttribute(source: string, id: string, from: string, to: string): string {
  assert(from !== to, 'A rename changes the name');
  const props = nodeAt(source, id).props ?? {};
  if (!Object.hasOwn(props, from)) {
    throw new Error('Selection changed. Select the element again.');
  }
  const cleared = Object.hasOwn(props, to) ? writeAttributes(source, id, { [to]: undefined }) : source;
  const next = applyEdits(cleared, plannedEdits(cleared, id, { tag: 'rename-attribute', from, to }));
  assert(Object.hasOwn(nodeAt(next, id).props ?? {}, to), 'The renamed attribute reads back under its new name');
  return next;
}

function attributeWrite(source: string, id: string, name: string, value: Attr | undefined): readonly Edit[] {
  if (value === undefined) {
    if (name.startsWith('...')) {
      return spreadRemoval(source, id, name);
    }
    return Object.hasOwn(nodeAt(source, id).props ?? {}, name) ? plannedEdits(source, id, { tag: 'remove-attribute', name }) : [];
  }
  switch (value.type) {
    case 'string':
    case 'expr':
      return plannedEdits(source, id, { tag: 'set-attribute', name, value });
    case 'bare':
      return plannedEdits(source, id, { tag: 'set-attribute', name, value: { type: 'bare' } });
    case 'spread':
      // The Attributes section shows a spread read-only; a new one is code.
      throw new Error('Add a spread in Code.');
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** A spread's own bytes and the whitespace in front of it, rewritten as nothing. */
function spreadRemoval(source: string, id: string, name: string): readonly Edit[] {
  const planned = planning(source, id);
  const spreads = planned.node.attributes.filter((attribute) => attribute.name === name);
  if (spreads.length !== 1) {
    throw new Error('Remove this spread in Code.');
  }
  const [spread] = spreads;
  assert(spread !== undefined, 'One spread was found');
  assert(spread.type === 'spread', 'A name that starts with an ellipsis is a spread');
  let start = spread.span.start;
  for (let step = 0; step < LIMITS.attrCharsMax && start > planned.node.span.start; step++) {
    const before = planned.bytes[start - 1];
    if (before === 0x20 || before === 0x09 || before === 0x0a || before === 0x0d) {
      start--;
    } else {
      break;
    }
  }
  assert(start > planned.node.span.start, 'A spread sits after its tag name');
  return planned.plan({ tag: 'rewrite-node', hunks: [{ span: toByteSpan(start, spread.span.end), text: '' }] });
}

function plannedEdits(source: string, id: string, operation: Operation): readonly Edit[] {
  return planning(source, id).plan(operation);
}

/** The page snapshot, node `id` as the planner sees it, and a planner of intents on it. */
function planning(source: string, id: string) {
  const bytes = encoder.encode(source);
  const projection = projectPage(source, parsePageResult(parsePage(source, { locs: true })));
  if (projection.tag !== 'valid') {
    throw new Error('Fix the page syntax before changing its attributes.');
  }
  const snapshot = createSnapshot({ path: toFilePath('/studio/source.astro'), bytes: toByteString(bytes), projection }, () => SNAPSHOT_DIGEST);
  const written = nodeAt(source, id);
  assert(written.start !== undefined, 'A selected node has a source start');
  assert(written.end !== undefined, 'A selected node has a source end');
  const start = encoder.encode(source.slice(0, written.start)).length;
  const end = encoder.encode(source.slice(0, written.end)).length;
  const node: ProjectedNode | undefined = projection.nodes.find((item) => item.span.start === start && item.span.end === end && item.kind === written.kind);
  if (node === undefined) {
    throw new Error('Selection changed. Select the element again.');
  }
  const offset = (byte: number) => decoder.decode(bytes.subarray(0, byte)).length;
  const plan = (operation: Operation): readonly Edit[] => {
    const result = planIntent(
      { authored: snapshot, current: snapshot },
      toIntent({
        id: toIntentId('studio-attribute'),
        file: snapshot.path,
        authoredChecksum: snapshot.checksum,
        anchor: toAnchorRef({ span: node.span, path: node.path, expectedKind: node.kind }),
        operation,
      }),
    );
    if (!result.ok) {
      throw new DescribedError(refusal(result.error));
    }
    return result.value.splices.map((splice) => ({
      start: offset(splice.range.start),
      end: offset(splice.range.end),
      text: decoder.decode(splice.replacementBytes),
    }));
  };
  return { bytes, node, plan };
}

/** What the panel says when the planner will not write an attribute here. */
function refusal(reason: string): Described {
  switch (reason) {
    case 'anchor-ambiguous':
      return described('settings.element.attr.ambiguous');
    case 'unsupported-operation':
      return described('settings.element.attr.code');
    default:
      return described('settings.element.attr.unsafe', { reason });
  }
}
