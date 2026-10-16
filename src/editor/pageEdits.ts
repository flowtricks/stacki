// The persistence layer's edit queue (plan §2 layer 3, §7, §11.9): what the
// open page owes the disk, in the order the user made it, and how each part
// reaches the page's actor.
//
// Two kinds of entry, never mixed up:
//   - a gesture (any page — .astro, Markdown or MDX since step 10): the edit
//     requests it becomes, stated when it is sent — against the page as the
//     app's last reply left it (the origin), so a node an earlier gesture
//     created a moment ago is already there to name. A request names nodes by
//     the facts of that parse (path, kind, source range), and main checks them
//     against its own projection of the same bytes. Nothing is saved as a
//     whole model: when specialized syntax cannot state a gesture, the
//     smallest stable node changed by its model effect is rewritten instead.
//   - typed code (step 8): the page's text, saved as one patch from the
//     baseline the typing descends from (src/editor/codeEdits.ts). At most one, and
//     first: typing replaces the unsent gestures, which the text it was typed
//     into does not hold.
//
// The rules (plan §7): gestures coalesce within one stream (one field of one
// node) and one undo step while unsent — the last value wins; the queue is
// bounded (LIMITS.intentsPendingMax), and a gesture past it is refused, never
// queued; a refusal never destroys input — the entry stays queued and the
// page's conflict notice names the reason.
//
// Undo steps (EditsRecord) learn their inverses as replies arrive. An entry
// carrying several steps' bytes in one write (typing) gives its inverse to the
// newest step; the older ones are `folded` into it.
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import type { Edit, EditRequest, NodeRef } from '../../shared/engine/editRequest';
import type { RejectionReason, SourceEdit } from '../../shared/engine/intent';
import { LIMITS } from '../../shared/core/limits';
import type { PageEditError, PageEdited } from '../../shared/ipc/pageSave';
import type { PageModel, PageNode } from '../../shared/page/pageNode';
import type { Result } from '../../shared/core/result';
import type { EditorModel } from './pageView';
import type { SaveState } from './saveState';

/** The page as the app's last read or reply left it: its checksum, its text,
 * and that text's parse, keyed by the session's node handles
 * (src/editor/nodeHandles.ts). Requests are stated against it. */
export interface PageOrigin {
  readonly checksum: Digest;
  readonly source: string;
  readonly model: PageModel;
}

/** One applied write, as Undo needs it: the inverse hunks and the checksum of
 * the bytes they are hunks of. */
export interface AppliedEdit {
  readonly checksum: Digest;
  readonly inverse: readonly SourceEdit[];
}

/** What became of an undo step's writes. */
export type EditsOutcome =
  /** `waiting` writes are still owed an answer. */
  | { readonly tag: 'pending'; readonly waiting: number; readonly applied: readonly AppliedEdit[] }
  | { readonly tag: 'applied'; readonly applied: readonly AppliedEdit[] }
  /** A newer step's write carried this one's bytes; that step's undo reverts
   * both, and this one has nothing of its own to undo. */
  | { readonly tag: 'folded' }
  /** Never written: typing replaced it before it was sent. */
  | { readonly tag: 'dropped' };

/** An undo step. Its outcome is written as answers arrive: the one field of it
 * that changes, owned by this queue and the undo that reads it. */
export interface EditsRecord {
  outcome: EditsOutcome;
}

/** A gesture as edit requests, stated against a parse (`refOf` names the parse's
 * nodes), and its effect on the shown model. The effect is a pure function —
 * a new model, the old one untouched. `request` may be undefined when the
 * specialized edit cannot express the syntax; sending then derives a safe,
 * minimal node rewrite from `apply`. */
export interface EditGesture {
  readonly request: (refOf: (nodeId: string) => NodeRef | undefined) => readonly Edit[] | undefined;
  readonly apply: (model: EditorModel) => EditorModel;
  /** Groups undo steps and coalesces bursts. */
  readonly coalesceKey: string | undefined;
  readonly urgency: boolean | 'live';
  /** One field of one node, by the session's handle: an unsent gesture of the
   * same stream and undo step is replaced by this one. Undefined for a gesture
   * that must go out on its own. */
  readonly stream: string | undefined;
}

