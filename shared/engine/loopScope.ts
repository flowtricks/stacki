// Loop variables in the source bytes (plan §3.3): the two gestures that care
// which names a loop declares. A loop rename touches every reference below the
// loop — a multi-span intent — and a move out of a loop leaves references to
// the loop's item behind, which the move replaces with placeholder text, so an
// expression node becomes text (a kind-changing intent). The renderer's model
// version of both rules is src/editor/loopBindings.ts (renamedLoopVar,
// strippedBindings); this module reads the same things off the bytes, so the
// byte edit and the model edit agree, and the gesture parity suite holds them
// to each other on the corpus.
//
// Pure: projections and bytes in, spans out. Anything this cannot read with
// certainty — a loop head that is not `data.map((item, index) => …`, a
// condition whose test it cannot delimit — is `undefined`, and the caller
// refuses rather than guesses.
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import { ancestorsOf, byteOffsetsIn, startsWith, subtreeOf, tagNameEnd, textOf, whitespaceBefore, type ValidProjection } from './planSupport';
import type { StructuralPath } from '../page/ref';
import type { ProjectedNode } from '../page/sourceProjection';
import { toByteSpan, type ByteSpan, type ByteString } from '../core/span';

export interface LoopParameter {
  readonly name: string;
  readonly span: ByteSpan;
}

export interface LoopHead {
  /** The expression the loop maps over: `items` in `{items.map((item) => (`. */
  readonly data: ByteSpan;
  readonly parameters: readonly LoopParameter[];
  /** A statement body's code (`=> { const x = …; return (`), up to the markup. */
  readonly body: ByteSpan | undefined;
}

/** A replacement the planner splices: absolute byte span, new text. */
export interface SourceReplacement {
  readonly span: ByteSpan;
  readonly text: string;
}

/** What a dropped binding becomes (src/editor/loopBindings.ts, UNBOUND_TEXT). */
export const UNBOUND_TEXT = 'content';

