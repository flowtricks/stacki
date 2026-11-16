// Text a page prints from data (`{aiCallout1.body}`), editable on the canvas by
// writing the words back to the string literal they come from: in the page's own
// frontmatter, in a project module it imports, in a JSON file, or in the list a
// loop goes through, one item at a time.
//
// The tracing is src/editor/boundText.ts (pure). This module is the part that
// touches the canvas: one target per text whose source is a plain string, one
// "blocked" entry per text that is not (the double click then says why instead
// of staying silent), the edit that writes through the document or the host,
// and the toast that names what changed with an Undo.
//
// Texts are matched on the canvas by their words, so a loop gets one target per
// item and an item whose words another item repeats gets none: the frame could
// not tell which of the two a double click is on, and an edit is never guessed.

import type { CanvasBoundText, CanvasSourceNode, CanvasTextEdit } from '../../features/preview/canvasTextSource';
import { canvasTextTarget } from '../../features/preview/canvasTextSource';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { requestCanvasTextRefresh } from '../../features/preview/canvasTextRefresh';
import { CANVAS_TEXT_LIMIT } from '../../../shared/properties/canvasText';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import {
  BOUND_TEXT_LIMITS,
  boundLoopOf,
  expressionInLoops,
  parseBoundPath,
  resolveBoundList,
  resolveBoundText,
  rewriteBoundText,
  type BoundTextBlock,
  type BoundTextEnvironment,
  type BoundTextLoop,
  type BoundTextModule,
  type BoundTextSite,
} from '../../editor/boundText';
import { canvasTypedText } from '../../ui/canvasTextDraft';
import { reportActionToast } from '../../ui/errorNotices';

/** What the host gives the canvas to follow and write data modules: Desktop over IPC, Studio from its dev server. */
export interface BoundTextHost {
  /** The module `spec` names from `fromFile` (project relative), or undefined for a package or a missing file. */
  readonly readModule: (fromFile: string, spec: string) => Promise<BoundTextModule | undefined>;
  /** A project file's text as it is now (project relative), or undefined when it cannot be read. */
  readonly readFile: (file: string) => Promise<string | undefined>;
  /**
   * Replaces `before` with `after` in `file` as one undo step, only while the file still holds `before`.
   * Absent: the host cannot write beside the page, and a binding to another file is shown but not edited.
   */
  readonly writeModule?: (write: { readonly file: string; readonly before: string; readonly after: string }) => Promise<void>;
  /** The history's own Undo, for the toast beside a saved edit. */
  readonly undo?: () => Promise<void>;
}

/** The words this module raises, in the person's language. */
export interface BoundTextWords {
  readonly saved: (path: string, file: string) => string;
  readonly undo: string;
  readonly sourceChanged: string;
}

/** Candidate expressions read per page, and the targets all of them yield. */
const CANDIDATES_MAX = 200;
const TARGETS_MAX = 400;

interface Candidate {
  readonly node: CanvasSourceNode;
  readonly parent: CanvasSourceNode;
  readonly expression: string;
  readonly loops: readonly { readonly item: string; readonly list: string }[];
}

interface Resolved {
  readonly candidate: Candidate;
  /** The loop item's key suffix: `~2` or `~1~0`; empty outside a loop. */
  readonly suffix: string;
  /** What the source holds for this text, as a path: `cards[2].title`. */
  readonly path: string;
  readonly outcome: { readonly ok: true; readonly site: BoundTextSite } | { readonly ok: false; readonly block: BoundTextBlock };
}

