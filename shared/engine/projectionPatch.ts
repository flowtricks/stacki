// The candidate projection of a value splice, derived from the current one
// instead of reparsing the whole file (step-4 latency experiment). A full
// reparse and reprojection costs 120–644 ms p50 on the named large fixtures;
// a value edit changes no structure, so the only thing that moves is every
// byte offset at or after the edited value.
//
// The claim this module rests on: replacing the bytes of a quoted attribute
// value with other bytes from the host's table leaves the parser's tokenization
// unchanged. A host whose ancestors are all markup (element or component) uses
// MARKUP_VALUE_BYTES; one inside a condition or a loop (cond, branch, map, with
// markup between) uses EXPRESSION_VALUE_BYTES; any other ancestor is refused.
// Why, from electron/parse/astroParser.ts, first for markup:
//
//   - The tag and attribute scanners both take
//     a quoted value as `"[^"]*"` or `'[^']*'`, so any byte but the quote is
//     inert inside it. Quotes are refused in both values.
//   - Tag matching skips balanced attributes. Angle brackets remain refused
//     conservatively, so these edits use a full parse rather than this shortcut.
//   - The balanced attribute reader and
//     findMatchingFragmentClose react to `{` and `}`. Refused.
//   - The frontmatter fence and the line-ending sniff need a line break;
//     control bytes are refused. `>` is refused too: inert by the argument
//     above, but excluding it costs nothing and needs no argument.
//
// Inside an expression the markup is also read as JavaScript, by the scanners
// that find the expression's end and split it (findMatchingDelimiter,
// topLevelOps, topLevelStatements, the map recognizer), all built on
// skipStringOrComment. Revision B of step 4 extends the patch to these hosts,
// because refusing them put a full reparse on the keystroke p95. The scanners
// do not see markup as markup, so the value can sit in any of their modes, and
// it must be inert in every one:
//   - Code. The opening quote normally starts a string that ends at the
//     closing one, but a quote in earlier JSX text can close its own "string"
//     exactly there, leaving the value in code. Code reacts to brackets
//     `( ) [ ] { }`, `?`, `:`, `&` (topLevelOps), `;` (topLevelStatements),
//     `/` and `*` (comment openers), `<` before a letter, and `.map(`, which
//     needs `(`.
//   - A quoted string: ends at its quote or a line break; `\` skips a byte.
//   - A template literal: ends at a backtick; `\` skips a byte.
//   - A line comment: ends at a line break.
//   - A block comment: ends at `*/`.
// EXPRESSION_VALUE_BYTES is the markup table without `( ) [ ] ? : & ; / *`,
// which leaves none of those bytes. The neighbours of the value are its own
// quotes, so no pair (`//`, `*/`, `?.`) can form across its edges.
//
// Both the old and the new bytes must pass. This conservative table must stay
// valid even when scanner behavior changes; newly supported value syntax still
// takes the full parse path until the shortcut has a separate equivalence proof.
//
// A Markdown page is never patched: see hostContext.
//
// This is an argument, not a proof. The brute-force reference — a full reparse
// deep-equal to every patched projection — runs on every applied intent in the
// simulator and on the large fixtures (test/simulator/projectionPatch.test.ts).
import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import type { Splice } from './planner';
import type { ProjectedAttribute, ProjectedNode, Projection } from '../page/sourceProjection';
import { byteStringsEqual, toByteSpan, toByteString, type ByteSpan, type ByteString } from '../core/span';

type ValidProjection = Extract<Projection, { tag: 'valid' }>;

/** The projection of `bytes` with `splice` applied, or undefined when the
 * splice is not a value edit this module can prove structure-neutral — the
 * caller then reparses. `projection` must describe `bytes`. */
