// The renderer's intent front end, main's half (plan §2 layer 3; step 6): an
// edit request, stated in the renderer's terms, becomes an intent against the
// snapshot it was authored against. Here the renderer's node references are
// checked against main's own projection of the same bytes, UTF-16 ranges
// become byte spans, new nodes and frontmatter are printed by the legacy
// printer, a node's new text is turned into hunks placed on its own bytes
// (step 9, `replace-node`), a visual fallback maps model-diff hunks onto the
// authored file (`replace-page`), and a loop rename's sites are found. Everything else is the
// planner's. A Markdown or MDX page's own nodes are drafted by
// markdownEdits.ts (step 10); its markup, and the operations the planner
// places alike in both — removals, moves, copies — are drafted here.
//
// On the .astro printer boundary (eslint.config.mjs) because it prints new
// nodes, frontmatter, and the before/after witnesses used to place fallback
// hunks on existing bytes. It
// outlived the compat adapter at step 9 (tracker, Step 9): the renderer names
// nodes by the path, kind and UTF-16 range of the parse it shows, and only main
// holds the bytes those become, so the translation stays here.
import { assert } from '../../shared/core/assert';
import type { Edit, NodeRef } from '../../shared/engine/editRequest';
import type { BuiltEdit, EditBase, IntentDraft } from './documentActors';
import { isAttributeHost, TAG_NAME_RE } from '../../shared/engine/intent';
import type { Operation, RejectionReason, SourceEdit } from '../../shared/engine/intent';
import { renameSites } from '../../shared/engine/loopScope';
import { closeTagStart, indentedFragment, lineIndent, nodeAtPath, openTagEnd, tagNameEnd, textOf } from '../../shared/engine/planSupport';
import { insertedIndent, labelledSpan, wrapperTakesLines } from '../../shared/engine/planTree';
import { wrappedTextHunk } from '../../shared/engine/planText';
import { diffCodePatch } from '../../shared/engine/codePatch';
import { encodeText } from '../../shared/page/htmlText';
import { parsePageResult, type PageNode } from '../../shared/page/pageNode';
import { toAnchorRef, type AnchorRef } from '../../shared/page/ref';
import { err, ok, type Result } from '../../shared/core/result';
import type { Snapshot } from '../../shared/page/snapshot';
import { byteStringsEqual, decodeUtf8, encodeUtf8, spansAscending, toByteSpan, toByteString } from '../../shared/core/span';
import { parsePage, serializeNodes, serializePage } from '../parse/astroParser';
import { indentUnitOf } from '../../shared/core/indent';
import { frontmatterSlot, pageFormat, placedHunks, resolveRef, shiftedHunks, type Authored } from './editAnchors';
import { markdownEditDraft, markdownPageNodes } from './markdownEdits';

/** The intent an edit is. Every edit is built against the snapshot it names,
 * except a frontmatter request after the app's own commits: it states the
 * whole block the model now describes, and that model already holds what
 * those commits did, so it is compared with the block on disk now — against
 * the authored block it would do their part a second time. */
export function buildEdit(edit: Edit, base: EditBase): Result<BuiltEdit, RejectionReason> {
  if (edit.tag === 'set-frontmatter') {
    if (base.history === 'own-commits') {
      const built = buildEditIntent(edit, base.current);
      return built.ok ? ok({ draft: built.value, basis: 'current' }) : built;
    }
  }
  const built = buildEditIntent(edit, base.authored);
  return built.ok ? ok({ draft: built.value, basis: 'authored' }) : built;
}

