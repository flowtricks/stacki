// Edit requests (plan §2 layer 3, the compat adapter; §11 step 6): a gesture
// as the renderer can state it — in terms of the page it shows. The renderer
// holds a parse of the bytes it last read or was sent back, with UTF-16 source
// ranges on every node, and the checksum of those bytes; it does not hold the
// bytes, the byte offsets, or the printer that writes a new node. Main does:
// it turns a request into an Intent against the snapshot of the named
// checksum (electron/documents/editRequests.ts), and the actor plans it like any other.
//
// A node is referred to by the facts of that parse — its path, its kind and
// its source range — and main checks them against its own projection of the
// same bytes before it trusts them. The request never carries an identity of
// its own (plan §4): a session id means nothing to main.
//
// The adapter half in main dies at step 9, when the renderer holds
// projections and authors intents directly.
import { assert } from '../core/assert';
import type { Digest } from '../core/brand';
import { digest, pathText } from '../core/boundary';
import type { CodeHunk } from './codePatch';
import type { AttributeValue, Placement, SourceEdit, StyleDeclaration } from './intent';
import { PLACEMENTS, TAG_NAME_RE } from './intent';
import { LIMITS } from '../core/limits';
import { parsePageModel, parsePageNode, type PageModel, type PageNode } from '../page/pageNode';
import { toArray, toRecord } from '../core/record';
import { NODE_KINDS, STRUCTURAL_PATH_STEPS_MAX, type NodeKind } from '../page/ref';
import { parseByteSpan, parseUtf16Span, spansAscending, type Utf16Span } from '../core/span';

/** A node of the parse the request was authored against. */
export interface NodeRef {
  readonly path: readonly number[];
  readonly kind: NodeKind;
  readonly span: Utf16Span;
}

/** What goes in: new nodes main prints, or a copy of a node's own bytes (a
 * duplicate is its source, never a reprint). */
export type InsertContent = { readonly tag: 'nodes'; readonly nodes: readonly PageNode[] } | { readonly tag: 'copy'; readonly source: NodeRef };

export type Edit =
  | {
      readonly tag: 'set-attribute';
      readonly target: NodeRef;
      readonly name: string;
      readonly value: AttributeValue;
    }
  | { readonly tag: 'remove-attribute'; readonly target: NodeRef; readonly name: string }
  | {
      readonly tag: 'set-inline-style';
      readonly target: NodeRef;
      readonly property: string;
      readonly declaration: StyleDeclaration;
    }
  | {
      readonly tag: 'insert-node';
      readonly target: NodeRef;
      readonly placement: Placement;
      readonly content: InsertContent;
    }
  | { readonly tag: 'remove-node'; readonly target: NodeRef }
  | {
      readonly tag: 'move-node';
      readonly target: NodeRef;
      readonly destination: NodeRef;
      readonly placement: Placement;
    }
  | {
      readonly tag: 'rename-binding';
      readonly target: NodeRef;
      readonly from: string;
      readonly to: string;
    }
  /** Step 9: a tag's name, in its opening and closing tags. */
  | { readonly tag: 'rename-tag'; readonly target: NodeRef; readonly to: string }
  /** Step 9: one attribute's name, in place. */
  | {
      readonly tag: 'rename-attribute';
      readonly target: NodeRef;
      readonly from: string;
      readonly to: string;
    }
  /** Step 9: the node as it should now read. Main prints the old and the new
   * node, and writes only what the printer says changed, placed on the node's
   * own bytes (a `rewrite-node` intent) — never a reprint of the node. */
  | { readonly tag: 'replace-node'; readonly target: NodeRef; readonly node: PageNode }
  /** Step 9: the siblings from `target` through `last` put inside a new
   * `<name>` tag (a layout picked for a page without one). */
  | {
      readonly tag: 'wrap-nodes';
      readonly target: NodeRef;
      readonly last: NodeRef;
      readonly name: string;
    }
  /** A bare text run given a tag of its own (Convert to): `<name>` written
   * tight around the run's words, on their line, so only that run is wrapped
   * and no whitespace is added to the text around it. */
  | { readonly tag: 'wrap-text'; readonly target: NodeRef; readonly name: string }
  /** Step 9: a tag taken away, its children left where they are (a layout
   * removed from a page). */
  | { readonly tag: 'unwrap-node'; readonly target: NodeRef }
  /** Step 9: the first nodes of a page whose body is empty — nothing to stand
   * beside. Main prints them at the end of the file. */
  | { readonly tag: 'append-body'; readonly nodes: readonly PageNode[] }
  /** The frontmatter the page model now describes; main prints it and writes
   * only the slot that differs (an edit-frontmatter-slot intent). */
  | { readonly tag: 'set-frontmatter'; readonly model: PageModel }
  /** A visual gesture whose specialized syntax is unavailable. Main compares
   * the old and new printed models, maps only their semantic hunks onto the
   * authored bytes, and never replaces formatting-only regions. */
  | { readonly tag: 'replace-page'; readonly model: PageModel }
  /** Undo and redo: byte hunks a previous reply handed back, against the
   * checksum that reply named. */
  | { readonly tag: 'revert'; readonly hunks: readonly SourceEdit[] }
  /** The code editor (step 8): the byte diff from the text of the named
   * checksum to the editor's text (shared/engine/codePatch.ts). Each hunk names the
   * bytes it replaces, and main checks them against that checksum's bytes.
   * The result may not parse (plan §3.6). */
  | { readonly tag: 'code-patch'; readonly hunks: readonly CodeHunk[] };

