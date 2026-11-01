// A session's node handles, carried onto a fresh parse (plan §4, §11.9).
//
// The renderer keys everything it shows by node handle: the selection, hover,
// the navigator's rows, every panel field (issue #29: a field whose key changes
// mid-typing loses focus). Each parse of the page — a reply to the app's own
// edit, a watcher reload, typed code — is a new tree, so the handles of the
// tree it replaces are carried onto it, and only by the mapping every edit
// uses: never by position, never by likeness.
//
//   - The app's own edit: the reply's inverse hunks say exactly which bytes
//     changed. A node's span is mapped through those splices as the actor's
//     rebase maps anchors (shared/engine/rebase.ts): a change inside a node leaves
//     the same node, a change through its edges leaves none. Nodes the edit
//     itself created (an insertion, a move's new place) are the gesture's own
//     new nodes, paired in document order inside the edit's own replaced
//     ranges — nowhere else.
//   - Anything else (an outside edit, typed code, an edit merged with an
//     outside one): the span is mapped through the byte diff, which resolves
//     only what every minimum edit script keeps whole (shared/engine/mapSpan.ts) —
//     ambiguous or gone is a fresh handle, never a guess.
//
// A node nothing carries gets a fresh handle named by the snapshot it came
// from — its checksum and its path — so no counter is kept and two snapshots
// never mint the same one. Handles never reach main: requests name nodes by
// path, kind and range (src/editor/pageEdits.ts), and main checks those. Markdown and
// MDX pages are carried the same way: since step 10 every node of theirs has
// its source range too.
import { assert } from '../../shared/core/assert';
import { toNodeId, toUtf16Offset, type Digest } from '../../shared/core/brand';
import { DIFF_BUDGET, diffBytes } from '../../shared/engine/diff';
import type { SourceEdit } from '../../shared/engine/intent';
import { LIMITS } from '../../shared/core/limits';
import { mapSpanThroughDiff } from '../../shared/engine/mapSpan';
import type { PageModel, PageNode } from '../../shared/page/pageNode';
import type { Splice } from '../../shared/engine/planner';
import { rebaseSpan } from '../../shared/engine/rebase';
import { byteStringsEqual, encodeUtf8, toByteSpan, toByteString, utf16ToByteOffsets, type ByteSpan, type ByteString } from '../../shared/core/span';
import { applySplices, witnessesHold } from '../../shared/engine/splice';

/** A parse and the text it is a parse of: node ranges are UTF-16 offsets into it. */
export interface ParsedText {
  readonly source: string;
  readonly model: PageModel;
}

export interface CarryInput {
  /** The tree whose handles to keep: a parse of `before.source`, re-keyed. */
  readonly before: ParsedText;
  /** The fresh parse, and the 16 hex characters that name it for fresh
   * handles: its checksum's first 16 for bytes on disk (seedOf), random for a
   * parse of typed text, which no checksum names. */
  readonly after: ParsedText & { readonly seed: string };
  /** The app's own edit between the two, as the reply's inverse hunks (in the
   * bytes of `after`); undefined when `after` is not a reply to one. */
  readonly own: readonly SourceEdit[] | undefined;
  /** `before` with that edit's effect as the renderer predicted it; the
   * handles of the nodes the edit created are its. */
  readonly predicted: PageModel | undefined;
}

/** The seed of bytes on disk: their checksum's first 16 characters. */
export function seedOf(checksum: Digest): string {
  return checksum.slice(0, 16);
}