/** The intent an edit is, against the snapshot it names. */
export function buildEditIntent(edit: Edit, snapshot: Snapshot): Result<IntentDraft, RejectionReason> {
  const decoded = decodeUtf8(snapshot.bytes);
  assert(decoded.ok, 'A page the renderer read decodes');
  if (edit.tag === 'revert') {
    return revertDraft(snapshot, edit.hunks);
  }
  if (edit.tag === 'code-patch') {
    return codePatchDraft(snapshot, edit.hunks); // Text, not nodes: a broken file takes it too.
  }
  const projection = snapshot.projection;
  if (projection.tag === 'parse-error') {
    return err('source-invalid');
  }
  const format = pageFormat(snapshot.path);
  const authored: Authored = { snapshot, text: decoded.value, projection, format };
  if (edit.tag === 'replace-page') {
    return format === 'astro' ? replacePageDraft(authored, edit.model) : err('unsupported-operation');
  }
  if (format !== 'astro') {
    // Markdown's own drafts first (markdownEdits.ts); what it leaves — markup
    // inside MDX, and the operations the planner places alike — is stated
    // below as it is for an .astro page.
    const drafted = markdownEditDraft(edit, authored);
    if (drafted !== undefined) {
      return drafted;
    }
  }
  return nodeEditDraft(edit, authored);
}