export type EditTag = Edit['tag'];

export interface EditRequest {
  readonly pagePath: string;
  /** The checksum of the bytes the renderer's parse was read from. */
  readonly authoredChecksum: Digest;
  readonly edit: Edit;
}

/** Several edits of one gesture, written as one (page:editBatch). Sent one at
 * a time they were separate writes, and the dev server could render the page
 * between them: a loop reading a query its declaration had not reached yet. */
export interface EditBatchRequest {
  readonly pagePath: string;
  /** The checksum of the bytes every edit's references were read from. */
  readonly authoredChecksum: Digest;
  readonly edits: readonly Edit[];
}

/** A gesture composes a handful of edits (a loop, its query, its imports);
 * sixteen leaves room for every composition the editor makes, and a batch is
 * planned in memory edit by edit, so its length bounds that work. */
export const EDIT_BATCH_EDITS_MAX = 16;

const ATTRIBUTE_NAME_RE = /^[\w@:.-]+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const STYLE_PROPERTY_RE = /^(?:--[\w-]+|-?[a-z][a-z-]*)$/;

export function parseEditRequest(input: unknown): EditRequest {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('Expected an edit request object');
  }
  return {
    pagePath: pathText(record['pagePath']),
    authoredChecksum: digest(record['authoredChecksum']),
    edit: parseEdit(record['edit']),
  };
}

export function parseEditBatchRequest(input: unknown): EditBatchRequest {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error('Expected an edit batch request object');
  }
  const edits = toArray(record['edits']);
  if (edits === undefined) {
    throw new Error('EditBatch.edits: expected array');
  }
  // One edit is page:edit's; a batch exists to write several at once.
  if (edits.length < 2) {
    throw new Error('EditBatch.edits: expected at least two edits');
  }
  if (edits.length > EDIT_BATCH_EDITS_MAX) {
    throw new Error('EditBatch.edits: exceeds limit');
  }
  const parsed = edits.map(parseEdit);
  // Paired with the bound above: what crosses the wire is what was counted.
  assert(parsed.length === edits.length, 'Every batched edit is parsed');
  assert(parsed.length <= EDIT_BATCH_EDITS_MAX, 'A parsed batch stays inside its bound');
  return {
    pagePath: pathText(record['pagePath']),
    authoredChecksum: digest(record['authoredChecksum']),
    edits: parsed,
  };
}