/** The bytes a code save is a patch of (step 8). */
export type CodeBaseline =
  /** A version the page's actor holds: its checksum and text, and the text
   * the editor's typing descends from. The two texts are one unless a save
   * came back holding more than it sent — an outside edit merged, a request
   * rebased — and then the next save merges the typing into it first. */
  | {
      readonly tag: 'known';
      readonly checksum: Digest;
      readonly source: string;
      readonly typedFrom: string;
    }
  /** "Save this version" over a refused save: the patch is of whatever the
   * disk holds at the page's base, read when the save is sent. */
  | { readonly tag: 'disk' };

export type QueueEntry =
  | {
      readonly tag: 'gesture';
      readonly gesture: EditGesture;
      readonly record: EditsRecord;
      /** The stream of every request it states, when they share one. */
      readonly stream: string | undefined;
    }
  | {
      readonly tag: 'code';
      readonly baseline: CodeBaseline;
      readonly records: readonly EditsRecord[];
    };

/** A page as the code editor showed it when the user typed: its save state,
 * the text its editor held, and the origin that text descends from. */
export interface TypedFrom {
  readonly save: SaveState;
  readonly source: string;
  readonly origin: PageOrigin | undefined;
}

/** The unsent entries of the open page. Private, mutable state with one owner
 * (AGENTS.md §7): the page saver sends entries in order, and the gestures of
 * the open page add them. Keyed by path: another page's entries are never
 * owed (the saver flushes before a page changes). */
export class EditDrafts {
  #path: string | undefined;
  #entries: QueueEntry[] = [];

  entries(path: string): readonly QueueEntry[] {
    return path === this.#path ? this.#entries : [];
  }

  /** Nothing is owed the disk for `path`. */
  empty(path: string): boolean {
    return this.entries(path).length === 0;
  }

  /** Queue a gesture; 'full' past the bound, and then it is not queued. A
   * gesture of the stream and undo step the last unsent one had replaces it:
   * each states its field's whole value, so only the last reaches disk. */
  addGesture(path: string, gesture: EditGesture, record: EditsRecord): 'queued' | 'full' {
    this.#own(path);
    const stream = gesture.stream;
    const last = this.#entries[this.#entries.length - 1];
    if (last?.tag === 'gesture' && stream !== undefined) {
      if (last.stream === stream && last.record === record) {
        this.#entries[this.#entries.length - 1] = { tag: 'gesture', gesture, record, stream };
        return 'queued';
      }
    }
    if (this.#entries.length >= LIMITS.intentsPendingMax) {
      return 'full';
    }
    owe(record);
    this.#entries.push({ tag: 'gesture', gesture, record, stream });
    return 'queued';
  }

