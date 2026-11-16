// Where "Add custom styles in" points for a selector that has no rules yet.
//
// A selector with rules already has a home: the file that defines them (selectorHome.ts). A new
// selector, `p.new-class` typed into the panel with nothing styled, has none, and used to land in
// whichever stylesheet came first in page order. It now lands where a person writing the page
// would put it: in the open page's own `<style>` tag. A page with no `<style>` tag yet offers a
// virtual entry, "Create <style>", in that place: choosing it writes nothing, and the tag is made
// atomically by the first style written (one undo step), so a page that is only looked at never
// changes.
//
// The decision is pure: it reads facts about the sources as plain values and writes nothing.

import { assert } from '../../../../shared/core/assert';
import type { StyleTagScope } from '../../../../shared/properties/newStyleTag';

/** The value of the dropdown entry that stands for a `<style>` tag the open file does not have yet. */
export const CREATE_STYLE_TAG_KEY = '__create-style-tag__';

/** One `<style>` tag of the open file, as the decision reads it. */
export interface StyleTagFact {
  readonly key: string;
  readonly scope: StyleTagScope;
  /** `define:vars` tags are written by Astro from frontmatter values: they hold variables, not a page's rules. */
  readonly variables: 'defined' | 'none';
  /** Position in the file, from the top. */
  readonly order: number;
}

export interface DefaultTargetInput {
  /** The `<style>` tags of the open page or component, any order. */
  readonly tags: readonly StyleTagFact[];
  /** The scope the project gives a tag it creates: a tag of this scope is preferred. */
  readonly preferredScope: StyleTagScope;
  /** Whether the open file can hold a `<style>` tag (an `.astro` file) and the host can add one. */
  readonly fileCanHoldTag: 'yes' | 'no';
}

export type DefaultTarget =
  | { readonly kind: 'tag'; readonly key: string }
  | { readonly kind: 'create' }
  /** Nothing to point at: the file cannot hold a tag. The caller keeps what it had. */
  | { readonly kind: 'none' };

/**
 * The target for a selector with no rules anywhere. With `<style>` tags in the file: the first
 * that is not `define:vars`, preferring one of the scope the project creates (so a page with a
 * scoped tag first and a global one after gets the global one in a project that writes global
 * tags); when none has that scope, the first usable one; when every tag is `define:vars`, the
 * first of those. With no tag: the virtual "Create <style>" entry, if the file can hold one.
 */
export function defaultStyleTarget(input: DefaultTargetInput): DefaultTarget {
  const ordered = [...input.tags].sort((left, right) => left.order - right.order);
  assert(ordered.length === input.tags.length, 'defaultStyleTarget: sorting keeps every tag');
  const first = ordered[0];
  if (first === undefined) {
    return input.fileCanHoldTag === 'yes' ? { kind: 'create' } : { kind: 'none' };
  }
  const usable = ordered.filter((tag) => tag.variables === 'none');
  const matching = usable.find((tag) => tag.scope === input.preferredScope);
  const chosen = matching ?? usable[0] ?? first;
  return { kind: 'tag', key: chosen.key };
}

/** The source key of a default target, or undefined when there is none. */
export function defaultTargetKey(target: DefaultTarget): string | undefined {
  switch (target.kind) {
    case 'tag':
      return target.key;
    case 'create':
      return CREATE_STYLE_TAG_KEY;
    case 'none':
      return undefined;
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}

/** Whether a source key is the virtual "Create <style>" entry. */
export function isCreateStyleTagKey(key: string | undefined): boolean {
  return key === CREATE_STYLE_TAG_KEY;
}