export function parseEdit(input: unknown): Edit {
  const record = requireRecord(input, 'Edit');
  const tag = record['tag'];
  switch (tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style':
      return parseAttributeEdit(record, tag);
    case 'insert-node':
    case 'remove-node':
    case 'move-node':
    case 'wrap-nodes':
    case 'wrap-text':
    case 'unwrap-node':
    case 'replace-node':
      return parseStructureEdit(record, tag);
    case 'rename-binding':
      return parseRename(record);
    case 'rename-tag':
      return {
        tag,
        target: parseNodeRef(record['target'], 'Edit.target'),
        to: tagName(record['to'], 'Edit.to'),
      };
    case 'rename-attribute':
      return parseAttributeRename(record);
    case 'append-body': {
      const content = parseContent({ tag: 'nodes', nodes: record['nodes'] });
      assert(content.tag === 'nodes', 'Parsed as nodes');
      return { tag, nodes: content.nodes };
    }
    case 'set-frontmatter':
    case 'replace-page':
      return { tag, model: parsePageModel(record['model']) };
    case 'revert':
      return { tag, hunks: parseHunks(record['hunks']) };
    case 'code-patch':
      return { tag, hunks: parseCodeHunks(record['hunks']) };
    default:
      throw new Error(`Edit.tag: unknown edit ${JSON.stringify(tag)}`);
  }
}