// A gesture's edit of the page's nodes, stated against their parse.
function nodeEditDraft(edit: Exclude<Edit, { readonly tag: 'revert' | 'code-patch' }>, authored: Authored): Result<IntentDraft, RejectionReason> {
  switch (edit.tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style': {
      // A node with no tag has nowhere to write this: a refusal, not a thrown
      // intent. A throw reads as a failed transport, so the saver would keep
      // the gesture at the head of the queue and every later edit of the page
      // would fail behind it.
      const { target, ...rest } = edit;
      return withAnchor(authored, target, (anchor) => (isAttributeHost(anchor.expectedKind) ? ok({ anchor, operation: rest }) : err('unsupported-operation')));
    }
    case 'remove-node': {
      const { target, ...rest } = edit;
      return withAnchor(authored, target, (anchor) => ok({ anchor, operation: rest }));
    }
    case 'insert-node':
      return withAnchor(authored, edit.target, (anchor) => insertDraft(authored, anchor, edit));
    case 'move-node':
      return withAnchor(authored, edit.target, (anchor) =>
        withAnchor(authored, edit.destination, (destination) => ok({ anchor, operation: { tag: 'move-node', destination, placement: edit.placement } })),
      );
    case 'rename-binding':
      return withAnchor(authored, edit.target, (anchor) => renameDraft(authored, anchor, edit));
    case 'rename-tag':
      return withAnchor(authored, edit.target, (anchor) => tagRenameDraft(authored, anchor, edit.to));
    case 'rename-attribute':
      return withAnchor(authored, edit.target, (anchor) =>
        isAttributeHost(anchor.expectedKind)
          ? ok({ anchor, operation: { tag: 'rename-attribute', from: edit.from, to: edit.to } })
          : err('unsupported-operation'),
      );
    case 'replace-node':
      return withAnchor(authored, edit.target, (anchor) => replaceDraft(authored, anchor, edit.node));
    case 'wrap-nodes':
      return withAnchor(authored, edit.target, (anchor) => withAnchor(authored, edit.last, (last) => wrapDraft(authored, anchor, last, edit.name)));
    case 'wrap-text':
      return withAnchor(authored, edit.target, (anchor) => textWrapDraft(authored, anchor, edit.name));
    case 'unwrap-node':
      return withAnchor(authored, edit.target, (anchor) => unwrapDraft(authored, anchor));
    case 'append-body':
      return ok(appendDraft(authored, edit.nodes));
    case 'set-frontmatter':
      return frontmatterDraft(authored, edit.model);
    case 'replace-page':
      return replacePageDraft(authored, edit.model);
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

// The last-resort visual edit is still a bounded hunk edit, not a regenerated
// file. The old printed model identifies semantic changes; placedHunks maps
// only those ranges onto the authored formatting and refuses ambiguous ones.
function replacePageDraft(authored: Authored, next: Extract<Edit, { tag: 'replace-page' }>['model']): Result<IntentDraft, RejectionReason> {
  const parsed = parsePageResult(parsePage(authored.text, { locs: true }));
  if (!parsed.editable) {
    return err('source-invalid');
  }
  const before = serializePage(parsed.model);
  const after = serializePage(next);
  const hunks = placedHunks(before, after, authored.text);
  if (!hunks.ok) {
    return hunks;
  }
  const anchor = toAnchorRef({
    span: toByteSpan(0, authored.snapshot.bytes.length),
    path: [],
    expectedKind: 'document',
  });
  return ok({ anchor, operation: { tag: 'rewrite-text', hunks: hunks.value } });
}

// The body's first nodes, printed as a new node is; the planner refuses them
// once the body has any node (they must stand beside it then).
function appendDraft(authored: Authored, nodes: readonly PageNode[]): IntentDraft {
  const source = serializeNodes(nodes, indentUnitOf(authored.text)).replace(/\r?\n$/, '');
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const anchor = toAnchorRef({
    span: toByteSpan(0, authored.snapshot.bytes.length),
    path: [],
    expectedKind: 'document',
  });
  const lines = source.split(/\r?\n/).join(eol);
  return { anchor, operation: { tag: 'append-body', source: lines } };
}

// The renderer's node reference, checked against the projection of the same
// bytes (editAnchors.ts): a mismatch means the renderer's parse is not of
// these bytes.
function withAnchor(authored: Authored, ref: NodeRef, next: (anchor: AnchorRef) => Result<IntentDraft, RejectionReason>): Result<IntentDraft, RejectionReason> {
  const resolved = resolveRef(authored, ref);
  return resolved.ok ? next(resolved.value.anchor) : resolved;
}

// New nodes print with the legacy printer, their continuation lines indented
// to where the planner lands them; a copy is the source node's own bytes.
function insertDraft(authored: Authored, anchor: AnchorRef, edit: Extract<Edit, { tag: 'insert-node' }>): Result<IntentDraft, RejectionReason> {
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const unit = indentUnitOf(authored.text);
  const content = edit.content;
  if (content.tag === 'copy') {
    return withAnchor(authored, content.source, (source) => {
      // A copy takes the node's label with it (planTree.ts, labelledSpan), so the
      // duplicate reads in the Navigator as its original does.
      const copied = nodeAtPath(authored.projection, source.path);
      assert(copied !== undefined, 'A checked copy source names a projected node');
      const span = labelledSpan(authored.snapshot.bytes, authored.projection, copied);
      const bytes = authored.snapshot.bytes.subarray(span.start, span.end);
      const text = Buffer.from(bytes).toString('utf8');
      return ok({
        anchor,
        operation: { tag: 'insert-node', placement: edit.placement, source: text },
      });
    });
  }
  const landing = nodeAtPath(authored.projection, anchor.path);
  assert(landing !== undefined, 'A checked anchor names a projected node');
  const indent = insertedIndent(authored.snapshot.bytes, authored.projection, landing, edit.placement);
  const printed = serializeNodes(content.nodes, unit).replace(/\r?\n$/, '');
  const text = indentedFragment(printed, indent, eol);
  const operation: Operation = { tag: 'insert-node', placement: edit.placement, source: text };
  return ok({ anchor, operation });
}

function renameDraft(authored: Authored, anchor: AnchorRef, edit: Extract<Edit, { tag: 'rename-binding' }>): Result<IntentDraft, RejectionReason> {
  const loop = nodeAtPath(authored.projection, anchor.path);
  assert(loop !== undefined, 'A checked anchor names a projected node');
  if (loop.kind !== 'map') {
    return err('unsupported-operation');
  }
  const sites = renameSites(authored.projection, authored.snapshot.bytes, loop, edit.from);
  if (sites === undefined) {
    return err('unsupported-operation'); // A head or a test the rename cannot read.
  }
  return ok({ anchor, operation: { tag: 'rename-binding', from: edit.from, to: edit.to, sites } });
}

// A tag's new name: the old one is read off the authored bytes, where the
// planner will find it again (its witness). A `<style>` or `<script>` is raw
// text by its name, and `<>` has none: neither is renamed visually.
function tagRenameDraft(authored: Authored, anchor: AnchorRef, to: string): Result<IntentDraft, RejectionReason> {
  const node = nodeAtPath(authored.projection, anchor.path);
  assert(node !== undefined, 'A checked anchor names a projected node');
  if (node.kind !== 'element' && node.kind !== 'component') {
    return err('unsupported-operation');
  }
  const bytes = authored.snapshot.bytes;
  const from = textOf(bytes, toByteSpan(node.span.start + 1, tagNameEnd(bytes, node)));
  if (!TAG_NAME_RE.test(from)) {
    return err('unsupported-operation');
  }
  if (from === to) {
    return err('unsupported-operation'); // Nothing to write; the gesture had no change.
  }
  return ok({ anchor, operation: { tag: 'rename-tag', from, to } });
}

// A node as it should now read (step 9). The printer renders the node as it is
// and as it should be; the difference is the edit. The node's own bytes may be
// written differently from the printer's rendering — spacing, line breaks,
// entities the parser kept — so each changed range of the rendering is placed
// on the bytes through a diff between the two (the span mapper, which refuses
// rather than guesses). A range the formatting itself changed has no place:
// the edit is refused, and the node is never reprinted.
function replaceDraft(authored: Authored, anchor: AnchorRef, next: PageNode): Result<IntentDraft, RejectionReason> {
  const projected = nodeAtPath(authored.projection, anchor.path);
  assert(projected !== undefined, 'A checked anchor names a projected node');
  const previous = pageNodeAt(authored, anchor.path);
  if (previous === undefined) {
    return err('anchor-moved');
  }
  if (previous.kind === 'raw' && next.kind === 'raw') {
    const contents = rawContentsDraft(authored, anchor, { previous, next });
    if (contents !== undefined) {
      return contents;
    }
  }
  if (previous.kind === 'text' && next.kind === 'text') {
    const words = textDraft(authored, anchor, { previous, next });
    if (words !== undefined) {
      return words;
    }
  }
  const bytes = authored.snapshot.bytes;
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const indent = lineIndent(bytes, projected.span.start);
  const print = (node: PageNode): string =>
    serializeNodes([node])
      .replace(/\r?\n$/, '')
      .split(/\r?\n/)
      .join(`${eol}${indent}`);
  const own = textOf(bytes, projected.span);
  const hunks = placedHunks(print(previous), print(next), own);
  if (!hunks.ok) {
    return hunks;
  }
  const moved = shiftedHunks(hunks.value, projected.span.start);
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks: moved } });
}

