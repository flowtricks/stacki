// What deleting a component prop will do, said before it is done: the
// Properties panel's confirmation reads it (docs/component-properties.md, "Deleting a prop"). Main plans
// the deletion against the files on disk and answers with this summary; the
// deletion itself is the ordinary `{ kind: 'remove' }` property batch, planned
// again when it is applied, so a file that changed in between is read afresh.
import { assert } from '../core/assert';
import { count, list, object, optional, pathText, text } from '../core/boundary';
import { propertyName } from './propertyEditing';

/** One file whose instances pass the prop, and how many attributes the deletion takes out of it. Paths are project-relative. */
export interface PropertyRemovalUsage {
  readonly path: string;
  readonly count: number;
}

/**
 * A place the deletion leaves for a person to look at, by 1-based line.
 * `reads`: the component's own code reads the prop; deleting it would break
 * that code, so the deletion is refused until it is gone. `spread`: an
 * instance spreads an object Stacki cannot see into (`{...props}`), which may
 * still carry the prop; the deletion goes ahead and the object keeps its key.
 */
export type PropertyRemovalReviewKind = 'reads' | 'spread';
export interface PropertyRemovalReview {
  readonly kind: PropertyRemovalReviewKind;
  readonly path: string;
  readonly line: number;
}

/** Where a kept constant's value comes from: the prop's default, `undefined` for an optional prop with none, or a required prop's zero value. */
export type PropertyKeptSource = 'default' | 'undefined' | 'zero';

/**
 * The component's own code read the prop's local, so the deletion keeps a
 * constant of that name holding `value` (`const direction = "forward"`), and
 * that code keeps working. `lines` are the reads, on disk.
 */
export interface PropertyKeptConstant {
  readonly value: string;
  readonly source: PropertyKeptSource;
  readonly lines: readonly number[];
}

export interface PropertyRemovalPreview {
  readonly name: string;
  /** The component file, project-relative. */
  readonly component: string;
  readonly usages: readonly PropertyRemovalUsage[];
  readonly reviews: readonly PropertyRemovalReview[];
  readonly kept?: PropertyKeptConstant | undefined;
}

const REVIEW_KINDS = ['reads', 'spread'] as const satisfies readonly PropertyRemovalReviewKind[];
const KEPT_SOURCES = ['default', 'undefined', 'zero'] as const satisfies readonly PropertyKeptSource[];

/** Whether the deletion is refused: the component's own code still reads the prop. */
export function removalBlocked(preview: PropertyRemovalPreview): boolean {
  return preview.reviews.some((review) => review.kind === 'reads');
}

/** How many attributes the deletion takes out, over every file. */
export function removalUsageCount(preview: PropertyRemovalPreview): number {
  const total = preview.usages.reduce((sum, usage) => sum + usage.count, 0);
  assert(Number.isSafeInteger(total), 'A removal counts a safe number of attributes');
  return total;
}

export function parsePropertyRemovalPreview(input: unknown): PropertyRemovalPreview {
  const preview = object({
    name: propertyName,
    component: pathText,
    usages: list(parseUsage),
    reviews: list(parseReview),
    kept: optional(parseKept),
  })(input);
  return preview;
}

function parseKept(input: unknown): PropertyKeptConstant {
  const kept = object({ value: text, source: keptSource, lines: list(line) })(input);
  if (kept.value.trim() === '') {
    throw new Error('Property removal: a kept constant has a value');
  }
  if (kept.lines.length === 0) {
    throw new Error('Property removal: a constant is kept only for code that reads the prop');
  }
  // Paired with line(): every read is a 1-based line on disk.
  assert(
    kept.lines.every((read) => read >= 1),
    'Property removal: a kept constant reads lines from 1',
  );
  return kept;
}

function keptSource(input: unknown): PropertyKeptSource {
  const source = KEPT_SOURCES.find((candidate) => candidate === input);
  if (source === undefined) {
    throw new Error('Property removal: unknown kept constant source');
  }
  assert(KEPT_SOURCES.includes(source), 'Property removal: a kept source is one of the known sources');
  return source;
}

function line(input: unknown): number {
  const value = count(input);
  if (value === 0) {
    throw new Error('Property removal: lines are 1-based');
  }
  assert(Number.isSafeInteger(value), 'Property removal: a line is a whole number');
  return value;
}

function parseUsage(input: unknown): PropertyRemovalUsage {
  const usage = object({ path: pathText, count })(input);
  if (usage.count === 0) {
    throw new Error('Property removal usage: a listed file passes the prop at least once');
  }
  return usage;
}

function parseReview(input: unknown): PropertyRemovalReview {
  const review = object({ kind: reviewKind, path: pathText, line: count })(input);
  if (review.line === 0) {
    throw new Error('Property removal review: lines are 1-based');
  }
  return review;
}

function reviewKind(input: unknown): PropertyRemovalReviewKind {
  const kind = REVIEW_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    throw new Error('Property removal review: unknown kind');
  }
  return kind;
}
