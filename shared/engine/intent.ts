// Intents, submission and outcomes (plan §3.3, §3.5). An intent is an immutable
// command authored against one version of one file: it names that version by
// checksum, the place by an anchor, and the change by a closed operation union.
// Submission and terminal results are separate types, because backpressure is
// not a rejection: a backpressured intent was never accepted and still belongs
// to the persistence layer.
import { assert } from '../core/assert';
import { toFilePath, toIntentId, type Digest, type FilePath, type IntentId } from '../core/brand';
import { digest, pathText } from '../core/boundary';
import { LIMITS } from '../core/limits';
import { toArray, toRecord } from '../core/record';
import { isNodeKind, parseAnchorRef, type AnchorKind, type AnchorRef } from '../page/ref';
import { parseByteSpan, spanContains, spansAscending, utf8ByteLength, type ByteSpan } from '../core/span';

export type AttributeValue =
  { readonly type: 'string'; readonly value: string } | { readonly type: 'expr'; readonly value: string } | { readonly type: 'bare' };

export const PLACEMENTS = ['before', 'after', 'first-child', 'last-child'] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** Replace the authored bytes at `span` with `text`. */
export interface SourceEdit {
  readonly span: ByteSpan;
  readonly text: string;
}

export type StyleDeclaration = { readonly tag: 'set'; readonly value: string } | { readonly tag: 'remove' };

/** The closed operation set (plan §3.3). New operations extend this union; they
 * never extend a writer.
 *
 * Added at step 6: `remove-node` (the plan's "insert/remove" gesture needs a
 * removal, which the initial list lacked) and `revert-splices`, the inverse of
 * an applied outcome that Undo submits (plan §11 step 6). A revert is not a
 * code patch: a code patch is text the user wrote and may leave the file
 * invalid (§3.6); a revert restores bytes an applied intent replaced, keeps a
 * parsing file parsing, and a stale one is a moved region, not a merge.
 *
 * Added at step 9, so the gestures that only a whole-model save could carry
 * reach disk as splices: `rename-tag` (the name in the opening and closing
 * tags), `rename-attribute` (one attribute's name, in place) and
 * `rewrite-node` (hunks inside one node the node's own bytes witness, for an
 * edit the printer states as the node's new text — a note reworded, a text
 * set, a branch added). None of them ever writes outside its node. And
 * `wrap-nodes`, a run of siblings put inside a new tag (a layout picked for a
 * page without one): its opening before the first, its closing after the
 * last, every byte of the run kept. And `append-body`: the first node of a
 * page whose body is empty, which has no node to stand beside.
 *
 * Added at step 10: `insert-frontmatter`, the frontmatter block of a page that
 * has none, written at its top (a layout picked for a Markdown post without
 * one). An edit of an existing block stays a slot. And `rewrite-text`, which
 * replaced the migration-only `replace-source`, the whole-file replacement the
 * legacy saves submitted from step 5: a program's change to a file's text — a
 * stylesheet rule, a CMS entry, a property batch — stated as the hunks where
 * the new text differs from the bytes it read, and written only while the file
 * holds exactly those bytes. No operation replaces a whole file. */
export type Operation =
  | { readonly tag: 'set-attribute'; readonly name: string; readonly value: AttributeValue }
  | { readonly tag: 'remove-attribute'; readonly name: string }
  | { readonly tag: 'insert-node'; readonly placement: Placement; readonly source: string }
  | { readonly tag: 'remove-node' }
  | { readonly tag: 'move-node'; readonly destination: AnchorRef; readonly placement: Placement }
  | {
      readonly tag: 'rename-binding';
      readonly from: string;
      readonly to: string;
      readonly sites: readonly ByteSpan[];
    }
  | {
      readonly tag: 'set-inline-style';
      readonly property: string;
      readonly declaration: StyleDeclaration;
    }
  | { readonly tag: 'apply-code-patch'; readonly hunks: readonly SourceEdit[] }
  | { readonly tag: 'edit-frontmatter-slot'; readonly slot: ByteSpan; readonly text: string }
  | { readonly tag: 'revert-splices'; readonly hunks: readonly SourceEdit[] }
  | { readonly tag: 'rename-tag'; readonly from: string; readonly to: string }
  | { readonly tag: 'rename-attribute'; readonly from: string; readonly to: string }
  | { readonly tag: 'rewrite-node'; readonly hunks: readonly SourceEdit[] }
  | { readonly tag: 'append-body'; readonly source: string }
  | { readonly tag: 'insert-frontmatter'; readonly source: string }
  | {
      readonly tag: 'wrap-nodes';
      readonly last: AnchorRef;
      readonly open: string;
      readonly close: string;
    }
  | { readonly tag: 'rewrite-text'; readonly hunks: readonly SourceEdit[] };