/** A seed for a parse no checksum names (typed text): random. */
export function randomSeed(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/** `after`'s model with the session's handles. */
export function carryHandles(input: CarryInput): PageModel {
  const beforeBytes = encodeUtf8(input.before.source);
  const afterBytes = encodeUtf8(input.after.source);
  const befores = entriesOf(input.before);
  const afters = entriesOf(input.after);
  const own = input.own;
  const splices = own === undefined ? undefined : ownSplices(own, beforeBytes, afterBytes);
  const map = spanMapper(beforeBytes, afterBytes, splices);
  const handles = new Map<string, string>(); // after path key → handle
  const used = new Set<string>();
  const assign = (entry: Entry, handle: string): void => {
    assert(!handles.has(entry.key), 'A node is given one handle');
    assert(!used.has(handle), 'A handle names one node');
    handles.set(entry.key, handle);
    used.add(handle);
  };
  carryMapped(befores, afters, { map, exact: splices !== undefined }, assign);
  if (input.own !== undefined && input.predicted !== undefined) {
    const created = createdRanges(input.own);
    pairCreated(afters, handles, used, created, input.predicted, assign);
  }
  assert(/^[0-9a-f]{16}$/.test(input.after.seed), 'A seed is 16 hex characters');
  for (const entry of afters) {
    if (!handles.has(entry.key)) {
      assign(entry, freshHandle(entry, input.after.seed, used));
    }
  }
  assert(handles.size === afters.length, 'Every node of the fresh parse has a handle');
  return rekeyed(input.after.model, handles);
}

// --- Internal ------------------------------------------------------------------

interface Entry {
  readonly node: PageNode;
  /** The node's path, joined: unique within one tree. */
  readonly key: string;
  /** Undefined inside a chunk group, whose ranges are another file's. */
  readonly span: ByteSpan | undefined;
}

type SpanMap = (span: ByteSpan) => ByteSpan | undefined;

/** Whose text a node's ranges index: this page's, or — inside a chunk group —
 * another file's, which no span of this page can reach. */
type RangeHome = 'page' | 'chunk';

interface Ordered {
  readonly node: PageNode;
  readonly key: string;
  readonly home: RangeHome;
}

// Every node in document order, with its byte span.
function entriesOf(parsed: ParsedText): readonly Entry[] {
  return withByteSpans(parsed.source, inOrder(parsed.model));
}

// Every node in document order. Iterative, bounded by the tree's node bound.
function inOrder(model: PageModel): readonly Ordered[] {
  const found: Ordered[] = [];
  const pending: Ordered[] = [];
  const push = (list: readonly PageNode[], prefix: string, home: RangeHome): void => {
    for (let index = list.length - 1; index >= 0; index--) {
      const node = list[index];
      assert(node !== undefined, 'A listed node exists');
      pending.push({ node, key: prefix === '' ? String(index) : `${prefix}.${index}`, home });
    }
  };
  push(model.nodes, '', 'page');
  while (pending.length > 0) {
    assert(found.length < LIMITS.treeNodesMax, 'A tree stays inside its node bound');
    const entry = pending.pop();
    assert(entry !== undefined, 'The pending stack is not empty');
    found.push(entry);
    const node = entry.node;
    if ('children' in node && Array.isArray(node.children)) {
      const home = node.kind === 'chunk-group' ? 'chunk' : entry.home;
      push(node.children, entry.key, home);
    }
  }
  return found;
}

// UTF-16 ranges to bytes in one ascending pass over the text.
function withByteSpans(source: string, found: readonly Ordered[]): readonly Entry[] {
  const offsets = new Set<number>();
  for (const { node, home } of found) {
    if (home === 'page' && node.start !== undefined && node.end !== undefined) {
      offsets.add(node.start);
      offsets.add(node.end);
    }
  }
  const ascending = [...offsets].sort((left, right) => left - right);
  const converted = utf16ToByteOffsets(source, ascending.map(toUtf16Offset));
  const bytes = new Map(ascending.map((offset, index) => [offset, converted[index]]));
  return found.map(({ node, key, home }) => {
    if (home === 'chunk' || node.start === undefined || node.end === undefined) {
      return { node, key, span: undefined };
    }
    const start = bytes.get(node.start);
    const end = bytes.get(node.end);
    assert(start !== undefined, 'Every start was converted');
    assert(end !== undefined, 'Every end was converted');
    return { node, key, span: toByteSpan(start, end) };
  });
}

// The app's own edit as splices of `before`, from the reply's inverse hunks
// (each names bytes of `after` and the text of `before` they replaced) —
// undefined when applying them to `before` does not give `after`: another
// writer's edit was merged into the reply, and only the diff can map.
function ownSplices(own: readonly SourceEdit[], before: ByteString, after: ByteString): readonly Splice[] | undefined {
  let delta = 0;
  const splices: Splice[] = [];
  for (const hunk of own) {
    const expectedBytes = encodeUtf8(hunk.text);
    const start = hunk.span.start - delta;
    if (start < 0 || hunk.span.end > after.length) {
      return undefined;
    }
    const range = toByteSpan(start, start + expectedBytes.length);
    const replacementBytes = toByteString(after.subarray(hunk.span.start, hunk.span.end));
    splices.push({ range, expectedBytes, replacementBytes });
    delta += replacementBytes.length - expectedBytes.length;
  }
  const inside = splices.every((splice) => splice.range.end <= before.length);
  if (!inside || !witnessesHold(before, splices)) {
    return undefined;
  }
  return byteStringsEqual(applySplices(before, splices), after) ? splices : undefined;
}

function spanMapper(before: ByteString, after: ByteString, splices: readonly Splice[] | undefined): SpanMap {
  if (splices !== undefined) {
    return (span) => rebaseSpan(span, splices);
  }
  const diff = diffBytes(before, after, DIFF_BUDGET);
  if (diff.tag === 'too-costly') {
    return () => undefined; // Nothing carried: every node gets a fresh handle.
  }
  return (span) => {
    if (span.start === span.end) {
      return undefined;
    }
    const mapped = mapSpanThroughDiff(diff.diff, span);
    return mapped.tag === 'resolved' ? mapped.span : undefined;
  };
}

// A node of `before` keeps its handle on the node of `after` its span maps to,
// of its kind — or, through the app's own splices, of any kind: renaming `div`
// to `Card` changes the kind of the node the user renamed. A node and a
// same-span first descendant tie, and a tie carries nothing.
function carryMapped(
  befores: readonly Entry[],
  afters: readonly Entry[],
  mapping: { readonly map: SpanMap; readonly exact: boolean },
  assign: (entry: Entry, handle: string) => void,
): void {
  const bySpan = new Map<string, Entry[]>();
  for (const entry of afters) {
    if (entry.span !== undefined) {
      const key = spanKey(entry.span);
      bySpan.set(key, [...(bySpan.get(key) ?? []), entry]);
    }
  }
  const taken = new Set<string>();
  for (const entry of befores) {
    const mapped = entry.span === undefined ? undefined : mapping.map(entry.span);
    const candidates = mapped === undefined ? [] : (bySpan.get(spanKey(mapped)) ?? []);
    const free = candidates.filter((candidate) => !taken.has(candidate.key));
    const kin = free.filter((candidate) => candidate.node.kind === entry.node.kind);
    const renamed = mapping.exact && kin.length === 0 && free.length === 1 ? free : [];
    const [target, ...others] = kin.length > 0 ? kin : renamed;
    if (target !== undefined && others.length === 0) {
      taken.add(target.key);
      assign(target, entry.node.id);
    }
  }
}

// Where the app's own edit wrote new bytes, in `after`'s coordinates.
function createdRanges(own: readonly SourceEdit[]): readonly ByteSpan[] {
  return own.map((hunk) => hunk.span).filter((span) => span.start < span.end);
}

// The nodes the edit created, paired with the gesture's own new nodes: in
// document order, of one kind, and only nodes wholly inside what the edit
// wrote. A node the gesture moved is new there too; its handle travels.
function pairCreated(
  afters: readonly Entry[],
  handles: ReadonlyMap<string, string>,
  used: ReadonlySet<string>,
  created: readonly ByteSpan[],
  predicted: PageModel,
  assign: (entry: Entry, handle: string) => void,
): void {
  const inside = (span: ByteSpan | undefined): boolean => span !== undefined && created.some((range) => range.start <= span.start && span.end <= range.end);
  const unpaired = afters.filter((entry) => !handles.has(entry.key) && inside(entry.span));
  // The predicted tree's ranges are stale (edits moved them): only its order
  // and its handles are read.
  const own = inOrder(predicted).filter((entry) => !used.has(entry.node.id));
  let next = 0;
  for (const entry of unpaired) {
    const kind = entry.node.kind;
    const at = own.findIndex((candidate, index) => index >= next && candidate.node.kind === kind);
    if (at === -1) {
      continue;
    }
    const match = own[at];
    assert(match !== undefined, 'A found index names an entry');
    next = at + 1;
    assign(entry, match.node.id);
  }
}

// A fresh handle: the snapshot's checksum and the node's path. The layout
// wrapper keeps the parser's well-known `layout`, which the app looks it up by.
function freshHandle(entry: Entry, seed: string, used: ReadonlySet<string>): string {
  if (entry.node.id === 'layout' && !used.has('layout')) {
    return 'layout';
  }
  const base = `s${seed}.${entry.key}`;
  let handle = base;
  // Two snapshots with one checksum are the same bytes; a handle carried from
  // the first is suffixed away rather than reused. Bounded by the tree.
  for (let suffix = 2; used.has(handle); suffix++) {
    assert(suffix <= LIMITS.treeNodesMax + 1, 'A free handle is found within the tree bound');
    handle = `${base}~${suffix}`;
  }
  return handle;
}

function spanKey(span: ByteSpan): string {
  return `${span.start}:${span.end}`;
}

// The model with every node's id replaced by its handle; everything else kept.
function rekeyed(model: PageModel, handles: ReadonlyMap<string, string>): PageModel {
  const visit = (list: readonly PageNode[], prefix: string, depth: number): PageNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'A tree stays inside its depth bound');
    return list.map((node, index) => {
      const key = prefix === '' ? String(index) : `${prefix}.${index}`;
      const handle = handles.get(key);
      assert(handle !== undefined, 'Every node has a handle');
      const children = 'children' in node && Array.isArray(node.children) ? { children: visit(node.children, key, depth + 1) } : {};
      return Object.assign({}, node, { id: toNodeId(handle) }, children);
    });
  };
  return { ...model, nodes: visit(model.nodes, '', 0) };
}
