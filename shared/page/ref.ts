// A node reference: where a thing was in the bytes an edit was authored against
// (plan §4). The span says where, the structural path says which child of which
// parent, and the expected kind says what must be found there. Resolution
// happens at use time against current bytes; nothing here is an identity that
// survives between snapshots, and an ambiguous resolution is a rejection.
import { assert } from '../core/assert';
import type { Brand } from '../core/brand';
import { LIMITS } from '../core/limits';
import type { PageNode } from './pageNode';
import { toRecord, toArray } from '../core/record';
import { parseByteSpan, type ByteSpan } from '../core/span';

export const NODE_KINDS = ['component', 'element', 'raw', 'text', 'expr', 'raw-line', 'comment', 'map', 'cond', 'branch', 'chunk-group'] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

// The list above must name exactly the page tree's kinds: a kind added there
// without being added here fails to compile, not to anchor.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const nodeKindsMatchPageTree: Same<NodeKind, PageNode['kind']> = true;
assert(nodeKindsMatchPageTree, 'NODE_KINDS names every page-tree kind');

/** Regions an anchor may name besides a node: the frontmatter body, and the
 * whole file (code patches, program rewrites, reverts, a new frontmatter
 * block). */
export const ANCHOR_KINDS = [...NODE_KINDS, 'frontmatter', 'document'] as const;

export type AnchorKind = (typeof ANCHOR_KINDS)[number];

/** A 0-based child position within one parent (AGENTS.md §14). */
export type ChildIndex = Brand<number, 'ChildIndex'>;

/** Child indexes from the root list down to the node. Empty exactly for the
 * frontmatter and document anchors, which are not tree nodes. */
export type StructuralPath = readonly ChildIndex[];

export interface AnchorRef {
  readonly span: ByteSpan;
  readonly path: StructuralPath;
  readonly expectedKind: AnchorKind;
}

/** One step deeper than the deepest tree: the root list is step one. */
export const STRUCTURAL_PATH_STEPS_MAX = LIMITS.treeDepthMax + 1;

export function toChildIndex(value: number): ChildIndex {
  if (!Number.isSafeInteger(value)) {
    throw new Error('ChildIndex: expected safe integer');
  }
  if (value < 0) {
    throw new Error('ChildIndex: expected nonnegative integer');
  }
  if (value >= LIMITS.treeNodesMax) {
    throw new Error(`ChildIndex: exceeds ${LIMITS.treeNodesMax} siblings`);
  }
  return value as ChildIndex;
}

export function isNodeKind(kind: AnchorKind): kind is NodeKind {
  switch (kind) {
    case 'frontmatter':
    case 'document':
      return false;
    case 'component':
    case 'element':
    case 'raw':
    case 'text':
    case 'expr':
    case 'raw-line':
    case 'comment':
    case 'map':
    case 'cond':
    case 'branch':
    case 'chunk-group':
      return true;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The validated constructor: the path length and the kind must agree, and a
 * document anchor starts at the first byte. */
export function toAnchorRef(input: AnchorRef): AnchorRef {
  if (input.path.length > STRUCTURAL_PATH_STEPS_MAX) {
    throw new Error(`AnchorRef.path: exceeds ${STRUCTURAL_PATH_STEPS_MAX} steps`);
  }
  if (isNodeKind(input.expectedKind)) {
    if (input.path.length === 0) {
      throw new Error('AnchorRef.path: a node anchor needs at least one step');
    }
  } else if (input.path.length > 0) {
    throw new Error(`AnchorRef.path: a ${input.expectedKind} anchor has no path`);
  }
  if (input.expectedKind === 'document') {
    if (input.span.start !== 0) {
      throw new Error('AnchorRef.span: a document anchor starts at byte 0');
    }
  }
  return { span: input.span, path: [...input.path], expectedKind: input.expectedKind };
}

export function parseAnchorKind(input: unknown, where: string): AnchorKind {
  for (const kind of ANCHOR_KINDS) {
    if (kind === input) {
      return kind;
    }
  }
  throw new Error(`${where}: unknown anchor kind ${JSON.stringify(input)}`);
}

export function parseAnchorRef(input: unknown, where: string): AnchorRef {
  const record = toRecord(input);
  if (record === undefined) {
    throw new Error(`${where}: expected anchor object`);
  }
  const steps = toArray(record['path']);
  if (steps === undefined) {
    throw new Error(`${where}.path: expected array`);
  }
  if (steps.length > STRUCTURAL_PATH_STEPS_MAX) {
    throw new Error(`${where}.path: exceeds ${STRUCTURAL_PATH_STEPS_MAX} steps`);
  }
  const path = steps.map((step, index) => {
    if (typeof step !== 'number') {
      throw new Error(`${where}.path[${index}]: expected number`);
    }
    return toChildIndex(step);
  });
  return toAnchorRef({
    span: parseByteSpan(record['span'], `${where}.span`),
    path,
    expectedKind: parseAnchorKind(record['expectedKind'], `${where}.expectedKind`),
  });
}