/**
 * A `<style>` or `<script>` whose contents alone changed: the contents are
 * kept byte for byte, so the change is the diff of the old contents and the
 * new, written where the contents sit between the tags. Printing the element
 * instead re-indents its contents by the element's own indentation, and a
 * change the diff could not place on the file through that re-indented text
 * was refused as an editor error (typing a comment into a page's `<style>`,
 * a style panel edit): or, placed, wrote new lines at the doubled indent.
 * Undefined when the tag itself changed or the contents on disk are not the
 * ones the node holds; the printed path decides those.
 */
function rawContentsDraft(
  authored: Authored,
  anchor: AnchorRef,
  nodes: { readonly previous: RawPageNode; readonly next: RawPageNode },
): Result<IntentDraft, RejectionReason> | undefined {
  const { previous, next } = nodes;
  if (previous.name !== next.name || JSON.stringify([previous.props, previous.attrOrder]) !== JSON.stringify([next.props, next.attrOrder])) {
    return undefined;
  }
  const projected = nodeAtPath(authored.projection, anchor.path);
  assert(projected?.kind === 'raw', 'A raw page node is a projected raw node');
  const bytes = authored.snapshot.bytes;
  const open = openTagEnd(bytes, projected);
  const close = open.selfClosing ? undefined : closeTagStart(bytes, projected, open.end);
  if (close === undefined || textOf(bytes, toByteSpan(open.end, close)) !== previous.inner) {
    return undefined;
  }
  const change = diffCodePatch(previous.inner, next.inner);
  if (!change.ok) {
    return change;
  }
  if (change.value.length === 0) {
    return err('unsupported-operation'); // Nothing to write; the gesture had no change.
  }
  const hunks = shiftedHunks(
    change.value.map((hunk) => ({ span: hunk.span, text: hunk.text })),
    open.end,
  );
  assert(
    hunks.every((hunk) => hunk.span.start >= open.end && hunk.span.end <= close),
    'A contents edit stays between the tags',
  );
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks } });
}

