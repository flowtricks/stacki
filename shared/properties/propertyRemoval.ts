// What deleting a component prop will do, said before it is done: the
// Properties panel's confirmation reads it (docs/component-properties.md, "Deleting a prop"). Main plans
// the deletion against the files on disk and answers with this summary; the
// deletion itself is the ordinary `{ kind: 'remove' }` property batch, planned
// again when it is applied, so a file that changed in between is read afresh.
import { assert } from '../core/assert';
import { count, list, object, pathText } from '../core/boundary';
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

export interface PropertyRemovalPreview {
  readonly name: string;
  /** The component file, project-relative. */
  readonly component: string;
  readonly usages: readonly PropertyRemovalUsage[];
  readonly reviews: readonly PropertyRemovalReview[];
}

const REVIEW_KINDS = ['reads', 'spread'] as const satisfies readonly PropertyRemovalReviewKind[];

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
  })(input);
  return preview;
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
