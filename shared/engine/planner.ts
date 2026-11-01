// The intent planner (plan §5.2 steps 2–6): which bytes an intent replaces, and
// what they must hold. Pure — snapshots and an intent in, a Result out; no I/O,
// no clock, no randomness — so the simulator calls it directly and the actor
// wraps it with the disk (plan §5.2, invariant 9 by construction).
//
// Every operation plans against an intent that may be stale: its anchor is
// resolved in the bytes it was authored against, the node's identity region is
// mapped through the diff to the bytes on disk now (mapSpan.ts, planSupport.ts),
// and the splices are planned at the mapped place, witnessed by the authored
// bytes. The identity region runs from the tag name through the end of the last
// attribute: `Hero title="Old"` in `<Hero title="Old" />`. It carries the
// element's identity and holds every attribute an edit replaces. Smaller fails:
// the value alone repeats everywhere (`title="Old"` on the hero and the footer).
// Larger fails too: the whole element would refuse an attribute edit whenever
// someone edits text inside it, and the tag's own `<` and `/>` are bytes every
// neighbouring tag shares — insert `<div>` before `<Hero`, and a script that
// matches Hero's `<` to the div's costs exactly as little as the true one, so
// the mapper, which never picks between tied scripts, would call it ambiguous.
// A node that is not a tag — text, an expression, a loop — is its whole span.
//
// The witness guards staleness, not identity (plan §3.4); identity comes from
// the mapping, which rejects on ambiguity. This module holds the dispatch and
// the attribute family (`set-attribute`, `remove-attribute`,
// `set-inline-style`, and step 9's `rename-attribute`) with the tag rename;
// planTree.ts plans insertions, removals and moves, and planText.ts the
// operations that name byte ranges directly (a loop rename's sites, a
// frontmatter slot, code patches, reverts, node rewrites, the whole-file
// replacement). Step 6 (plan §11) shipped the first set; step 9 the rest.
import { assert } from '../core/assert';
import { countOccurrences } from './byteSearch';
import { diffBytes, DIFF_BUDGET } from './diff';
import { editInlineStyle } from './inlineStyle';
import type { AttributeValue, Intent, Operation, RejectionReason } from './intent';
import { LIMITS } from '../core/limits';
import { mapSpanThroughDiff, type SpanMapping } from './mapSpan';
import {
  byteOffsetsIn,
  closeTagStart,
  containsNewline,
  isWhitespace,
  lineIndent,
  nodeEditable,
  openTagEnd,
  resolveTarget,
  tagNameEnd,
  textOf,
  whitespaceBefore,
  writtenAsTag,
  type PlanContext,
  type SpanMapper,
  type Target,
} from './planSupport';
import { planAppendBody, planInsertNode, planMoveNode, planRemoveNode, planWrapNodes } from './planTree';
import { planCodePatch, planFrontmatterSlot, planInsertFrontmatter, planRenameBinding, planRewriteText, planRevertSplices, planRewriteNode } from './planText';
import type { AnchorRef, NodeKind, StructuralPath } from '../page/ref';
import { err, ok, type Result } from '../core/result';
import type { Snapshot } from '../page/snapshot';
import type { ProjectedAttribute, ProjectedNode } from '../page/sourceProjection';
import { byteStringsEqual, encodeUtf8, toByteSpan, toByteString, type ByteSpan, type ByteString } from '../core/span';

/** The only write primitive (plan §3.4): replace `range` with
 * `replacementBytes`, but only while it still holds `expectedBytes`. An
 * insertion is a zero-width range: its identity was proven by resolving the
 * node it sits beside, and the actor re-verifies the whole file under its lock.
 * Keeping insertions zero-width keeps every other span outside them, so the
 * inverse is exact and later rebases never have to cut through a neighbour. */
export interface Splice {
  readonly range: ByteSpan;
  readonly expectedBytes: ByteString;
  readonly replacementBytes: ByteString;
}

export interface PostKind {
  readonly path: StructuralPath;
  readonly kind: NodeKind;
}