  /** The user typed in the code editor (or Undo put text back): from now on
   * the page's edits are its text, saved as one patch. Unsent gestures go —
   * the text typed into does not hold them. The baseline is the page as shown
   * before the change: the text the typing descends from and the checksum of
   * those bytes. A refused page's shown text may be a review of the model
   * rather than bytes on disk, so its baseline is the disk, read at the save. */
  typeCode(path: string, shown: TypedFrom, record: EditsRecord): void {
    this.#own(path);
    const code = this.#entries.find((entry) => entry.tag === 'code');
    for (const entry of this.#entries) {
      if (entry.tag !== 'code') {
        for (const replaced of recordsOf(entry)) {
          replaced.outcome = { tag: 'dropped' };
        }
      }
    }
    const records = code === undefined ? [] : code.records;
    const baseline = code === undefined ? typedBaseline(shown) : code.baseline;
    const kept = records.includes(record) ? records : [...records, record];
    if (!records.includes(record)) {
      owe(record);
    }
    this.#entries = [{ tag: 'code', baseline, records: kept }];
    assert(this.#entries.length === 1, 'Typing leaves the page one patch to save');
  }

  /** The baseline of the page's code entry. */
  codeBaseline(path: string): CodeBaseline {
    const code = this.entries(path).find((entry) => entry.tag === 'code');
    assert(code?.tag === 'code', 'Only a code entry has a baseline');
    return code.baseline;
  }

  /** A code save applied: the disk holds `checksum`, whose text is `source`,
   * and any typing since descends from `typedFrom`, the text the save sent. */
  codeSaved(path: string, saved: Omit<Extract<CodeBaseline, { tag: 'known' }>, 'tag'>): void {
    const at = this.entries(path).findIndex((entry) => entry.tag === 'code');
    const code = this.#entries[at];
    if (code?.tag !== 'code') {
      return; // Taken by the save that is reporting now.
    }
    this.#entries[at] = { ...code, baseline: { tag: 'known', ...saved } };
  }

  /** The user keeps their text over a refused save ("Save this version"):
   * the code entry now patches whatever the disk holds at the new base. */
  acceptDisk(path: string): void {
    const at = this.entries(path).findIndex((entry) => entry.tag === 'code');
    const code = this.#entries[at];
    if (code?.tag === 'code') {
      this.#entries[at] = { ...code, baseline: { tag: 'disk' } };
    }
  }

  /** Take the oldest entry to send now. */
  shift(path: string): QueueEntry | undefined {
    if (path !== this.#path) {
      return undefined;
    }
    return this.#entries.shift();
  }

  /** Put back an entry a save did not send, ahead of newer ones. Typing
   * since replaced an unsent gesture, so that one is dropped instead. */
  unshift(path: string, entry: QueueEntry): void {
    this.#own(path);
    const [first] = this.#entries;
    if (entry.tag === 'gesture' && first?.tag === 'code') {
      writeOutcome(entry.record, { tag: 'dropped' });
      return;
    }
    if (entry.tag === 'code' && first?.tag === 'code') {
      // Typed on during the save: one entry, the newer text, every step.
      const older = first.records.filter((record) => !entry.records.includes(record));
      const records = [...entry.records, ...older];
      this.#entries[0] = { ...first, baseline: entry.baseline, records };
      return;
    }
    this.#entries.unshift(entry);
  }

  /** Forget everything owed (a reload discards local edits). */
  discard(path: string): void {
    for (const entry of this.entries(path)) {
      for (const record of recordsOf(entry)) {
        record.outcome = { tag: 'dropped' };
      }
    }
    if (path === this.#path) {
      this.#entries = [];
    }
  }

  // The queue belongs to one page; another page's entries were flushed or
  // discarded before it opened, so switching forgets them.
  #own(path: string): void {
    if (path !== this.#path) {
      this.#path = path;
      this.#entries = [];
    }
  }
}

function typedBaseline(shown: TypedFrom): CodeBaseline {
  const save = shown.save;
  switch (save.tag) {
    case 'clean':
    case 'dirty':
    case 'saving': {
      // Visual edits change the model, never `source`: it is the text of the
      // origin, the bytes the page's edits were stated against.
      const origin = shown.origin;
      const checksum = save.tag === 'clean' ? save.checksum : save.baseChecksum;
      assert(origin === undefined || origin.checksum === checksum, 'The shown text is the origin');
      return { tag: 'known', checksum, source: shown.source, typedFrom: shown.source };
    }
    case 'conflicted':
      return { tag: 'disk' };
    default: {
      const exhaustive: never = save;
      return exhaustive;
    }
  }
}