export function projectValueSplice(projection: Projection, bytes: ByteString, splice: Splice): Projection | undefined {
  assert(projection.byteLength === bytes.length, 'The projection describes these bytes');
  assert(splice.range.end <= bytes.length, 'The splice lies inside the bytes');
  const held = toByteString(bytes.subarray(splice.range.start, splice.range.end));
  assert(byteStringsEqual(held, splice.expectedBytes), 'The witness held: the caller checked');
  if (projection.tag !== 'valid') {
    return undefined;
  }
  const context = hostContext(projection, splice.range);
  if (context === 'refused') {
    return undefined;
  }
  if (!valueBytesNeutral(splice.expectedBytes, context)) {
    return undefined;
  }
  if (!valueBytesNeutral(splice.replacementBytes, context)) {
    return undefined;
  }
  if (splice.replacementBytes.length > LIMITS.attrCharsMax) {
    return undefined; // UTF-16 units never exceed bytes, so this bounds the parser's check.
  }
  const delta = splice.replacementBytes.length - splice.expectedBytes.length;
  const byteLength = bytes.length + delta;
  if (byteLength > LIMITS.sourceBytesMax) {
    return undefined;
  }
  // The parser bounds the text in UTF-16 units. The projection carries its
  // count, so only the two values are counted, never the file: walking 10 MB
  // twice was 45 ms of every edit on the largest fixture.
  const unitDelta = utf16Units(splice.replacementBytes) - utf16Units(splice.expectedBytes);
  const utf16Length = projection.utf16Length + unitDelta;
  assert(utf16Length <= byteLength, 'UTF-16 never takes more units than UTF-8 takes bytes');
  if (utf16Length > LIMITS.ipcFieldCharsMax) {
    return undefined;
  }
  const patched = shiftProjection(projection, splice.range, { bytes: delta, units: unitDelta });
  assert(patched.nodes.length === projection.nodes.length, 'A value edit keeps every node');
  assert(patched.byteLength === byteLength, 'The patch measures the spliced bytes');
  assert(patched.utf16Length === utf16Length, 'The patch counts the spliced units');
  return patched;
}

/** Where a value's host sits, which decides the bytes it may hold. */
export type HostContext = 'markup' | 'expression' | 'refused';

/** Bytes that are inert inside a quoted value in `context` (see the header):
 * printable ASCII except quotes, backtick, backslash, angle brackets and
 * braces, and any byte of a multi-byte UTF-8 sequence; inside an expression,
 * also none of `( ) [ ] ? : & ; / *`. */
export function valueBytesNeutral(bytes: ByteString, context: Exclude<HostContext, 'refused'>): boolean {
  assert(bytes.length <= LIMITS.sourceBytesMax, 'Checked bytes are inside the file bound');
  const table = context === 'markup' ? MARKUP_VALUE_BYTES : EXPRESSION_VALUE_BYTES;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    assert(byte !== undefined, 'The index lies inside the bytes');
    if (!table[byte]) {
      return false;
    }
  }
  return true;
}

/** The context of the host of the one string value at exactly `range`:
 * `refused` when no string value is there, or when an ancestor is neither
 * markup nor a condition or loop. */
export function hostContext(projection: Projection, range: ByteSpan): HostContext {
  if (projection.tag !== 'valid') {
    return 'refused';
  }
  // Markdown reads structure from text that is values here: a line typed as
  // `- ` makes a list, a blank line ends a JSX block. The argument above is
  // about the .astro parser only, so a Markdown page always reparses (step
  // 10). Its roots are blocks; one root answers for all.
  if (projection.nodes[0]?.list === 'blocks') {
    return 'refused';
  }
  const containing = projection.nodes.filter((node) => contains(node.span, range));
  const host = containing.at(-1);
  if (host === undefined) {
    return 'refused';
  }
  const values = host.attributes.filter((attribute) => isValueAt(attribute, range));
  if (values.length === 0) {
    return 'refused'; // Not a value edit: the caller reparses.
  }
  assert(values.length === 1, 'One attribute value occupies one range');
  assertOneChain(containing);
  if (!MARKUP_KINDS.has(host.kind)) {
    return 'refused'; // Only an element or a component carries an edited value.
  }
  if (containing.every((node) => MARKUP_KINDS.has(node.kind))) {
    return 'markup';
  }
  const known = (node: ProjectedNode): boolean => MARKUP_KINDS.has(node.kind) || EXPRESSION_KINDS.has(node.kind);
  return containing.every(known) ? 'expression' : 'refused';
}

// --- Internal ----------------------------------------------------------------

/** UTF-16 code units of valid UTF-8: one per lead byte, two for a 4-byte one. */
function utf16Units(bytes: ByteString): number {
  assert(bytes.length <= LIMITS.sourceBytesMax, 'Counted bytes are inside the file bound');
  let units = 0;
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index] ?? 0;
    if ((byte & 0xc0) === 0x80) {
      continue; // A continuation byte adds nothing.
    }
    units += byte >= 0xf0 ? 2 : 1;
  }
  assert(units <= bytes.length, 'UTF-16 never takes more units than UTF-8 takes bytes');
  return units;
}

const MARKUP_REFUSED_ASCII = '"\'`\\<>{}';
const EXPRESSION_REFUSED_ASCII = `${MARKUP_REFUSED_ASCII}()[]?:&;/*`;