/** What the candidate must satisfy after the splices apply (plan §5.2 step 6).
 * Visual intents need a parsing candidate; the code editor and the legacy save
 * may write invalid bytes (plan §3.6). */
export type CandidatePolicy = 'must-parse' | 'may-be-invalid';

export interface Plan {
  readonly splices: readonly Splice[];
  /** An unchanged subtree explicitly moved by this plan, in before/after coordinates.
   * Keeping its provenance lets queued edits follow it without matching lookalikes. */
  readonly relocation?: ByteRelocation | undefined;
  /** Nodes that must keep their kind in the candidate, in its own paths. */
  readonly postKinds: readonly PostKind[];
  readonly candidate: CandidatePolicy;
}

export interface ByteRelocation {
  readonly source: ByteSpan;
  readonly target: ByteSpan;
}

export interface PlanningBase {
  /** The snapshot the intent was authored against: its checksum is the
   * intent's `authoredChecksum`. */
  readonly authored: Snapshot;
  /** The snapshot of the bytes on disk now (plan §5.2 step 1). */
  readonly current: Snapshot;
}

/** Plan an intent. When nothing changed since it was authored, the mapping is
 * the identity and no diff runs — the fast path; `planIntentThroughDiff` is its
 * brute-force reference and must agree with it (plan §10). */
export function planIntent(base: PlanningBase, intent: Intent): Result<Plan, RejectionReason> {
  if (base.authored.checksum === base.current.checksum) {
    assert(byteStringsEqual(base.authored.bytes, base.current.bytes), 'Equal checksums name equal bytes');
    return planWith(base, intent, (span) => ({ tag: 'resolved', span }));
  }
  return planIntentThroughDiff(base, intent);
}

/** The same planner with every span mapped through a computed diff, even an
 * empty one. The actor calls `planIntent`; tests call this to hold the
 * identity fast path to it. */
export function planIntentThroughDiff(base: PlanningBase, intent: Intent): Result<Plan, RejectionReason> {
  // The diff runs once, on the first span that needs it, and only then: a
  // rejection before any mapping costs no diff. Local, private memo state.
  let computed: ReturnType<typeof diffBytes> | undefined;
  return planWith(base, intent, (span) => {
    computed ??= diffBytes(base.authored.bytes, base.current.bytes, DIFF_BUDGET);
    switch (computed.tag) {
      case 'computed':
        return uniqueOrAmbiguous(base, computed.diff.distance, mapSpanThroughDiff(computed.diff, span));
      case 'too-costly':
        return { tag: 'too-costly' };
      default: {
        const exhaustive: never = computed;
        return exhaustive;
      }
    }
  });
}

// --- Internal ----------------------------------------------------------------

// A resolved remap names bytes equal to the authored identity region. Those
// bytes are only proof of identity if they occur once in each file: if the
// target's region survives intact, it is an occurrence, so a unique occurrence
// is the target (the invariant) — unless another authored element held the
// same bytes and survived while the target went. Where they repeat, the
// minimum edit script can still be unique and wrong — edit above, paste a copy
// of the target, and the cheapest script maps the target onto the copy (the
// step-3 wrong-site plans, planner.test.ts); or remove the target beside its
// twin, and the cheapest script maps the target onto the twin (step 10). The
// minimum script is not the history, so repeated bytes are ambiguous whatever
// the script says. A distance of zero maps by identity and holds nothing to
// guess, so the fast path and this one agree.
//
// Not covered, and not coverable from bytes: a copy of the target pasted while
// another writer rewrites the original's region. The same bytes arise from an
// element inserted above the untouched target; only history tells them apart.
function uniqueOrAmbiguous(base: PlanningBase, distance: number, mapped: SpanMapping): SpanMapping {
  assert(Number.isSafeInteger(distance), 'The diff distance is an integer');
  if (mapped.tag === 'resolved') {
    if (distance > 0) {
      const region = toByteString(base.current.bytes.subarray(mapped.span.start, mapped.span.end));
      const occurrences = countOccurrences(base.current.bytes, region, 2);
      assert(occurrences >= 1, 'The resolved region occurs where it was mapped');
      // The resolved bytes equal the authored region, so they occur there too.
      const authoredOccurrences = countOccurrences(base.authored.bytes, region, 2);
      assert(authoredOccurrences >= 1, 'The resolved region is the authored region');
      if (occurrences === 1) {
        if (authoredOccurrences === 1) {
          return mapped;
        }
        return { tag: 'ambiguous' }; // A twin of the target may be the survivor.
      }
      return { tag: 'ambiguous' };
    }
    return mapped; // Identical files: the identity mapping guesses nothing.
  }
  return mapped;
}