/** The undo steps an entry writes for. */
export function recordsOf(entry: QueueEntry): readonly EditsRecord[] {
  switch (entry.tag) {
    case 'gesture':
      return [entry.record];
    case 'code':
      return entry.records;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

/** An entry's one write applied: the newest step learns the inverse, the rest
 * are folded into it. */
export function recordWrite(records: readonly EditsRecord[], applied: AppliedEdit): void {
  const newest = records[records.length - 1];
  assert(newest !== undefined, 'A write is made for at least one step');
  for (const record of records.slice(0, -1)) {
    record.outcome = { tag: 'folded' };
  }
  recordApplied(newest, applied);
}

/** One request went out and applied: the undo step learns its inverse. */
export function recordApplied(record: EditsRecord, applied: AppliedEdit): void {
  const outcome = record.outcome;
  if (outcome.tag !== 'pending') {
    return; // Dropped or folded meanwhile: nothing of its own to undo.
  }
  assert(outcome.waiting > 0, 'An answer arrives for a write the step waits on');
  const done = [...outcome.applied, applied];
  writeOutcome(
    record,
    outcome.waiting === 1
      ? { tag: 'applied', applied: done }
      : { tag: 'pending', waiting: outcome.waiting - 1, applied: done },
  );
}

/** The one writer of an undo step's outcome. A step is a cell shared by the
 * queue, the saver and Undo by identity (see EditsRecord): its outcome changes
 * as answers arrive, so it is written in place here rather than rebuilt. */
export function writeOutcome(record: EditsRecord, outcome: EditsOutcome): void {
  assert(record.outcome !== outcome, 'An outcome is written as a new value');
  // eslint-disable-next-line no-param-reassign -- EditsRecord is a shared cell; its one writer.
  record.outcome = outcome;
}

// The step is owed one more write.
function owe(record: EditsRecord): void {
  const outcome = record.outcome;
  switch (outcome.tag) {
    case 'pending':
      writeOutcome(record, { ...outcome, waiting: outcome.waiting + 1 });
      return;
    case 'applied':
      writeOutcome(record, { tag: 'pending', waiting: 1, applied: outcome.applied });
      return;
    case 'folded':
    case 'dropped':
      writeOutcome(record, { tag: 'pending', waiting: 1, applied: [] });
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

// One more write of a gesture the step is already waiting on, or has just
// settled (sendRequests, a later request). A record no step reads — a preview's,
// dropped — stays dropped: it takes no answers.
function oweAnother(record: EditsRecord): void {
  const outcome = record.outcome;
  switch (outcome.tag) {
    case 'pending':
      writeOutcome(record, { ...outcome, waiting: outcome.waiting + 1 });
      return;
    case 'applied':
      writeOutcome(record, { tag: 'pending', waiting: 1, applied: outcome.applied });
      return;
    case 'folded':
    case 'dropped':
      return;
    default: {
      const exhaustive: never = outcome;
      return exhaustive;
    }
  }
}

/** The reference main needs for a node of the origin, or undefined when the
 * node is not one main can name in the page's own bytes: not in this parse,
 * inside a chunk file, or without a source range. */
export function nodeRefIn(origin: PageOrigin, nodeId: string): NodeRef | undefined {
  const pending: { readonly node: PageNode; readonly path: readonly number[] }[] = [];
  origin.model.nodes.forEach((node, index) => pending.push({ node, path: [index] }));
  // Preorder over at most the tree's own bound.
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'The origin stays inside the tree bound');
    const entry = pending[visited];
    assert(entry !== undefined, 'The visit index lies inside the pending list');
    const node = entry.node;
    if (node.kind === 'chunk-group') {
      continue; // Its children live in another file, with other offsets.
    }
    if (node.id === nodeId) {
      if (node.start === undefined || node.end === undefined) {
        return undefined;
      }
      return { path: entry.path, kind: node.kind, span: { start: node.start, end: node.end } };
    }
    if ('children' in node && Array.isArray(node.children)) {
      const children: readonly PageNode[] = node.children;
      children.forEach((child, index) =>
        pending.push({ node: child, path: [...entry.path, index] }),
      );
    }
  }
  return undefined;
}

/** How sending one gesture ended. */
export type GestureSent =
  /** Every request applied; the replies, in order. */
  | { readonly tag: 'applied'; readonly replies: readonly PageEdited[] }
  /** Refused: the page is not what the gesture was stated against, or a
   * request has no form the engine can plan (plan §7: the notice says why).
   * `replies` are those applied before it. */
  | {
      readonly tag: 'refused';
      readonly reason: RejectionReason;
      readonly diskChecksum: Digest;
      readonly replies: readonly PageEdited[];
    }
  /** Not sent now: nothing applied, safe to send again. */
  | { readonly tag: 'retry'; readonly message: string }
  /** Some requests may have landed (a write race, an uncertain write) or
   * applied before a transient failure: sending again could apply twice, so
   * the page asks the user (reload or review). */
  | {
      readonly tag: 'uncertain';
      readonly message: string;
      readonly replies: readonly PageEdited[];
    };

/** State a gesture against `origin` and send its requests one at a time, in
 * order, each authored against the origin's checksum: main rebases the later
 * ones through the earlier ones' commits exactly. */
interface GestureSendInput {
  readonly path: string;
  readonly origin: PageOrigin;
  readonly gesture: EditGesture;
  readonly record: EditsRecord;
  readonly send: (request: EditRequest) => Promise<Result<PageEdited, PageEditError>>;
}

export async function sendGesture(input: GestureSendInput): Promise<GestureSent> {
  const { origin } = input;
  const refOf = (nodeId: string): NodeRef | undefined => nodeRefIn(origin, nodeId);
  const specialized = input.gesture.request(refOf);
  if (specialized === undefined || specialized.length === 0) {
    return sendReplacement(input, refOf);
  }
  const sent = await sendRequests(input, specialized);
  if (sent.tag !== 'refused' || sent.reason !== 'unsupported-operation') {
    return sent;
  }
  if (sent.replies.length > 0 || specialized.every((edit) => edit.tag === 'replace-node')) {
    return sent;
  }
  return sendReplacement(input, refOf);
}

async function sendReplacement(
  input: GestureSendInput,
  refOf: (nodeId: string) => NodeRef | undefined,
): Promise<GestureSent> {
  const predicted = input.gesture.apply(input.origin.model);
  const replacements = replacementEdits(input.origin, predicted, refOf);
  if (replacements !== undefined && replacements.length > 0) {
    const sent = await sendRequests(input, replacements);
    if (sent.tag !== 'refused' || sent.reason !== 'unsupported-operation') {
      return sent;
    }
    if (sent.replies.length > 0) {
      return sent;
    }
  }
  if (predicted === input.origin.model) {
    const reason = 'unsupported-operation';
    return { tag: 'refused', reason, diskChecksum: input.origin.checksum, replies: [] };
  }
  const page: Edit = { tag: 'replace-page', model: replacementModel(predicted) };
  return sendRequests(input, [page]);
}

async function sendRequests(
  input: GestureSendInput,
  requests: readonly Edit[],
): Promise<GestureSent> {
  const replies: PageEdited[] = [];
  for (const [index, edit] of requests.entries()) {
    if (index > 0) {
      // A later request of the same step: the step is owed its answer too, or
      // Undo would hold the inverse of the first write only.
      oweAnother(input.record);
    }
    const request = { pagePath: input.path, authoredChecksum: input.origin.checksum, edit };
    const answer = await input.send(request);
    if (answer.ok) {
      const { checksum, inverse } = answer.value;
      recordApplied(input.record, { checksum, inverse });
      replies.push(answer.value);
      continue;
    }
    return stopped(answer.error, input.origin.checksum, replies);
  }
  assert(replies.length === requests.length, 'Every request applied');
  return { tag: 'applied', replies };
}

/** The smallest stable changed nodes. A changed child suppresses its changed
 * parent, while a structural change (insert, remove, reorder, or move) selects
 * the parent whose child list changed. Main turns each replacement into hunks
 * inside that node, preserving every untouched byte around and within it. */
function replacementEdits(
  origin: PageOrigin,
  predicted: EditorModel,
  refOf: (nodeId: string) => NodeRef | undefined,
): readonly Edit[] | undefined {
  const afterById = nodesById(predicted.nodes);
  const pending: PageNode[] = [...origin.model.nodes];
  const edits: Edit[] = [];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A replacement search stays inside the tree bound');
    const before = pending[visited];
    assert(before !== undefined, 'A replacement search visits an existing node');
    const after = afterById.get(before.id);
    if (after !== undefined && before !== after && !hasChangedDirectChild(before, after)) {
      const target = refOf(before.id);
      if (target === undefined) {
        return undefined;
      }
      edits.push({ tag: 'replace-node', target, node: withoutStaleAttributeSpans(after) });
    }
    pending.push(...childNodes(before));
  }
  assert(edits.length <= LIMITS.treeNodesMax, 'A replacement search yields at most one per node');
  return edits;
}

function replacementModel(model: EditorModel): PageModel {
  return { ...model, nodes: model.nodes.map((node) => replacementNode(node, 0)) };
}

function replacementNode(node: PageNode, depth: number): PageNode {
  assert(depth <= LIMITS.treeDepthMax, 'A replacement model stays inside the tree depth bound');
  const replacement = withoutStaleAttributeSpans(node);
  switch (replacement.kind) {
    case 'component':
    case 'element':
      return replacement.children === undefined
        ? replacement
        : {
            ...replacement,
            children: replacement.children.map((child) => replacementNode(child, depth + 1)),
          };
    case 'map':
    case 'branch':
    case 'chunk-group':
      return {
        ...replacement,
        children: replacement.children.map((child) => replacementNode(child, depth + 1)),
      };
    case 'cond':
      return {
        ...replacement,
        children: replacement.children.map((branch) => {
          const child = replacementNode(branch, depth + 1);
          assert(child.kind === 'branch', 'A conditional keeps branch children');
          return child;
        }),
      };
    case 'comment':
    case 'expr':
    case 'raw':
    case 'raw-line':
    case 'text':
      return replacement;
    default: {
      const exhaustive: never = replacement;
      return exhaustive;
    }
  }
}

// Attribute spans describe the old bytes. A visual prop edit can add or remove
// names, so the replacement payload must not claim those old spans describe
// its new props; main only needs the target reference's source range.
function withoutStaleAttributeSpans(node: PageNode): PageNode {
  const { attrSpans: staleAttributeSpans, ...replacement } = node;
  void staleAttributeSpans;
  return replacement;
}

function nodesById(roots: readonly PageNode[]): ReadonlyMap<string, PageNode> {
  const found = new Map<string, PageNode>();
  const pending: PageNode[] = [...roots];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A node index stays inside the tree bound');
    const node = pending[visited];
    assert(node !== undefined, 'A node index visits an existing node');
    found.set(node.id, node);
    pending.push(...childNodes(node));
  }
  return found;
}