type RawPageNode = Extract<PageNode, { readonly kind: 'raw' }>;
// A text run's node: the value kinds share one shape, `text` among them.
type TextPageNode = Extract<PageNode, { readonly kind: 'text' | 'expr' | 'raw-line' }>;

/**
 * A run of text whose words changed: written as the diff of its old text and
 * its new, where the run sits. The printer writes a run without the space at
 * either end (on a line of its own that space is the layout's), so a change to
 * that space alone printed the same before and after and was refused as an
 * editor error: deleting the space in `Send your first pigeon <span>`.
 * Undefined unless the file holds the run exactly as its text spells it; the
 * printed path decides the rest (text wrapped across lines, say).
 */
function textDraft(
  authored: Authored,
  anchor: AnchorRef,
  nodes: { readonly previous: TextPageNode; readonly next: TextPageNode },
): Result<IntentDraft, RejectionReason> | undefined {
  const { previous, next } = nodes;
  const projected = nodeAtPath(authored.projection, anchor.path);
  assert(projected?.kind === 'text', 'A text page node is a projected text node');
  const own = textOf(authored.snapshot.bytes, projected.span);
  const before = encodeText(previous.value);
  if (own !== before || own.includes('\n')) {
    return undefined;
  }
  const after = encodeText(next.value);
  const change = diffCodePatch(before, after);
  if (!change.ok) {
    return change;
  }
  if (change.value.length === 0) {
    return err('unsupported-operation'); // Nothing to write; the gesture had no change.
  }
  const hunks = shiftedHunks(
    change.value.map((hunk) => ({ span: hunk.span, text: hunk.text })),
    projected.span.start,
  );
  assert(
    hunks.every((hunk) => hunk.span.start >= projected.span.start && hunk.span.end <= projected.span.end),
    'A text edit stays inside its run',
  );
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks } });
}

// A run of siblings inside a new tag: the opening tag on its own line before
// the first, the closing tag on its own line after the last, at the first
// one's indentation, or tight around it where a line break would show (the layout
// rule, planTree.ts). The run's own bytes are not re-indented.
function wrapDraft(authored: Authored, anchor: AnchorRef, last: AnchorRef, name: string): Result<IntentDraft, RejectionReason> {
  const first = nodeAtPath(authored.projection, anchor.path);
  assert(first !== undefined, 'A checked anchor names a projected node');
  const eol = authored.text.includes('\r\n') ? '\r\n' : '\n';
  const indent = lineIndent(authored.snapshot.bytes, anchor.span.start);
  const lines = wrapperTakesLines(authored.snapshot.bytes, authored.projection, first, name);
  const operation: Operation = {
    tag: 'wrap-nodes',
    last,
    open: lines ? `<${name}>${eol}${indent}` : `<${name}>`,
    close: lines ? `${eol}${indent}</${name}>` : `</${name}>`,
  };
  return ok({ anchor, operation });
}