function planWith(base: PlanningBase, intent: Intent, mapSpan: SpanMapper): Result<Plan, RejectionReason> {
  assert(base.authored.path === intent.file, 'An intent is planned against its own file');
  assert(base.current.path === intent.file, 'The current snapshot is of the intent file');
  assert(base.authored.checksum === intent.authoredChecksum, 'The authored snapshot is the one the intent names');
  const context: PlanContext = { authored: base.authored, current: base.current, mapSpan };
  const anchor = intent.anchor;
  const operation = intent.operation;
  switch (operation.tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style':
      return planAttributeOperation(context, anchor, operation);
    case 'insert-node':
      return planInsertNode(context, anchor, operation);
    case 'remove-node':
      return planRemoveNode(context, anchor);
    case 'move-node':
      return planMoveNode(context, anchor, operation);
    case 'wrap-nodes':
      return planWrapNodes(context, anchor, operation);
    case 'append-body':
      return planAppendBody(context, anchor, operation);
    case 'rename-binding':
      return planRenameBinding(context, anchor, operation);
    case 'edit-frontmatter-slot':
      return planFrontmatterSlot(context, anchor, operation);
    case 'insert-frontmatter':
      return planInsertFrontmatter(context, anchor, operation);
    case 'apply-code-patch':
      return planCodePatch(context, anchor, operation);
    case 'revert-splices':
      return planRevertSplices(context, anchor, operation);
    case 'rename-tag':
      return planRenameTag(context, anchor, operation);
    case 'rename-attribute':
      return planRenameAttribute(context, anchor, operation);
    case 'rewrite-node':
      return planRewriteNode(context, anchor, operation);
    case 'rewrite-text':
      return planRewriteText(context, anchor, operation);
    default: {
      const exhaustive: never = operation;
      throw new Error(`Unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}

type AttributeOperation = Extract<Operation, { tag: 'set-attribute' | 'remove-attribute' | 'set-inline-style' }>;

// The control flow of the attribute family: every rejection is decided here;
// the helpers below compute and do not branch on outcomes. Rejections that need
// no diff come first, so they cost none.
function planAttributeOperation(context: PlanContext, anchor: AnchorRef, operation: AttributeOperation): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!nodeEditable(target.current)) {
    return err('unsupported-operation'); // In a loop, given `set:html`, or code.
  }
  if (!writtenAsTag(target.current)) {
    // Markdown writes no attributes in tags; the ones it has (an image's alt)
    // are its syntax, rewritten as the node's text (electron/documents/markdownEdits.ts).
    return err('unsupported-operation');
  }
  if (tagNameEnd(context.current.bytes, target.current) === target.current.span.start + 1) {
    return err('unsupported-operation'); // `<>` takes no attributes; it must be named first.
  }
  const name = operation.tag === 'set-inline-style' ? 'style' : operation.name;
  const found = soleAttribute(target, name);
  if (!found.ok) {
    return found;
  }
  const attribute = found.value;
  if (attribute !== undefined) {
    if (!nodeEditable(attributeAsNode(attribute, target.current))) {
      return err('unsupported-operation'); // A spread: no name of its own to edit.
    }
  }
  const splices = attributeSplices(context, target, attribute, operation);
  if (!splices.ok) {
    return splices;
  }
  const postKinds = [{ path: target.current.path, kind: target.current.kind }];
  return ok({ splices: splices.value, postKinds, candidate: 'must-parse' });
}

/** `rename-attribute` (step 9): the name alone, in place — its value and its
 * place among the attributes stay. The attribute must be there, once, and the
 * new name must not be: renaming onto a name the tag already has would leave
 * two, and which one the page uses would be a guess. */
function planRenameAttribute(
  context: PlanContext,
  anchor: AnchorRef,
  operation: Extract<Operation, { tag: 'rename-attribute' }>,
): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const target = resolved.value;
  if (!nodeEditable(target.current)) {
    return err('unsupported-operation');
  }
  if (!writtenAsTag(target.current)) {
    return err('unsupported-operation'); // A Markdown attribute has no name to rename.
  }
  const found = soleAttribute(target, operation.from);
  if (!found.ok) {
    return found;
  }
  const attribute = found.value;
  if (attribute === undefined) {
    return err('anchor-moved'); // Nothing named so: the page is not what was authored.
  }
  if (!nodeEditable(attributeAsNode(attribute, target.current))) {
    return err('unsupported-operation');
  }
  const clash = target.current.attributes.some((candidate) => candidate.name === operation.to);
  if (clash) {
    return err('unsupported-operation');
  }
  const nameSpan = attribute.nameSpan;
  assert(nameSpan !== undefined, 'A named attribute has a name span');
  assert(textOf(context.current.bytes, nameSpan) === operation.from, 'The name span holds it');
  const splice = spliceAt(context.current.bytes, nameSpan, operation.to);
  const postKinds = [{ path: target.current.path, kind: target.current.kind }];
  return ok({ splices: [splice], postKinds, candidate: 'must-parse' });
}

/** `rename-tag` (step 9): the name in the opening tag and, for a paired tag,
 * in its closing tag — nothing between them. The closing tag is found in the
 * current node, so content someone else changed inside it is kept. A tag
 * without a name (`<>`), or one neither self-closing nor closed (a void
 * `<img>`), has no rename that keeps the page's structure: refused. The kind
 * may change with the name (`div` → `Card`), so none is promised. */
function planRenameTag(context: PlanContext, anchor: AnchorRef, operation: Extract<Operation, { tag: 'rename-tag' }>): Result<Plan, RejectionReason> {
  const resolved = resolveTarget(context, anchor);
  if (!resolved.ok) {
    return resolved;
  }
  const node = resolved.value.current;
  const bytes = context.current.bytes;
  if (!nodeEditable(node)) {
    return err('unsupported-operation');
  }
  if (!writtenAsTag(node)) {
    return err('unsupported-operation'); // A Markdown block's kind is its text: a rewrite.
  }
  const name = toByteSpan(node.span.start + 1, tagNameEnd(bytes, node));
  if (name.start === name.end) {
    return err('unsupported-operation'); // `<>`: a fragment is named in code.
  }
  if (textOf(bytes, name) !== operation.from) {
    return err('anchor-moved'); // Not the tag the client saw.
  }
  const splices = [spliceAt(bytes, name, operation.to)];
  const open = openTagEnd(bytes, node);
  if (!open.selfClosing) {
    const closing = closingName(bytes, node, open.end, operation.from);
    if (closing === undefined) {
      return err('unsupported-operation');
    }
    splices.push(spliceAt(bytes, closing, operation.to));
  }
  assert(splices.length <= 2, 'A tag has at most an opening and a closing name');
  return ok({ splices, postKinds: [], candidate: 'must-parse' });
}

// The name in the `</name>` that ends a paired tag's node, when it is `name`.
function closingName(bytes: ByteString, node: ProjectedNode, openEnd: number, name: string): ByteSpan | undefined {
  const start = closeTagStart(bytes, node, openEnd);
  if (start === undefined) {
    return undefined;
  }
  const span = toByteSpan(start + 2, start + 2 + encodeUtf8(name).length);
  if (span.end > node.span.end) {
    return undefined;
  }
  if (textOf(bytes, span) !== name) {
    return undefined;
  }
  const after = bytes[span.end];
  if (after === undefined) {
    return undefined;
  }
  return after === 0x3e || isWhitespace(after) ? span : undefined; // `>` or a space before it
}

function attributeSplices(
  context: PlanContext,
  target: Target,
  attribute: ProjectedAttribute | undefined,
  operation: AttributeOperation,
): Result<readonly Splice[], RejectionReason> {
  switch (operation.tag) {
    case 'set-attribute':
      return ok([setAttributeSplice(context.current.bytes, target.current, attribute, operation)]);
    case 'remove-attribute':
      if (attribute === undefined) {
        return err('anchor-moved'); // Nothing named so: the page is not what was authored.
      }
      return ok([removalSplice(context.current.bytes, target.current, attribute)]);
    case 'set-inline-style':
      return inlineStyleSplices(context.current.bytes, target.current, attribute, operation);
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/** The one attribute named `name`, or undefined when there is none. Duplicate
 * names are ambiguous — which one the page uses is a guess. The attribute is
 * read in the current bytes, where the resolved region moved whole, so it is
 * the authored attribute shifted (asserted). */
function soleAttribute(target: Target, name: string): Result<ProjectedAttribute | undefined, RejectionReason> {
  const node = target.current;
  assert(node.attributes.length <= LIMITS.attrsPerNodeMax, 'Attributes are inside their bound');
  const found = node.attributes.filter((attribute) => attribute.name === name);
  if (found.length > 1) {
    return err('anchor-ambiguous');
  }
  const [attribute] = found;
  const authored = target.authored.attributes.filter((candidate) => candidate.name === name);
  assert(authored.length === found.length, 'A region moved whole keeps its attributes');
  const [before] = authored;
  if (attribute !== undefined) {
    assert(before !== undefined, 'The authored node had the attribute');
    assert(attribute.span.start === before.span.start + target.shift, 'The attribute moved whole');
  }
  return ok(attribute);
}

// An attribute carries its node's capability, narrowed: a spread is opaque.
function attributeAsNode(attribute: ProjectedAttribute, node: ProjectedNode): ProjectedNode {
  return { ...node, capability: attribute.capability };
}

/** `set-attribute`: the value alone when its delimiters can stay, the whole
 * attribute when its type or quoting changes, a new attribute when absent. */
function setAttributeSplice(
  bytes: ByteString,
  node: ProjectedNode,
  attribute: ProjectedAttribute | undefined,
  operation: Extract<Operation, { tag: 'set-attribute' }>,
): Splice {
  if (attribute === undefined) {
    return insertionSplice(bytes, node, attributeText(operation.name, operation.value));
  }
  const value = operation.value;
  const valueSpan = attribute.valueSpan;
  if (valueSpan !== undefined) {
    if (attribute.type === 'string') {
      if (value.type === 'string') {
        const quote = bytes[valueSpan.start - 1];
        assert(quote === 0x22 || quote === 0x27, 'A string value sits in quotes');
        assert(bytes[valueSpan.end] === quote, 'A string value closes with its opening quote');
        if (!value.value.includes(String.fromCharCode(quote))) {
          return spliceAt(bytes, valueSpan, value.value); // The step-2 value splice.
        }
      }
    }
    if (attribute.type === 'expr') {
      if (value.type === 'expr') {
        return spliceAt(bytes, valueSpan, value.value);
      }
    }
  }
  // The name keeps its bytes; the rest is written anew.
  assert(attribute.nameSpan !== undefined, 'A named attribute has a name span');
  const name = textOf(bytes, attribute.nameSpan);
  return spliceAt(bytes, attribute.span, attributeText(name, value));
}

/** How an attribute is written: the legacy serializer's form (astroParser.ts,
 * serializeAttrs), except that a value holding a double quote but no single
 * one is single-quoted — the parser reads it back exactly, where `&quot;`
 * reads back as those six characters. */
export function attributeText(name: string, value: AttributeValue): string {
  switch (value.type) {
    case 'bare':
      return name;
    case 'expr':
      return `${name}={${value.value}}`;
    case 'string':
      return `${name}=${quoted(value.value)}`;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function quoted(value: string): string {
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  return `"${value.replace(/"/g, '&quot;')}"`;
}

/** A new attribute after the last one, or after the tag name: on its own line
 * when the tag writes its attributes a line each, else after one space. */
function insertionSplice(bytes: ByteString, node: ProjectedNode, text: string): Splice {
  const nameEnd = tagNameEnd(bytes, node);
  const last = node.attributes.reduce<ProjectedAttribute | undefined>(
    (latest, attribute) => (latest === undefined || attribute.span.end > latest.span.end ? attribute : latest),
    undefined,
  );
  if (last === undefined) {
    return spliceAt(bytes, toByteSpan(nameEnd, nameEnd), ` ${text}`);
  }
  const lined = containsNewline(bytes, toByteSpan(nameEnd, last.span.start));
  const separator = lined ? `\n${lineIndent(bytes, last.span.start)}` : ' ';
  return spliceAt(bytes, toByteSpan(last.span.end, last.span.end), `${separator}${text}`);
}

/** The attribute and the whitespace before it, back to the previous attribute
 * or the tag name, so no gap is left behind. */
function removalSplice(bytes: ByteString, node: ProjectedNode, attribute: ProjectedAttribute): Splice {
  const floor = tagNameEnd(bytes, node);
  const start = whitespaceBefore(bytes, attribute.span.start, floor);
  assert(start < attribute.span.start, 'An attribute is separated from what precedes it');
  return spliceAt(bytes, toByteSpan(start, attribute.span.end), '');
}

// One declaration inside `style="…"`; without a style attribute, setting a
// property adds one. The value keeps its quotes, so a quote in the new value
// is refused — the renderer then sets the whole attribute instead.
function inlineStyleSplices(
  bytes: ByteString,
  node: ProjectedNode,
  attribute: ProjectedAttribute | undefined,
  operation: Extract<Operation, { tag: 'set-inline-style' }>,
): Result<readonly Splice[], RejectionReason> {
  const declaration = operation.declaration;
  if (attribute === undefined) {
    if (declaration.tag === 'set') {
      const text = `${operation.property}: ${declaration.value}`;
      return ok([insertionSplice(bytes, node, attributeText('style', { type: 'string', value: text }))]);
    }
    return ok([]); // Removing from no style at all: nothing to do.
  }
  const valueSpan = attribute.valueSpan;
  if (attribute.type !== 'string') {
    return err('unsupported-operation'); // `style={…}` is code.
  }
  assert(valueSpan !== undefined, 'A string attribute has a value span');
  const quote = bytes[valueSpan.start - 1];
  if (declaration.tag === 'set') {
    if (declaration.value.includes(String.fromCharCode(quote ?? 0x22))) {
      return err('unsupported-operation');
    }
  }
  const text = textOf(bytes, valueSpan);
  const edited = editInlineStyle(text, operation.property, declaration);
  switch (edited.tag) {
    case 'edited': {
      const offsets = byteOffsetsIn(
        text,
        edited.edits.flatMap((edit) => [edit.start, edit.end]),
      );
      return ok(
        edited.edits.map((edit, index) => {
          const start = offsets[index * 2];
          const end = offsets[index * 2 + 1];
          assert(start !== undefined, 'Every edit start was converted');
          assert(end !== undefined, 'Every edit end was converted');
          const range = toByteSpan(valueSpan.start + start, valueSpan.start + end);
          return spliceAt(bytes, range, edit.text);
        }),
      );
    }
    case 'ambiguous':
      return err('anchor-ambiguous');
    case 'unreadable':
      return err('unsupported-operation');
    default: {
      const exhaustive: never = edited;
      return exhaustive;
    }
  }
}

export function spliceAt(bytes: ByteString, range: ByteSpan, replacement: string): Splice {
  assert(range.end <= bytes.length, 'A planned range lies inside the file');
  return {
    range,
    expectedBytes: toByteString(bytes.subarray(range.start, range.end)),
    replacementBytes: encodeUtf8(replacement),
  };
}