function hasChangedDirectChild(before: PageNode, after: PageNode): boolean {
  const beforeChildren = childNodes(before);
  const afterChildren = childNodes(after);
  const directAfter = new Map(afterChildren.map((child) => [child.id, child]));
  return beforeChildren.some((child) => {
    const next = directAfter.get(child.id);
    return next !== undefined && child !== next;
  });
}

function childNodes(node: PageNode): readonly PageNode[] {
  if ('children' in node && Array.isArray(node.children)) {
    const children: readonly PageNode[] = node.children;
    return children;
  }
  return [];
}

// A request did not apply: refused over changed bytes, or not written.
function stopped(
  error: PageEditError,
  authored: Digest,
  replies: readonly PageEdited[],
): GestureSent {
  const disk = replies[replies.length - 1]?.checksum ?? authored;
  switch (error.code) {
    case 'rejected':
      return {
        tag: 'refused',
        reason: error.reason,
        diskChecksum: error.diskChecksum ?? disk,
        replies,
      };
    case 'missing':
    case 'filesystem':
    case 'backpressured':
      // Refused before anything was written: safe to send again, when none of
      // the gesture's requests applied yet.
      return replies.length === 0
        ? { tag: 'retry', message: error.message }
        : { tag: 'uncertain', message: error.message, replies };
    case 'write-race':
    case 'uncertain':
      return { tag: 'uncertain', message: error.message, replies };
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