// A text run inside a new tag, written as a rewrite of the run: `wrap-nodes`
// puts its tags on lines of their own, which here would add spaces to the words.
function textWrapDraft(authored: Authored, anchor: AnchorRef, name: string): Result<IntentDraft, RejectionReason> {
  const node = nodeAtPath(authored.projection, anchor.path);
  assert(node !== undefined, 'A checked anchor names a projected node');
  if (node.kind !== 'text') {
    return err('unsupported-operation');
  }
  const hunk = wrappedTextHunk(textOf(authored.snapshot.bytes, node.span), node.span, name);
  if (hunk === undefined) {
    return err('unsupported-operation'); // A blank run has no words to wrap.
  }
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks: [hunk] } });
}

// A paired tag taken away, its children kept as they are written: the opening
// tag, with the rest of its line when that is only whitespace, and the closing
// tag, with the line break and indentation before it when it stands on its own
// line. A rewrite of the node, so it applies only while the node is unchanged.
function unwrapDraft(authored: Authored, anchor: AnchorRef): Result<IntentDraft, RejectionReason> {
  const node = nodeAtPath(authored.projection, anchor.path);
  assert(node !== undefined, 'A checked anchor names a projected node');
  if (node.kind !== 'element' && node.kind !== 'component') {
    return err('unsupported-operation');
  }
  const bytes = authored.snapshot.bytes;
  const open = openTagEnd(bytes, node);
  const close = closeTagStart(bytes, node, open.end);
  if (open.selfClosing || close === undefined) {
    return err('unsupported-operation'); // Nothing inside to keep.
  }
  const openEnd = lineEndAfter(bytes, open.end, close) ?? open.end;
  const closeStart = lineStartBefore(bytes, close, openEnd) ?? close;
  const hunks: SourceEdit[] = [
    { span: toByteSpan(node.span.start, openEnd), text: '' },
    { span: toByteSpan(closeStart, node.span.end), text: '' },
  ];
  return ok({ anchor, operation: { tag: 'rewrite-node', hunks } });
}

// One past the line break ending the line at `from`, when only spaces and tabs
// stand between them; undefined when anything else does.
function lineEndAfter(bytes: Uint8Array, from: number, ceiling: number): number | undefined {
  for (let at = from; at < ceiling; at++) {
    const byte = bytes[at];
    if (byte === 0x0a) {
      return at + 1;
    }
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) {
      return undefined;
    }
  }
  return undefined;
}

// The line break (its `\r\n` whole) that starts the line holding `to`, when
// only spaces and tabs stand between them; undefined when anything else does.
function lineStartBefore(bytes: Uint8Array, to: number, floor: number): number | undefined {
  for (let at = to - 1; at >= floor; at--) {
    const byte = bytes[at];
    if (byte === 0x0a) {
      return at > floor && bytes[at - 1] === 0x0d ? at - 1 : at;
    }
    if (byte !== 0x20 && byte !== 0x09) {
      return undefined;
    }
  }
  return undefined;
}

// The parsed node at a projection path: projections index the same tree. A
// Markdown page's markup is found in the Markdown parse, which holds it.
function pageNodeAt(authored: Authored, path: readonly number[]): PageNode | undefined {
  const roots = authored.format === 'astro' ? astroPageNodes(authored.text) : markdownPageNodes(authored);
  if (roots === undefined) {
    return undefined;
  }
  let list: readonly PageNode[] = roots;
  let node: PageNode | undefined;
  for (const step of path) {
    node = list[step];
    if (node === undefined) {
      return undefined;
    }
    list = 'children' in node && Array.isArray(node.children) ? node.children : [];
  }
  return node;
}

// The frontmatter the model describes, printed by the legacy printer, against
// the block on disk: only the differing middle becomes the slot, so a new
// import touches its line and nothing else.
function astroPageNodes(text: string): readonly PageNode[] | undefined {
  const parsed = parsePageResult(parsePage(text, { locs: true }));
  return parsed.editable ? parsed.model.nodes : undefined;
}