const MARKUP_VALUE_BYTES = valueTable(MARKUP_REFUSED_ASCII);
const EXPRESSION_VALUE_BYTES = valueTable(EXPRESSION_REFUSED_ASCII);

function valueTable(refused: string): readonly boolean[] {
  return Array.from({ length: 256 }, (_, byte) => {
    if (byte >= 0x80) {
      return true; // A byte of a multi-byte UTF-8 sequence: no scanner reads one.
    }
    if (byte < 0x20) {
      return false;
    }
    if (byte === 0x7f) {
      return false;
    }
    return !refused.includes(String.fromCharCode(byte));
  });
}

const MARKUP_KINDS: ReadonlySet<ProjectedNode['kind']> = new Set(['element', 'component']);
const EXPRESSION_KINDS: ReadonlySet<ProjectedNode['kind']> = new Set(['cond', 'branch', 'map']);

// Preorder: every node containing a range is an ancestor of the next one.
function assertOneChain(containing: readonly ProjectedNode[]): void {
  assert(containing.length <= LIMITS.treeDepthMax + 1, 'The chain is inside the depth bound');
  for (let index = 1; index < containing.length; index++) {
    const parent = containing[index - 1];
    const child = containing[index];
    assert(parent !== undefined, 'The parent lies inside the chain');
    assert(child !== undefined, 'The child lies inside the chain');
    assert(isPrefix(parent.path, child.path), 'Nodes containing a range form one chain');
  }
}

function isValueAt(attribute: ProjectedAttribute, range: ByteSpan): boolean {
  if (attribute.type !== 'string') {
    return false;
  }
  const value = attribute.valueSpan;
  if (value === undefined) {
    return false;
  }
  return value.start === range.start && value.end === range.end;
}

function shiftProjection(projection: ValidProjection, range: ByteSpan, lengths: { readonly bytes: number; readonly units: number }): ValidProjection {
  const delta = lengths.bytes;
  const frontmatter = projection.frontmatter;
  if (frontmatter !== undefined) {
    assert(frontmatter.end <= range.start, 'The frontmatter lies before every attribute value');
  }
  assert(projection.nodes.length <= LIMITS.treeNodesMax, 'The projection is inside its bound');
  const nodes = projection.nodes.map((node) => {
    if (node.span.end < range.start) {
      return node; // Wholly before the edit: nothing in it moves, so it is shared.
    }
    return shiftNode(node, range, delta);
  });
  const byteLength = projection.byteLength + delta;
  const utf16Length = projection.utf16Length + lengths.units;
  return { tag: 'valid', byteLength, utf16Length, frontmatter, nodes };
}

function shiftNode(node: ProjectedNode, range: ByteSpan, delta: number): ProjectedNode {
  const span = shiftSpan(node.span, range, delta);
  const attributes = node.attributes.map((attribute) => ({
    ...attribute,
    span: shiftSpan(attribute.span, range, delta),
    nameSpan: shiftOptional(attribute.nameSpan, range, delta),
    valueSpan: shiftOptional(attribute.valueSpan, range, delta),
  }));
  assert(attributes.length === node.attributes.length, 'A value edit keeps every attribute');
  const grown = contains(node.span, range) ? delta : 0;
  assert(span.end - span.start === node.span.end - node.span.start + grown, 'Only hosts resize');
  return { ...node, span, attributes };
}

function shiftOptional(span: ByteSpan | undefined, range: ByteSpan, delta: number): ByteSpan | undefined {
  return span === undefined ? undefined : shiftSpan(span, range, delta);
}

// A start at or before the value start stays; an end before the value end
// stays; everything at or after the value end moves by delta. Nothing but the
// value itself starts or ends strictly inside the replaced range.
function shiftSpan(span: ByteSpan, range: ByteSpan, delta: number): ByteSpan {
  const start = span.start <= range.start ? span.start : span.start + delta;
  const end = span.end < range.end ? span.end : span.end + delta;
  if (span.start > range.start) {
    assert(span.start >= range.end, 'No span starts inside a replaced value');
  }
  if (span.end < range.end) {
    assert(span.end <= range.start, 'No span ends inside a replaced value');
  }
  return toByteSpan(start, end);
}

function contains(outer: ByteSpan, inner: ByteSpan): boolean {
  if (outer.start <= inner.start) {
    return inner.end <= outer.end;
  }
  return false;
}

function isPrefix(prefix: readonly number[], path: readonly number[]): boolean {
  if (prefix.length < path.length) {
    return prefix.every((step, index) => step === path[index]);
  }
  return false;
}