// The edits that change one attribute or declaration of the target tag.
function parseAttributeEdit(record: Record<string, unknown>, tag: 'set-attribute' | 'remove-attribute' | 'set-inline-style'): Edit {
  // Paired with parseEdit's dispatch: the record is the edit it was routed as.
  assert(record['tag'] === tag, 'parseAttributeEdit: record tag matches its dispatch');
  const target = parseNodeRef(record['target'], 'Edit.target');
  switch (tag) {
    case 'set-attribute':
      return {
        tag,
        target,
        name: attributeName(record['name'], 'Edit.name'),
        value: parseAttributeValue(record['value']),
      };
    case 'remove-attribute':
      return { tag, target, name: attributeName(record['name'], 'Edit.name') };
    case 'set-inline-style':
      return {
        tag,
        target,
        property: styleProperty(record['property']),
        declaration: parseDeclaration(record['declaration']),
      };
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

// The edits that add, remove, move or replace whole nodes around the target.
function parseStructureEdit(
  record: Record<string, unknown>,
  tag: 'insert-node' | 'remove-node' | 'move-node' | 'wrap-nodes' | 'wrap-text' | 'unwrap-node' | 'replace-node',
): Edit {
  // Paired with parseEdit's dispatch: the record is the edit it was routed as.
  assert(record['tag'] === tag, 'parseStructureEdit: record tag matches its dispatch');
  const target = parseNodeRef(record['target'], 'Edit.target');
  switch (tag) {
    case 'insert-node':
      return {
        tag,
        target,
        placement: parsePlacement(record['placement']),
        content: parseContent(record['content']),
      };
    case 'remove-node':
    case 'unwrap-node':
      return { tag, target };
    case 'move-node':
      return {
        tag,
        target,
        destination: parseNodeRef(record['destination'], 'Edit.destination'),
        placement: parsePlacement(record['placement']),
      };
    case 'wrap-nodes':
      return {
        tag,
        target,
        last: parseNodeRef(record['last'], 'Edit.last'),
        name: tagName(record['name'], 'Edit.name'),
      };
    case 'wrap-text':
      return { tag, target, name: tagName(record['name'], 'Edit.name') };
    case 'replace-node':
      // One counter bounds the node like one page tree.
      return { tag, target, node: parsePageNode(record['node'], 'Edit.node', 0, { nodes: 0 }) };
    default: {
      const exhaustive: never = tag;
      return exhaustive;
    }
  }
}

export function parseNodeRef(input: unknown, where: string): NodeRef {
  const record = requireRecord(input, where);
  const steps = toArray(record['path']);
  if (steps === undefined) {
    throw new Error(`${where}.path: expected array`);
  }
  if (steps.length === 0) {
    throw new Error(`${where}.path: a node has at least one step`);
  }
  if (steps.length > STRUCTURAL_PATH_STEPS_MAX) {
    throw new Error(`${where}.path: exceeds ${STRUCTURAL_PATH_STEPS_MAX} steps`);
  }
  const path = steps.map((step, index) => {
    if (typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0) {
      throw new Error(`${where}.path[${index}]: expected a child index`);
    }
    if (step >= LIMITS.treeNodesMax) {
      throw new Error(`${where}.path[${index}]: exceeds ${LIMITS.treeNodesMax} siblings`);
    }
    return step;
  });
  return {
    path,
    kind: nodeKind(record['kind'], `${where}.kind`),
    span: parseUtf16Span(record['span'], `${where}.span`),
  };
}

function nodeKind(input: unknown, where: string): NodeKind {
  for (const kind of NODE_KINDS) {
    if (kind === input) {
      return kind;
    }
  }
  throw new Error(`${where}: unknown node kind ${JSON.stringify(input)}`);
}

function parseContent(input: unknown): InsertContent {
  const record = requireRecord(input, 'Edit.content');
  const tag = record['tag'];
  if (tag === 'copy') {
    return { tag, source: parseNodeRef(record['source'], 'Edit.content.source') };
  }
  if (tag === 'nodes') {
    const nodes = toArray(record['nodes']);
    if (nodes === undefined) {
      throw new Error('Edit.content.nodes: expected array');
    }
    if (nodes.length === 0) {
      throw new Error('Edit.content.nodes: expected at least one node');
    }
    // One shared counter bounds the whole insertion like one page tree.
    const context = { nodes: 0 };
    return {
      tag,
      nodes: nodes.map((node, index) => parsePageNode(node, `Edit.content.nodes[${index}]`, 0, context)),
    };
  }
  throw new Error(`Edit.content.tag: unknown value ${JSON.stringify(tag)}`);
}

function parseRename(record: Record<string, unknown>): Edit {
  const from = identifier(record['from'], 'Edit.from');
  const to = identifier(record['to'], 'Edit.to');
  if (from === to) {
    throw new Error('Edit.to: a rename must change the name');
  }
  return { tag: 'rename-binding', target: parseNodeRef(record['target'], 'Edit.target'), from, to };
}

function parseAttributeRename(record: Record<string, unknown>): Edit {
  const from = attributeName(record['from'], 'Edit.from');
  const to = attributeName(record['to'], 'Edit.to');
  if (from === to) {
    throw new Error('Edit.to: a rename must change the name');
  }
  const target = parseNodeRef(record['target'], 'Edit.target');
  return { tag: 'rename-attribute', target, from, to };
}

function parseHunks(input: unknown): readonly SourceEdit[] {
  const hunks = toArray(input);
  if (hunks === undefined) {
    throw new Error('Edit.hunks: expected array');
  }
  if (hunks.length > LIMITS.splicesPerIntentMax) {
    throw new Error(`Edit.hunks: exceeds ${LIMITS.splicesPerIntentMax} items`);
  }
  return hunks.map((hunk, index) => {
    const record = requireRecord(hunk, `Edit.hunks[${index}]`);
    return {
      span: parseByteSpan(record['span'], `Edit.hunks[${index}].span`),
      text: boundedText(record['text'], `Edit.hunks[${index}].text`, LIMITS.intentPayloadBytesMax),
    };
  });
}

// The shape only: at least one hunk, ascending and disjoint, each text inside
// the payload bound. Whether the witnesses hold, whether the hunks sit on code
// points, and whether the summed payload fits are main's to check against the
// bytes (electron/documents/editRequests.ts, the host) — a typed refusal, not a throw.
function parseCodeHunks(input: unknown): readonly CodeHunk[] {
  const hunks = toArray(input);
  if (hunks === undefined) {
    throw new Error('Edit.hunks: expected array');
  }
  if (hunks.length === 0) {
    throw new Error('Edit.hunks: a code patch has at least one hunk');
  }
  if (hunks.length > LIMITS.splicesPerIntentMax) {
    throw new Error(`Edit.hunks: exceeds ${LIMITS.splicesPerIntentMax} items`);
  }
  const parsed = hunks.map((hunk, index) => {
    const where = `Edit.hunks[${index}]`;
    const record = requireRecord(hunk, where);
    return {
      span: parseByteSpan(record['span'], `${where}.span`),
      expected: boundedText(record['expected'], `${where}.expected`, LIMITS.intentPayloadBytesMax),
      text: boundedText(record['text'], `${where}.text`, LIMITS.intentPayloadBytesMax),
    };
  });
  if (!spansAscending(parsed.map((hunk) => hunk.span))) {
    throw new Error('Edit.hunks: expected ascending disjoint spans');
  }
  return parsed;
}

function parseAttributeValue(input: unknown): AttributeValue {
  const record = requireRecord(input, 'Edit.value');
  const type = record['type'];
  if (type === 'bare') {
    return { type };
  }
  if (type === 'string' || type === 'expr') {
    return { type, value: boundedText(record['value'], 'Edit.value.value', LIMITS.attrCharsMax) };
  }
  throw new Error(`Edit.value.type: unknown value ${JSON.stringify(type)}`);
}

function parseDeclaration(input: unknown): StyleDeclaration {
  const record = requireRecord(input, 'Edit.declaration');
  const tag = record['tag'];
  if (tag === 'remove') {
    return { tag };
  }
  if (tag === 'set') {
    return {
      tag,
      value: boundedText(record['value'], 'Edit.declaration.value', LIMITS.attrCharsMax),
    };
  }
  throw new Error(`Edit.declaration.tag: unknown value ${JSON.stringify(tag)}`);
}

function parsePlacement(input: unknown): Placement {
  for (const placement of PLACEMENTS) {
    if (placement === input) {
      return placement;
    }
  }
  throw new Error(`Edit.placement: unknown value ${JSON.stringify(input)}`);
}

function attributeName(input: unknown, where: string): string {
  const name = boundedText(input, where, LIMITS.attrCharsMax);
  if (!ATTRIBUTE_NAME_RE.test(name)) {
    throw new Error(`${where}: expected an attribute name`);
  }
  return name;
}

function tagName(input: unknown, where: string): string {
  const name = boundedText(input, where, LIMITS.tagNameCharsMax);
  if (!TAG_NAME_RE.test(name)) {
    throw new Error(`${where}: expected a tag name`);
  }
  return name;
}

function styleProperty(input: unknown): string {
  const property = boundedText(input, 'Edit.property', LIMITS.attrCharsMax);
  if (!STYLE_PROPERTY_RE.test(property)) {
    throw new Error('Edit.property: expected a CSS property name');
  }
  return property;
}

function identifier(input: unknown, where: string): string {
  const name = boundedText(input, where, LIMITS.tagNameCharsMax);
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`${where}: expected an identifier`);
  }
  return name;
}

function boundedText(input: unknown, where: string, charsMax: number): string {
  if (typeof input !== 'string') {
    throw new Error(`${where}: expected string`);
  }
  if (input.length > charsMax) {
    throw new Error(`${where}: exceeds ${charsMax} chars`);
  }
  return input;
}

function requireRecord(input: unknown, where: string): Record<string, unknown> {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error(`${where}: expected object`);
  }
  return record;
}