function frontmatterDraft(authored: Authored, model: Extract<Edit, { tag: 'set-frontmatter' }>['model']): Result<IntentDraft, RejectionReason> {
  const block = authored.projection.frontmatter;
  const page = serializePage({ ...model, nodes: [] });
  if (block === undefined) {
    // A page without a block gains one at its top (step 10).
    const printed = printedBlock(page, '\n');
    if (printed === undefined) {
      return err('unsupported-operation'); // The model describes no block either.
    }
    const anchor = toAnchorRef({
      span: toByteSpan(0, authored.snapshot.bytes.length),
      path: [],
      expectedKind: 'document',
    });
    return ok({ anchor, operation: { tag: 'insert-frontmatter', source: printed } });
  }
  const before = Buffer.from(authored.snapshot.bytes.subarray(block.start, block.end)).toString('utf8');
  const printed = printedBlock(page, before);
  if (printed === undefined) {
    return err('unsupported-operation');
  }
  const { slot, text } = frontmatterSlot(block, before, printed);
  const anchor = toAnchorRef({ span: block, path: [], expectedKind: 'frontmatter' });
  return ok({ anchor, operation: { tag: 'edit-frontmatter-slot', slot, text } });
}

// The fenced block of a printed page without nodes, ending as the block on
// disk ends (with or without the line break after the closing fence).
function printedBlock(page: string, before: string): string | undefined {
  const eol = page.includes('\r\n') ? '\r\n' : '\n';
  const lines = page.split(eol);
  const close = lines.indexOf('---', 1);
  if (lines[0] !== '---' || close === -1) {
    return undefined;
  }
  const block = lines.slice(0, close + 1).join(eol);
  return before.endsWith('\n') ? `${block}${eol}` : block;
}

function revertDraft(snapshot: Snapshot, hunks: Extract<Edit, { tag: 'revert' }>['hunks']): Result<IntentDraft, RejectionReason> {
  const inside = hunks.every((hunk) => hunk.span.end <= snapshot.bytes.length);
  if (!inside || !spansAscending(hunks.map((hunk) => hunk.span)) || hunks.length === 0) {
    return err('anchor-moved'); // Not hunks of these bytes.
  }
  const anchor = toAnchorRef({
    span: toByteSpan(0, snapshot.bytes.length),
    path: [],
    expectedKind: 'document',
  });
  return ok({ anchor, operation: { tag: 'revert-splices', hunks } });
}

// The code editor's patch (step 8), checked against the bytes it names: every
// hunk inside them, on code-point boundaries, holding the text it says it
// replaces. A hunk that does not is not a diff of these bytes — the editor's
// text descends from some other version — and it cannot be merged.
function codePatchDraft(snapshot: Snapshot, hunks: Extract<Edit, { tag: 'code-patch' }>['hunks']): Result<IntentDraft, RejectionReason> {
  assert(hunks.length > 0, 'The wire parser requires a hunk');
  assert(spansAscending(hunks.map((hunk) => hunk.span)), 'The wire parser orders the hunks');
  const bytes = snapshot.bytes;
  for (const hunk of hunks) {
    if (bytes.length < hunk.span.end) {
      return err('merge-conflict');
    }
    if (continuesCodePoint(bytes, hunk.span.start) || continuesCodePoint(bytes, hunk.span.end)) {
      return err('merge-conflict');
    }
    const held = bytes.subarray(hunk.span.start, hunk.span.end);
    if (!byteStringsEqual(toByteString(held), encodeUtf8(hunk.expected))) {
      return err('merge-conflict');
    }
  }
  const anchor = toAnchorRef({
    span: toByteSpan(0, bytes.length),
    path: [],
    expectedKind: 'document',
  });
  const edits = hunks.map((hunk) => ({ span: hunk.span, text: hunk.text }));
  return ok({ anchor, operation: { tag: 'apply-code-patch', hunks: edits } });
}

// A UTF-8 continuation byte at `offset`: a span edge there splits a character.
function continuesCodePoint(bytes: Uint8Array, offset: number): boolean {
  const byte = bytes[offset];
  if (byte === undefined) {
    return false; // The end of the file is a boundary.
  }
  return byte >= 0x80 && byte < 0xc0;
}