// The renderer's form (src/editor/loopBindings.ts, MAP_HEAD_RE): parenthesized
// parameters, then an arrow to markup `(` or to a statement body `{`.
const IDENTIFIER = '[A-Za-z_$][\\w$]*';
const HEAD_RE = new RegExp(
  [
    '^\\{(\\s*)([\\s\\S]+?)', // `{` and the data expression
    `\\.map\\(\\s*\\(\\s*(${IDENTIFIER})`, // `.map((item`
    `\\s*(?:,\\s*(${IDENTIFIER})\\s*)?`, // `, index`
    '\\)\\s*=>\\s*([({])', // `) => (` or `) => {`
  ].join(''),
);
const TEST_RE = /^(\s*)([\s\S]*?)(\s*(?:&&|\?)\s*\(?\s*)$/;
const BRACES_RE = /\{([^{}]*)\}/g;

/** The head of a `map` node, or undefined when it is not the form above. */
export function loopHead(projection: ValidProjection, bytes: ByteString, node: ProjectedNode): LoopHead | undefined {
  assert(node.kind === 'map', 'Only a loop has a head');
  const text = textOf(bytes, node.span);
  const match = HEAD_RE.exec(text);
  if (match === null) {
    return undefined;
  }
  const lead = (match[1] ?? '').length;
  const data = match[2] ?? '';
  const dataStart = 1 + lead;
  const dataEnd = dataStart + data.trimEnd().length;
  const names = [match[3], match[4]].filter((name): name is string => name !== undefined);
  const positions = names.flatMap((name) => {
    const start = parameterAt(text, match[0], name);
    return [start, start + name.length];
  });
  const offsets = byteOffsetsIn(text, [dataStart, dataEnd, ...positions, match[0].length]);
  const at = (index: number): number => {
    const offset = offsets[index];
    assert(offset !== undefined, 'Every head offset was converted');
    return node.span.start + offset;
  };
  const parameters = names.map((name, index) => ({
    name,
    span: toByteSpan(at(2 + index * 2), at(3 + index * 2)),
  }));
  const headEnd = at(offsets.length - 1);
  const body = match[5] === '{' ? bodyRegion(projection, node, headEnd) : undefined;
  if (match[5] === '{') {
    if (body === undefined) {
      return undefined;
    }
  }
  return { data: toByteSpan(at(0), at(1)), parameters, body };
}

// The parameter's own position: after the `.map(` of the matched head, so a
// name that also occurs in the data expression is not taken for it.
function parameterAt(text: string, head: string, name: string): number {
  const mapAt = head.lastIndexOf('.map(');
  assert(mapAt >= 0, 'A matched head calls .map(');
  const found = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`).exec(text.slice(mapAt));
  assert(found !== null, 'A matched parameter occurs after .map(');
  return mapAt + found.index;
}

function bodyRegion(projection: ValidProjection, node: ProjectedNode, headEnd: number): ByteSpan | undefined {
  const [first] = childrenOf(projection, node);
  if (first === undefined) {
    return undefined;
  }
  return toByteSpan(headEnd, first.span.start);
}

/** The loop variables in scope at a node: every enclosing loop's parameters.
 * Undefined when an enclosing loop's head cannot be read. */
export function scopeAt(projection: ValidProjection, bytes: ByteString, path: StructuralPath): readonly string[] | undefined {
  const names: string[] = [];
  for (const ancestor of ancestorsOf(projection, path)) {
    if (ancestor.kind === 'map') {
      const head = loopHead(projection, bytes, ancestor);
      if (head === undefined) {
        return undefined;
      }
      names.push(...head.parameters.map((parameter) => parameter.name));
    }
  }
  return [...new Set(names)];
}

/** Every place a rename of the loop's parameter `from` must touch: the
 * declaration, then each reference below the loop, skipping loops that
 * declare the name again (they shadow it). The model rule is renamedLoopVar. */
export function renameSites(projection: ValidProjection, bytes: ByteString, loop: ProjectedNode, from: string): readonly ByteSpan[] | undefined {
  const head = loopHead(projection, bytes, loop);
  if (head === undefined) {
    return undefined;
  }
  const declared = head.parameters.filter((parameter) => parameter.name === from);
  if (declared.length !== 1) {
    return undefined;
  }
  const sites: ByteSpan[] = declared.map((parameter) => parameter.span);
  const shadowed: StructuralPath[] = [];
  for (const node of subtreeOf(projection, loop).slice(1)) {
    if (shadowed.some((path) => startsWith(node.path, path))) {
      continue;
    }
    const found = referencesIn(projection, bytes, node, from);
    if (found === undefined) {
      return undefined;
    }
    sites.push(...found.sites);
    if (found.shadows) {
      shadowed.push(node.path);
    }
  }
  const sorted = sites.sort((left, right) => left.start - right.start);
  assert(sorted.length <= LIMITS.treeNodesMax * 4, 'Rename sites are bounded by the tree');
  return sorted;
}

function referencesIn(
  projection: ValidProjection,
  bytes: ByteString,
  node: ProjectedNode,
  name: string,
): { readonly sites: readonly ByteSpan[]; readonly shadows: boolean } | undefined {
  const sites: ByteSpan[] = [];
  for (const attribute of node.attributes) {
    if (attribute.type === 'expr') {
      assert(attribute.valueSpan !== undefined, 'An expression attribute has a value span');
      sites.push(...identifierSpans(bytes, attribute.valueSpan, name));
    }
  }
  switch (node.kind) {
    case 'expr':
      sites.push(...identifierSpans(bytes, innerOf(node.span), name));
      return { sites, shadows: false };
    case 'text':
      sites.push(...braceSpans(bytes, node.span).flatMap((inner) => identifierSpans(bytes, inner, name)));
      return { sites, shadows: false };
    case 'cond': {
      const test = testRegion(projection, bytes, node);
      if (test === undefined) {
        return undefined;
      }
      sites.push(...identifierSpans(bytes, test, name));
      return { sites, shadows: false };
    }
    case 'map': {
      const head = loopHead(projection, bytes, node);
      if (head === undefined) {
        return undefined;
      }
      sites.push(...identifierSpans(bytes, head.data, name));
      const shadows = head.parameters.some((parameter) => parameter.name === name);
      if (!shadows) {
        if (head.body !== undefined) {
          sites.push(...identifierSpans(bytes, head.body, name));
        }
      }
      return { sites, shadows };
    }
    case 'component':
    case 'element':
    case 'raw':
    case 'raw-line':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return { sites, shadows: false };
    default: {
      const exhaustive: never = node.kind;
      return exhaustive;
    }
  }
}

/** The edits that keep a subtree valid once it leaves the loops declaring
 * `lost`: the byte form of strippedBindings. Undefined when a reading of a
 * lost name sits somewhere this cannot rewrite (a statement body, a head or a
 * test it cannot delimit). */
export function stripEdits(
  projection: ValidProjection,
  bytes: ByteString,
  root: ProjectedNode,
  lost: readonly string[],
): readonly SourceReplacement[] | undefined {
  const edits: SourceReplacement[] = [];
  // Loops below the root narrow the active names for their own subtrees.
  const narrowed: { readonly path: StructuralPath; readonly active: readonly string[] }[] = [];
  for (const node of subtreeOf(projection, root)) {
    const scope = narrowed.filter((entry) => startsWith(node.path, entry.path) && node.path.length > entry.path.length);
    const innermost = scope[scope.length - 1];
    const active = innermost === undefined ? lost : innermost.active;
    if (active.length === 0) {
      continue;
    }
    const found = stripNode(projection, bytes, node, active);
    if (found === undefined) {
      return undefined;
    }
    edits.push(...found.edits);
    if (found.remaining !== undefined) {
      narrowed.push({ path: node.path, active: found.remaining });
    }
  }
  return edits.sort((left, right) => left.span.start - right.span.start);
}

function stripNode(
  projection: ValidProjection,
  bytes: ByteString,
  node: ProjectedNode,
  active: readonly string[],
):
  | {
      readonly edits: readonly SourceReplacement[];
      readonly remaining: readonly string[] | undefined;
    }
  | undefined {
  const edits: SourceReplacement[] = [];
  for (const attribute of node.attributes) {
    if (attribute.type === 'expr') {
      assert(attribute.valueSpan !== undefined, 'An expression attribute has a value span');
      if (readsAny(textOf(bytes, attribute.valueSpan), active)) {
        const start = whitespaceBefore(bytes, attribute.span.start, tagNameEnd(bytes, node));
        edits.push({ span: toByteSpan(start, attribute.span.end), text: '' });
      }
    }
  }
  switch (node.kind) {
    case 'expr':
      if (readsAny(textOf(bytes, innerOf(node.span)), active)) {
        edits.push({ span: node.span, text: UNBOUND_TEXT });
      }
      return { edits, remaining: undefined };
    case 'text':
      for (const inner of braceSpans(bytes, node.span)) {
        if (readsAny(textOf(bytes, inner), active)) {
          edits.push({ span: toByteSpan(inner.start - 1, inner.end + 1), text: UNBOUND_TEXT });
        }
      }
      return { edits, remaining: undefined };
    case 'map':
      return stripLoop(projection, bytes, node, active, edits);
    case 'cond': {
      const test = testRegion(projection, bytes, node);
      if (test === undefined) {
        return undefined;
      }
      if (readsAny(textOf(bytes, test), active)) {
        edits.push({ span: test, text: 'false' });
      }
      return { edits, remaining: undefined };
    }
    case 'component':
    case 'element':
    case 'raw':
    case 'raw-line':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return { edits, remaining: undefined };
    default: {
      const exhaustive: never = node.kind;
      return exhaustive;
    }
  }
}

// A loop reading a lost name is pointed at an empty list: still valid code,
// renders nothing, keeps its markup. Its own parameters shadow lost names below.
function stripLoop(
  projection: ValidProjection,
  bytes: ByteString,
  node: ProjectedNode,
  active: readonly string[],
  edits: SourceReplacement[],
): { readonly edits: readonly SourceReplacement[]; readonly remaining: readonly string[] } | undefined {
  const head = loopHead(projection, bytes, node);
  if (head === undefined) {
    return undefined;
  }
  if (readsAny(textOf(bytes, head.data), active)) {
    edits.push({ span: head.data, text: '[]' });
  }
  const own = new Set(head.parameters.map((parameter) => parameter.name));
  const remaining = active.filter((name) => !own.has(name));
  if (head.body !== undefined) {
    if (readsAny(textOf(bytes, head.body), remaining)) {
      return undefined; // Declarations reading a lost name: the model rule rewrites them.
    }
  }
  return { edits, remaining };
}

// The test of `{test && (` or `{test ? (`: from after the brace to the first
// branch, without the operator.
function testRegion(projection: ValidProjection, bytes: ByteString, node: ProjectedNode): ByteSpan | undefined {
  const [first] = childrenOf(projection, node);
  if (first === undefined) {
    return undefined;
  }
  const region = toByteSpan(node.span.start + 1, first.span.start);
  const text = textOf(bytes, region);
  const match = TEST_RE.exec(text);
  if (match === null) {
    return undefined;
  }
  const lead = (match[1] ?? '').length;
  const test = match[2] ?? '';
  if (test.trim() === '') {
    return undefined;
  }
  const [start, end] = byteOffsetsIn(text, [lead, lead + test.length]);
  assert(start !== undefined, 'The test start was converted');
  assert(end !== undefined, 'The test end was converted');
  return toByteSpan(region.start + start, region.start + end);
}

function childrenOf(projection: ValidProjection, node: ProjectedNode): readonly ProjectedNode[] {
  return projection.nodes.filter((candidate) => candidate.path.length === node.path.length + 1 && startsWith(candidate.path, node.path));
}

// `{…}` without its braces.
function innerOf(span: ByteSpan): ByteSpan {
  assert(span.end - span.start >= 2, 'An expression has its braces');
  return toByteSpan(span.start + 1, span.end - 1);
}

function braceSpans(bytes: ByteString, span: ByteSpan): readonly ByteSpan[] {
  const text = textOf(bytes, span);
  const found: number[] = [];
  for (const match of text.matchAll(BRACES_RE)) {
    const inner = match[1] ?? '';
    found.push(match.index + 1, match.index + 1 + inner.length);
  }
  const offsets = byteOffsetsIn(text, found);
  const spans: ByteSpan[] = [];
  for (let index = 0; index < offsets.length; index += 2) {
    const start = offsets[index];
    const end = offsets[index + 1];
    assert(start !== undefined, 'A brace start was converted');
    assert(end !== undefined, 'A brace end was converted');
    spans.push(toByteSpan(span.start + start, span.start + end));
  }
  return spans;
}

/** Whole-identifier occurrences of `name` in a code span: `service`, never the
 * `service` of `x.service` or of `services` (src/editor/loopBindings.ts). */
function identifierSpans(bytes: ByteString, span: ByteSpan, name: string): readonly ByteSpan[] {
  const text = textOf(bytes, span);
  const found: number[] = [];
  for (const match of text.matchAll(identifierPattern(name, 'g'))) {
    found.push(match.index, match.index + name.length);
  }
  const offsets = byteOffsetsIn(text, found);
  const spans: ByteSpan[] = [];
  for (let index = 0; index < offsets.length; index += 2) {
    const start = offsets[index];
    const end = offsets[index + 1];
    assert(start !== undefined, 'An identifier start was converted');
    assert(end !== undefined, 'An identifier end was converted');
    spans.push(toByteSpan(span.start + start, span.start + end));
  }
  return spans;
}

function readsAny(code: string, names: readonly string[]): boolean {
  return names.some((name) => identifierPattern(name, '').test(code));
}

function identifierPattern(name: string, flags: string): RegExp {
  return new RegExp(`(?<![.\\w$])${escape(name)}(?![\\w$])`, flags);
}

function escape(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
