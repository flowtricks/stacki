// The shapes of Create component's "Move styles" choices, apart from the code that finds them
// (componentStyles.ts): the dialog shows them in Desktop and in Studio, and Studio does not carry the
// paste rule that decides them.

/** One place CSS is written: the page's own `<style>` tags, or a stylesheet by its project-relative path. */
export type StyleHome = { readonly kind: 'page' } | { readonly kind: 'stylesheet'; readonly rel: string };

/** Who else uses a class: nothing, another element of the page, or other files. */
export type ClassReach = { readonly kind: 'onlyHere' } | { readonly kind: 'page' } | { readonly kind: 'files'; readonly files: readonly string[] };

export interface MoveStyleCandidate {
  readonly name: string;
  /** Where its rules are, in the order the sources were given. */
  readonly homes: readonly StyleHome[];
  readonly reach: ClassReach;
  /** Offered checked: only this markup uses the class. */
  readonly checked: boolean;
}