export async function canvasBoundEdits(document: CanvasTextDocument, host: BoundTextHost, words: BoundTextWords): Promise<CanvasTextEdit[]> {
  // Every text of the page is traced against the same files: each is read once, not once per text.
  const reads = new Map<string, Promise<BoundTextModule | undefined>>();
  const environment: BoundTextEnvironment = {
    page: { file: document.file, text: document.source },
    readModule: (fromFile, spec) => {
      const key = `${fromFile}\u0000${spec}`;
      const known = reads.get(key) ?? host.readModule(fromFile, spec);
      reads.set(key, known);
      return known;
    },
  };
  const resolved: Resolved[] = [];
  for (const candidate of candidatesOf(document.source, document.nodes).slice(0, CANDIDATES_MAX)) {
    resolved.push(...(await resolveCandidate(environment, candidate, TARGETS_MAX - resolved.length)));
    if (resolved.length >= TARGETS_MAX) {
      break;
    }
  }
  const uses = new Map<string, number>();
  for (const entry of resolved) {
    if (entry.outcome.ok) {
      const key = siteKey(entry.outcome.site);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const edits: CanvasTextEdit[] = [];
  for (const entry of withoutRepeats(resolved)) {
    const edit = entry.outcome.ok ? sourceEdit(document, host, words, entry, entry.outcome.site, uses) : blockedEdit(document, entry, entry.outcome.block);
    if (edit !== undefined) {
      edits.push(edit);
    }
  }
  assert(edits.length <= TARGETS_MAX, 'Bound text stays within its target bound');
  return edits;
}

const NO_LOOPS: Candidate['loops'] = [];
const siteKey = (site: BoundTextSite): string => `${site.file}\u0000${site.start}`;

// Expression nodes that print one path, each with the loops around it. A text
// inside a loop whose head is code the walk cannot read is left alone.
function candidatesOf(source: string, nodes: readonly CanvasSourceNode[]): Candidate[] {
  const found: Candidate[] = [];
  const stack: { readonly node: CanvasSourceNode; readonly parent: CanvasSourceNode | undefined; readonly loops: Candidate['loops'] | undefined }[] = nodes
    .map((node) => ({ node, parent: undefined, loops: NO_LOOPS }))
    .reverse();
  for (let visited = 0; stack.length > 0 && visited < 20_000; visited++) {
    const entry = stack.pop();
    assert(entry !== undefined, 'The candidate walk has an entry');
    const { node, parent, loops } = entry;
    const own = node.kind === 'map' ? boundLoopOf(node.head ?? '') : undefined;
    const inside = loops === undefined || (node.kind === 'map' && own === undefined) ? undefined : own === undefined ? loops : [...loops, own];
    if (node.kind === 'expr' && loops !== undefined && parent !== undefined && (parent.kind === 'element' || parent.kind === 'component')) {
      const expression = node.start === undefined || node.end === undefined ? '' : source.slice(node.start + 1, node.end - 1).trim();
      if (parseBoundPath(expression) !== undefined) {
        found.push({ node, parent, expression, loops });
      }
    }
    for (const child of [...(node.children ?? [])].reverse()) {
      stack.push({ node: child, parent: node, loops: inside });
    }
  }
  return found;
}

async function resolveCandidate(environment: BoundTextEnvironment, candidate: Candidate, budget: number): Promise<Resolved[]> {
  const parsed = parseBoundPath(candidate.expression);
  const usesLoop = parsed !== undefined && candidate.loops.some((loop) => loop.item === parsed.root);
  if (candidate.loops.length > 0 && !usesLoop) {
    // The same words in every pass: the canvas could not say which copy was meant.
    return [refused(candidate, { reason: 'duplicate', file: '', detail: 'Every pass of the loop prints the same words.' })];
  }
  const combinations: BoundTextLoop[][] = [];
  const failures: { readonly block: BoundTextBlock | undefined }[] = [];
  await enumerate(environment, candidate.loops, [], combinations, Math.min(budget, BOUND_TEXT_LIMITS.itemsMax), failures);
  const results: Resolved[] = [];
  for (const combination of combinations) {
    const path = expressionInLoops(candidate.expression, combination);
    const suffix = combination.map((loop) => `~${loop.index}`).join('');
    results.push({ candidate, suffix, path, outcome: await resolveBoundText(environment, path) });
  }
  const editable = results.filter((entry) => entry.outcome.ok);
  const first = results.find((entry) => !entry.outcome.ok)?.outcome;
  // Every text that is not editable says why when it is double-clicked, one refusal per text however many items fail.
  const block = first !== undefined && !first.ok ? first.block : failures[0]?.block;
  return [...editable, ...(block === undefined || (editable.length > 0 && results.length === editable.length) ? [] : [refused(candidate, block)])];
}

function refused(candidate: Candidate, block: BoundTextBlock): Resolved {
  return { candidate, suffix: '', path: candidate.expression, outcome: { ok: false, block } };
}

// The index combinations of the loops around a text, outermost first, in the order the page renders them. A list that cannot be counted says why in `failure`.
async function enumerate(
  environment: BoundTextEnvironment,
  loops: Candidate['loops'],
  chosen: readonly BoundTextLoop[],
  into: BoundTextLoop[][],
  budget: number,
  failure: { readonly block: BoundTextBlock | undefined }[],
): Promise<void> {
  const depth = chosen.length;
  assert(depth <= LIMITS.treeDepthMax, 'Loops nest within the tree depth bound');
  const loop = loops[depth];
  if (loop === undefined) {
    into.push([...chosen]);
    return;
  }
  const counted = await resolveBoundList(environment, expressionInLoops(loop.list, chosen));
  if (!counted.ok) {
    failure.push({ block: counted.block });
    return;
  }
  for (let index = 0; index < counted.count && into.length < budget; index++) {
    await enumerate(environment, loops, [...chosen, { item: loop.item, list: loop.list, index }], into, budget, failure);
  }
}

// Items that spell the same words as another of the same text, within one candidate, are dropped: the canvas finds a text by its words. A text with some dropped is refused once, by name.
function withoutRepeats(resolved: readonly Resolved[]): Resolved[] {
  const counts = new Map<string, number>();
  const wordsKey = (entry: Resolved & { readonly outcome: { readonly ok: true; readonly site: BoundTextSite } }) =>
    `${entry.candidate.node.id ?? ''}\u0000${entry.outcome.site.value.trim()}`;
  for (const entry of resolved) {
    if (entry.outcome.ok && entry.suffix !== '') {
      const key = wordsKey({ ...entry, outcome: entry.outcome });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const kept: Resolved[] = [];
  const reported = new Set<string>();
  for (const entry of resolved) {
    if (!entry.outcome.ok || entry.suffix === '' || (counts.get(wordsKey({ ...entry, outcome: entry.outcome })) ?? 0) === 1) {
      kept.push(entry);
      continue;
    }
    const id = entry.candidate.node.id ?? '';
    if (!reported.has(id)) {
      reported.add(id);
      kept.push(refused(entry.candidate, { reason: 'duplicate', file: '', detail: 'Several items print the same words.' }));
    }
  }
  return kept;
}

function sourceEdit(
  document: CanvasTextDocument,
  host: BoundTextHost,
  words: BoundTextWords,
  entry: Resolved,
  site: BoundTextSite,
  uses: ReadonlyMap<string, number>,
): CanvasTextEdit | undefined {
  const { candidate } = entry;
  if (!site.value.trim() || site.value.length > CANVAS_TEXT_LIMIT) {
    return undefined;
  }
  const target = canvasTextTarget(candidate.node, candidate.parent, site.value, 'Edit source', document.pathFor);
  if (target === undefined) {
    return undefined;
  }
  const bound: CanvasBoundText = {
    kind: 'source',
    expression: entry.path,
    file: site.file === document.file ? '' : site.file,
    uses: uses.get(siteKey(site)) ?? 1,
  };
  const editable = site.file === document.file || host.writeModule !== undefined;
  return {
    target: { ...target, key: `${target.key}${entry.suffix}` },
    bound: editable ? bound : { kind: 'blocked', expression: entry.path, file: site.file, reason: 'unsupported' },
    apply: (value) => commitSource({ document, host, words, site, expression: entry.path, value: canvasTypedText(site.value, value) }),
  };
}

function blockedEdit(document: CanvasTextDocument, entry: Resolved, block: BoundTextBlock): CanvasTextEdit | undefined {
  const { candidate } = entry;
  const key = document.pathFor(candidate.node.id ?? '');
  const target = canvasTextTarget(candidate.node, candidate.parent, entry.path, 'Edit source', document.pathFor);
  if (key === undefined || target === undefined || entry.suffix !== '') {
    return undefined;
  }
  return {
    target: { ...target, value: '' },
    bound: { kind: 'blocked', expression: entry.path, file: block.file, reason: block.reason },
    apply: () => Promise.reject(new Error(block.detail)),
  };
}

interface Commit {
  readonly document: CanvasTextDocument;
  readonly host: BoundTextHost;
  readonly words: BoundTextWords;
  readonly site: BoundTextSite;
  readonly expression: string;
  readonly value: string;
}

// One undo step: the page's own history for the page's file, the host's write for another.
async function commitSource(commit: Commit): Promise<void> {
  const { document, host, words, site, value } = commit;
  if (value === site.value) {
    return; // The same words write nothing, so a look is never an edit.
  }
  if (site.file === document.file) {
    const next = rewriteBoundText(document.source, site, value);
    if (next === undefined) {
      throw new Error(words.sourceChanged);
    }
    await document.apply(next, site.start);
  } else {
    const write = host.writeModule;
    assert(write !== undefined, 'A text is edited in another file only when the host can write it');
    const before = await host.readFile(site.file);
    const after = before === undefined ? undefined : rewriteBoundText(before, site, value);
    if (before === undefined || after === undefined) {
      throw new Error(words.sourceChanged);
    }
    await write({ file: site.file, before, after });
    requestCanvasTextRefresh();
  }
  const undo = host.undo;
  reportActionToast(
    words.saved(commit.expression, site.file === document.file ? document.file : site.file),
    'success',
    undo === undefined ? [] : [{ label: words.undo, run: undo }],
  );
}

/** A prop's binding followed to its string: the words it prints, what the canvas says of it, and the write. */
export interface BoundPropText {
  readonly value: string;
  readonly bound: CanvasBoundText;
  readonly apply: (typed: string) => Promise<void>;
}

/** Follows a prop the page sets to `expression` to its string, or undefined when it does not lead to one a write could replace. */
export function boundPropReader(
  document: CanvasTextDocument,
  host: BoundTextHost,
  words: BoundTextWords,
): (expression: string) => Promise<BoundPropText | undefined> {
  const environment: BoundTextEnvironment = {
    page: { file: document.file, text: document.source },
    readModule: (fromFile, spec) => host.readModule(fromFile, spec),
  };
  return async (expression) => {
    const path = expression.trim().replace(/^\{\s*([\s\S]*?)\s*\}$/, '$1');
    const outcome = parseBoundPath(path) === undefined ? undefined : await resolveBoundText(environment, path);
    if (outcome === undefined || !outcome.ok || !outcome.site.value.trim() || outcome.site.value.length > CANVAS_TEXT_LIMIT) {
      return undefined;
    }
    const { site } = outcome;
    if (site.file !== document.file && host.writeModule === undefined) {
      return undefined;
    }
    return {
      value: site.value,
      bound: { kind: 'source', expression: path, file: site.file === document.file ? '' : site.file, uses: 1 },
      apply: (typed) => commitSource({ document, host, words, site, expression: path, value: canvasTypedText(site.value, typed) }),
    };
  };
}
