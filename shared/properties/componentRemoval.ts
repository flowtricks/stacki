// What deleting a component (or a folder of components) from the Components panel will do, said before it is done
// (docs/components.md, "Deleting a component"). Main plans the deletion against the files on disk and answers with
// this summary; the confirmation says it back. The deletion itself plans again from disk when it is applied, so a
// file that changed in between is read afresh, and it writes nothing when the plan lists anything to review.
//
// Why a review refuses the whole deletion: each kind is a use Stacki cannot rewrite safely (a dynamic import, a
// glob that matches the file, a re-export another file builds on, the component used as a value), and deleting the
// file under it would leave the site broken, which is the error this feature exists to prevent.
import { assert } from '../core/assert';
import { count, list, object, pathText, text } from '../core/boundary';

export const COMPONENT_REMOVAL_LIMITS = {
  /** Files a preview lists per section; a project with more is summarised by the counts. */
  previewFilesMax: 512,
  /** Places to review a preview lists; past this the deletion is refused anyway. */
  reviewsMax: 256,
} as const satisfies Record<string, number>;

/** One file the deletion edits, and how many instances or imports it takes out of it. Paths are project-relative with `/`. */
export interface ComponentRemovalFile {
  readonly path: string;
  readonly count: number;
}

/**
 * A use the deletion cannot rewrite, by 1-based line. `dynamic-import`: `import()` or `require()` of the file.
 * `glob`: an `import.meta.glob` or `Astro.glob` pattern that matches it. `re-export`: a re-export chain Stacki does not
 * follow (a barrel of a barrel, `export ... from` in an .astro file). `value`: the component used as a value (`{Div}`,
 * `components.Div`, `typeof Div`, a namespace tag). `expression`: an instance inside a `{...}` expression, where
 * taking the tag out would leave the code empty or broken. `content`: an instance in Markdown or MDX. `layout`: a
 * Markdown `layout:` that names it. `unreadable`: a file that names it but does not parse.
 */
export const COMPONENT_REMOVAL_REVIEW_KINDS = ['dynamic-import', 'glob', 're-export', 'value', 'expression', 'content', 'layout', 'unreadable'] as const;
export type ComponentRemovalReviewKind = (typeof COMPONENT_REMOVAL_REVIEW_KINDS)[number];

export interface ComponentRemovalReview {
  readonly kind: ComponentRemovalReviewKind;
  readonly path: string;
  readonly line: number;
}

export interface ComponentRemovalPreview {
  /** The component's or folder's display name. */
  readonly name: string;
  /** Component files the deletion moves to the Trash. */
  readonly files: number;
  /** Files whose instances are taken out (each instance with everything inside it, as Delete on the canvas does). */
  readonly instances: readonly ComponentRemovalFile[];
  /** Files whose import (or re-export) of the component is taken out. */
  readonly imports: readonly ComponentRemovalFile[];
  /** The `.stacki` settings files whose entries for it are cleaned. */
  readonly settings: readonly string[];
  /** Uses that block the deletion until a person changes them. */
  readonly reviews: readonly ComponentRemovalReview[];
}

/** Whether the deletion is refused: something uses the component in a way Stacki cannot rewrite. */
export function componentRemovalBlocked(preview: ComponentRemovalPreview): boolean {
  return preview.reviews.length > 0;
}

/** How many instances, or imports, the deletion takes out over every file. */
export function componentRemovalTotal(files: readonly ComponentRemovalFile[]): number {
  const total = files.reduce((sum, file) => sum + file.count, 0);
  assert(Number.isSafeInteger(total), 'A removal counts a safe number of places');
  return total;
}

/** The preview read at the boundary: every count, line and path checked, every list bounded. */
export function parseComponentRemovalPreview(input: unknown): ComponentRemovalPreview {
  const preview = object({
    name: text,
    files: count,
    instances: list(parseFile),
    imports: list(parseFile),
    settings: list(pathText),
    reviews: list(parseReview),
  })(input);
  if (preview.name.trim() === '') {
    throw new Error('Component removal: a preview names the component');
  }
  if (preview.files === 0) {
    throw new Error('Component removal: a deletion removes at least one file');
  }
  if (preview.instances.length > COMPONENT_REMOVAL_LIMITS.previewFilesMax) {
    throw new Error('Component removal: too many instance files');
  }
  if (preview.imports.length > COMPONENT_REMOVAL_LIMITS.previewFilesMax) {
    throw new Error('Component removal: too many import files');
  }
  if (preview.reviews.length > COMPONENT_REMOVAL_LIMITS.reviewsMax) {
    throw new Error('Component removal: too many places to review');
  }
  return preview;
}

function parseFile(input: unknown): ComponentRemovalFile {
  const file = object({ path: pathText, count })(input);
  if (file.count === 0) {
    throw new Error('Component removal: a listed file is edited at least once');
  }
  return file;
}

function parseReview(input: unknown): ComponentRemovalReview {
  const review = object({ kind: reviewKind, path: pathText, line: count })(input);
  if (review.line === 0) {
    throw new Error('Component removal review: lines are 1-based');
  }
  return review;
}

function reviewKind(input: unknown): ComponentRemovalReviewKind {
  const kind = COMPONENT_REMOVAL_REVIEW_KINDS.find((candidate) => candidate === input);
  if (kind === undefined) {
    throw new Error('Component removal review: unknown kind');
  }
  return kind;
}