export type OperationTag = Operation['tag'];

export interface Intent {
  readonly id: IntentId;
  /** Canonical path; the actor is per file, so one intent touches one file. */
  readonly file: FilePath;
  /** The checksum of the bytes the anchor and every span were authored against. */
  readonly authoredChecksum: Digest;
  readonly anchor: AnchorRef;
  readonly operation: Operation;
}

export type SubmissionResult = { readonly tag: 'accepted'; readonly intentId: IntentId } | { readonly tag: 'backpressured' };

export const REJECTION_REASONS = [
  'anchor-moved',
  'anchor-ambiguous',
  'region-externally-modified',
  'source-invalid',
  'unsupported-operation',
  'resource-limit',
  'write-failed',
  'write-race',
  'merge-conflict',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Every accepted intent reaches exactly one of these (plan §3.5). `uncertain`
 * is the crash window between the atomic replace and the verifying read; its
 * candidate checksum lets a reconnect compare instead of guess. */
export type Outcome =
  | {
      readonly tag: 'applied';
      readonly intentId: IntentId;
      readonly changedRanges: readonly ByteSpan[];
      readonly checksum: Digest;
    }
  | { readonly tag: 'rejected'; readonly intentId: IntentId; readonly reason: RejectionReason }
  | {
      readonly tag: 'uncertain';
      readonly intentId: IntentId;
      readonly candidateChecksum: Digest | undefined;
    };

const ATTRIBUTE_NAME_RE = /^[\w@:.-]+$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
/** A tag or component name as the parser reads one: a letter, then name
 * characters — `div`, `my-card`, `Card`, `Icons.Arrow`, `svg:path`. */
export const TAG_NAME_RE = /^[A-Za-z][\w.:-]*$/;
const STYLE_PROPERTY_RE = /^(?:--[\w-]+|-?[a-z][a-z-]*)$/;

/** The notice text for a rejection (plan §7): names the reason, never blames
 * the user, and never implies their input is gone. */
export function describeRejection(reason: RejectionReason): string {
  switch (reason) {
    case 'anchor-moved':
      return 'The element you edited is no longer where it was.';
    case 'anchor-ambiguous':
      return 'The file changed and several elements now match the one you edited.';
    case 'region-externally-modified':
      return 'That part of the file was changed outside Stacki.';
    case 'source-invalid':
      return 'The page contains a syntax error that Stacki needs resolved before saving this edit.';
    case 'unsupported-operation':
      return 'Stacki encountered an editor error while applying the change.';
    case 'resource-limit':
      return 'The change exceeds a size limit.';
    case 'write-failed':
      return 'The file could not be written.';
    case 'write-race':
      return 'Another program wrote the file at the same moment.';
    case 'merge-conflict':
      return 'Your code edit overlaps another change to the file, so it was not merged.';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

export function parseRejectionReason(input: unknown, where: string): RejectionReason {
  for (const reason of REJECTION_REASONS) {
    if (reason === input) {
      return reason;
    }
  }
  throw new Error(`${where}: unknown rejection reason ${JSON.stringify(input)}`);
}

/** UTF-8 bytes of every string the intent carries, summed (LIMITS.intentPayloadBytesMax). */
export function intentPayloadBytes(operation: Operation): number {
  return operationTexts(operation).reduce((total, text) => total + utf8ByteLength(text), 0);
}

function operationTexts(operation: Operation): readonly string[] {
  switch (operation.tag) {
    case 'set-attribute':
      return operation.value.type === 'bare' ? [operation.name] : [operation.name, operation.value.value];
    case 'remove-attribute':
      return [operation.name];
    case 'insert-node':
    case 'append-body':
    case 'insert-frontmatter':
      return [operation.source];
    case 'remove-node':
    case 'move-node':
      return [];
    case 'rename-binding':
    case 'rename-tag':
    case 'rename-attribute':
      return [operation.from, operation.to];
    case 'set-inline-style':
      return operation.declaration.tag === 'set' ? [operation.property, operation.declaration.value] : [operation.property];
    case 'apply-code-patch':
    case 'revert-splices':
    case 'rewrite-node':
    case 'rewrite-text':
      return operation.hunks.map((hunk) => hunk.text);
    case 'edit-frontmatter-slot':
      return [operation.text];
    case 'wrap-nodes':
      return [operation.open, operation.close];
    default: {
      const exhaustive: never = operation;
      return exhaustive;
    }
  }
}

/** The validated constructor: every cross-field rule between the anchor and the
 * operation is checked here, so a parsed Intent is one the planner may trust. */
export function toIntent(input: Intent): Intent {
  checkOperationAnchor(input.operation, input.anchor);
  const payloadBytes = intentPayloadBytes(input.operation);
  if (payloadBytes > LIMITS.intentPayloadBytesMax) {
    throw new Error(`Intent: payload exceeds ${LIMITS.intentPayloadBytesMax} bytes`);
  }
  assert(payloadBytes >= 0, 'Payload size is a count');
  return input;
}

function checkOperationAnchor(operation: Operation, anchor: AnchorRef): void {
  const kind = anchor.expectedKind;
  switch (operation.tag) {
    case 'set-attribute':
    case 'remove-attribute':
    case 'set-inline-style':
    case 'rename-attribute':
      requireKind(operation.tag, { allowed: isAttributeHost(kind) });
      return;
    case 'rename-tag':
      // A `<style>` or `<script>` is raw text by its name: renaming one
      // changes how everything inside it parses, which is code, not a tag.
      requireKind(operation.tag, { allowed: kind === 'element' || kind === 'component' });
      requireNewName(operation.tag, operation.from, operation.to);
      return;
    case 'rewrite-node':
      requireKind(operation.tag, { allowed: isNodeKind(kind) });
      requireSites(
        operation.tag,
        anchor.span,
        operation.hunks.map((hunk) => hunk.span),
      );
      return;
    case 'insert-node':
    case 'remove-node':
      requireKind(operation.tag, { allowed: isNodeKind(kind) });
      return;
    case 'move-node':
      requireKind(operation.tag, { allowed: isNodeKind(kind) });
      requireKind(operation.tag, { allowed: isNodeKind(operation.destination.expectedKind) });
      return;
    case 'wrap-nodes':
      requireKind(operation.tag, { allowed: isNodeKind(kind) });
      requireKind(operation.tag, { allowed: isNodeKind(operation.last.expectedKind) });
      return;
    case 'rename-binding':
      requireKind(operation.tag, { allowed: kind === 'map' });
      requireSites(operation.tag, anchor.span, operation.sites);
      return;
    case 'apply-code-patch':
    case 'revert-splices':
    case 'rewrite-text':
      requireKind(operation.tag, { allowed: kind === 'document' });
      requireSites(
        operation.tag,
        anchor.span,
        operation.hunks.map((hunk) => hunk.span),
      );
      return;
    case 'edit-frontmatter-slot':
      requireKind(operation.tag, { allowed: kind === 'frontmatter' });
      requireSites(operation.tag, anchor.span, [operation.slot]);
      return;
    case 'append-body':
    case 'insert-frontmatter':
      requireKind(operation.tag, { allowed: kind === 'document' });
      return;
    default: {
      const exhaustive: never = operation;
      throw new Error(`Intent: unknown operation ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Tags carry attributes: elements, component invocations, and <style>/<script>.
 * Bare text has no tag, so nothing can be set on it until it is given one. */
export function isAttributeHost(kind: AnchorKind): boolean {
  switch (kind) {
    case 'element':
    case 'component':
    case 'raw':
      return true;
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
    case 'frontmatter':
    case 'document':
      return false;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function requireNewName(tag: OperationTag, from: string, to: string): void {
  if (from === to) {
    throw new Error(`Intent: ${tag} must change the name`);
  }
}

function requireKind(tag: OperationTag, check: { readonly allowed: boolean }): void {
  if (!check.allowed) {
    throw new Error(`Intent: ${tag} cannot target this anchor kind`);
  }
}

// Sites of a multi-span operation lie inside the anchor, in ascending order,
// pairwise disjoint: overlapping sites would make the splice order a guess.
function requireSites(tag: OperationTag, anchor: ByteSpan, sites: readonly ByteSpan[]): void {
  if (sites.length === 0) {
    throw new Error(`Intent: ${tag} needs at least one site`);
  }
  if (sites.length > LIMITS.splicesPerIntentMax) {
    throw new Error(`Intent: ${tag} exceeds ${LIMITS.splicesPerIntentMax} sites`);
  }
  if (!spansAscending(sites)) {
    throw new Error(`Intent: ${tag} sites must ascend without overlapping`);
  }
  for (const site of sites) {
    if (!spanContains(anchor, site)) {
      throw new Error(`Intent: ${tag} site lies outside its anchor`);
    }
  }
}

// --- Wire parsers ----------------------------------------------------------

export function parseIntent(input: unknown): Intent {
  const record = requireRecord(input, 'Intent');
  const id = record['id'];
  if (typeof id !== 'string') {
    throw new Error('Intent.id: expected string');
  }
  return toIntent({
    id: toIntentId(id),
    file: toFilePath(pathText(record['file'])),
    authoredChecksum: digest(record['authoredChecksum']),
    anchor: parseAnchorRef(record['anchor'], 'Intent.anchor'),
    operation: parseOperation(record['operation']),
  });
}

function parseOperation(input: unknown): Operation {
  const record = requireRecord(input, 'Operation');
  const tag = record['tag'];
  switch (tag) {
    case 'set-attribute':
      return {
        tag,
        name: attributeName(record['name'], 'Operation.name'),
        value: parseAttributeValue(record['value']),
      };
    case 'remove-attribute':
      return { tag, name: attributeName(record['name'], 'Operation.name') };
    case 'insert-node':
      return {
        tag,
        placement: parsePlacement(record['placement']),
        source: payloadText(record['source'], 'Operation.source'),
      };
    case 'remove-node':
      return { tag };
    case 'move-node':
      return {
        tag,
        destination: parseAnchorRef(record['destination'], 'Operation.destination'),
        placement: parsePlacement(record['placement']),
      };
    case 'rename-binding':
      return parseRenameBinding(record);
    case 'set-inline-style':
      return parseSetInlineStyle(record);
    case 'apply-code-patch':
    case 'revert-splices':
    case 'rewrite-node':
    case 'rewrite-text':
      return { tag, hunks: parseHunks(record['hunks']) };
    case 'rename-tag':
      return {
        tag,
        from: tagName(record['from'], 'Operation.from'),
        to: tagName(record['to'], 'Operation.to'),
      };
    case 'append-body':
    case 'insert-frontmatter':
      return { tag, source: payloadText(record['source'], 'Operation.source') };
    case 'wrap-nodes':
      return {
        tag,
        last: parseAnchorRef(record['last'], 'Operation.last'),
        open: payloadText(record['open'], 'Operation.open'),
        close: payloadText(record['close'], 'Operation.close'),
      };
    case 'rename-attribute': {
      const from = attributeName(record['from'], 'Operation.from');
      const to = attributeName(record['to'], 'Operation.to');
      if (from === to) {
        throw new Error('Operation.to: a rename must change the name');
      }
      return { tag, from, to };
    }
    case 'edit-frontmatter-slot':
      return {
        tag,
        slot: parseByteSpan(record['slot'], 'Operation.slot'),
        text: payloadText(record['text'], 'Operation.text'),
      };
    default:
      throw new Error(`Operation.tag: unknown operation ${JSON.stringify(tag)}`);
  }
}

function parseRenameBinding(record: Record<string, unknown>): Operation {
  const from = identifier(record['from'], 'Operation.from');
  const to = identifier(record['to'], 'Operation.to');
  if (from === to) {
    throw new Error('Operation.to: a rename must change the name');
  }
  const sites = boundedArray(record['sites'], 'Operation.sites', LIMITS.splicesPerIntentMax);
  return {
    tag: 'rename-binding',
    from,
    to,
    sites: sites.map((site, index) => parseByteSpan(site, `Operation.sites[${index}]`)),
  };
}

function parseSetInlineStyle(record: Record<string, unknown>): Operation {
  const property = record['property'];
  if (typeof property !== 'string') {
    throw new Error('Operation.property: expected string');
  }
  if (property.length > LIMITS.attrCharsMax) {
    throw new Error(`Operation.property: exceeds ${LIMITS.attrCharsMax} chars`);
  }
  if (!STYLE_PROPERTY_RE.test(property)) {
    throw new Error('Operation.property: expected a CSS property name');
  }
  const declaration = requireRecord(record['declaration'], 'Operation.declaration');
  const tag = declaration['tag'];
  if (tag === 'remove') {
    return { tag: 'set-inline-style', property, declaration: { tag } };
  }
  if (tag === 'set') {
    const value = boundedText(declaration['value'], 'Operation.declaration.value', LIMITS.attrCharsMax);
    return { tag: 'set-inline-style', property, declaration: { tag, value } };
  }
  throw new Error(`Operation.declaration.tag: unknown value ${JSON.stringify(tag)}`);
}

function parseHunks(input: unknown): readonly SourceEdit[] {
  const hunks = boundedArray(input, 'Operation.hunks', LIMITS.splicesPerIntentMax);
  return hunks.map((hunk, index) => {
    const record = requireRecord(hunk, `Operation.hunks[${index}]`);
    return {
      span: parseByteSpan(record['span'], `Operation.hunks[${index}].span`),
      text: payloadText(record['text'], `Operation.hunks[${index}].text`),
    };
  });
}

function parseAttributeValue(input: unknown): AttributeValue {
  const record = requireRecord(input, 'Operation.value');
  const type = record['type'];
  if (type === 'bare') {
    return { type };
  }
  if (type === 'string' || type === 'expr') {
    return {
      type,
      value: boundedText(record['value'], 'Operation.value.value', LIMITS.attrCharsMax),
    };
  }
  throw new Error(`Operation.value.type: unknown value ${JSON.stringify(type)}`);
}

function parsePlacement(input: unknown): Placement {
  for (const placement of PLACEMENTS) {
    if (placement === input) {
      return placement;
    }
  }
  throw new Error(`Operation.placement: unknown value ${JSON.stringify(input)}`);
}

export function parseSubmissionResult(input: unknown): SubmissionResult {
  const record = requireRecord(input, 'SubmissionResult');
  const tag = record['tag'];
  if (tag === 'backpressured') {
    return { tag };
  }
  if (tag === 'accepted') {
    return { tag, intentId: parseIntentId(record['intentId'], 'SubmissionResult.intentId') };
  }
  throw new Error(`SubmissionResult.tag: unknown value ${JSON.stringify(tag)}`);
}

export function parseOutcome(input: unknown): Outcome {
  const record = requireRecord(input, 'Outcome');
  const intentId = parseIntentId(record['intentId'], 'Outcome.intentId');
  const tag = record['tag'];
  switch (tag) {
    case 'applied': {
      const ranges = boundedArray(record['changedRanges'], 'Outcome.changedRanges', LIMITS.splicesPerIntentMax);
      const changedRanges = ranges.map((range, index) => parseByteSpan(range, `Outcome.changedRanges[${index}]`));
      if (!spansAscending(changedRanges)) {
        throw new Error('Outcome.changedRanges: expected ascending disjoint ranges');
      }
      return { tag, intentId, changedRanges, checksum: digest(record['checksum']) };
    }
    case 'rejected':
      return { tag, intentId, reason: parseRejectionReason(record['reason'], 'Outcome.reason') };
    case 'uncertain': {
      const candidate = record['candidateChecksum'];
      return {
        tag,
        intentId,
        candidateChecksum: candidate === undefined ? undefined : digest(candidate),
      };
    }
    default:
      throw new Error(`Outcome.tag: unknown value ${JSON.stringify(tag)}`);
  }
}

function parseIntentId(input: unknown, where: string): IntentId {
  if (typeof input !== 'string') {
    throw new Error(`${where}: expected string`);
  }
  return toIntentId(input);
}

function requireRecord(input: unknown, where: string): Record<string, unknown> {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error(`${where}: expected object`);
  }
  return record;
}

function boundedArray(input: unknown, where: string, itemsMax: number): readonly unknown[] {
  const items = toArray(input);
  if (items === undefined) {
    throw new Error(`${where}: expected array`);
  }
  if (items.length > itemsMax) {
    throw new Error(`${where}: exceeds ${itemsMax} items`);
  }
  return items;
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

// A payload string may be as long as a whole file; toIntent then bounds the sum.
function payloadText(input: unknown, where: string): string {
  return boundedText(input, where, LIMITS.intentPayloadBytesMax);
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

function identifier(input: unknown, where: string): string {
  const name = boundedText(input, where, LIMITS.tagNameCharsMax);
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`${where}: expected an identifier`);
  }
  return name;
}
