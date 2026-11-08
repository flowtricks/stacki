// Classes a component instance hands an element of the component open on the
// canvas, and where a rule for one is written.
//
// Inside `ContentWrapper.astro`, `<div class:list={[column1Class]}>` holds no
// class text: the home page's `column1Class="hero_copy"` is what the canvas
// renders. That class is the page's, not the component's (every other instance
// passes its own, or none), so the selector well offers it as a chip of this
// instance, and a rule for it goes where that page's class rules live: the
// page's `<style is:global>`, else a stylesheet. Never the component file, where
// it would style every instance that ever passes the same name.

import { assert } from '../../../../shared/core/assert';
import { isGlobalRegion } from './projectResources';
import { selectorKey, selectorsMatch, type MatchedSelector } from './resolved';
import { canonicalCompound } from './selectorParse';
import { selectorSpecificity } from './selectors';
import type { StyleRegion } from './styleTypes';
import type { EmbedSource } from './webflow';

/**
 * At most this many instance classes become chips. A real element carries a
 * handful; the cap keeps a runaway `class:list` from flooding the well.
 */
export const INSTANCE_CLASSES_MAX = 32;

// Astro's `scopedStyleStrategy: 'class'` adds `astro-XXXXXXXX` to scoped markup.
// That is the compiler's hash, not a class anyone passed.
const ASTRO_SCOPE_CLASS = /^astro-[a-z0-9]+$/i;

/** A style source as this module reads it: its identity, where it lives, and its blocks. */
export type InstanceStyleDocument = {
  readonly source: Pick<EmbedSource, 'key' | 'origin'>;
  readonly regions: readonly StyleRegion[];
};

/**
 * The classes the element renders with that its own source does not name: what
 * the instance passed through a prop (`class:list={[column1Class]}`,
 * `class={className}`, `class:list={["x", className]}`). `rendered` is the
 * element's whole class list (authored first, then what the canvas reported);
 * `authored` is what the component's markup spells out.
 */
export function instanceClassesOf(element: { readonly authored: readonly string[]; readonly rendered: readonly string[] }): string[] {
  const authored = new Set(element.authored);
  const found: string[] = [];
  for (const name of element.rendered) {
    if (found.length < INSTANCE_CLASSES_MAX) {
      if (name.length > 0 && !authored.has(name) && !found.includes(name) && !ASTRO_SCOPE_CLASS.test(name)) {
        found.push(name);
      }
    } else {
      break;
    }
  }
  assert(found.length <= INSTANCE_CLASSES_MAX, 'instanceClassesOf: bounded by INSTANCE_CLASSES_MAX');
  assert(
    found.every((name) => !authored.has(name)),
    'instanceClassesOf: a class the component names is never the instance’s',
  );
  return found;
}

/**
 * Whether a selector is about an instance class: its subject compound names one
 * (`.hero_copy`, `.hero_copy:hover`, `.layout > .hero_copy::after`). Such a rule
 * styles this instance's element by the page's class, so it belongs to the page.
 */
export function namesInstanceClass(selector: string, instanceClasses: readonly string[]): boolean {
  if (selector.trim().length === 0) {
    return false;
  }
  if (instanceClasses.length === 0) {
    return false;
  }
  const tokens = canonicalCompound(selector).tokens;
  return instanceClasses.some((name) => tokens.includes(`class:${name}`));
}

/**
 * The chip list with the instance's classes in it. A chip already styling an
 * instance class is marked as the instance's; each instance class with no chip
 * of its own gets one, pending (no styles yet), so it can be picked to style.
 */
export function withInstanceChips(list: readonly MatchedSelector[], instanceClasses: readonly string[]): MatchedSelector[] {
  assert(instanceClasses.length <= INSTANCE_CLASSES_MAX, 'withInstanceChips: instance classes are capped');
  if (instanceClasses.length === 0) {
    return [...list];
  }
  const marked = list.map((chip) => (namesInstanceClass(chip.text, instanceClasses) ? { ...chip, fromInstance: true } : chip));
  const added: MatchedSelector[] = [];
  for (const name of instanceClasses) {
    const text = `.${name}`;
    if (!marked.some((chip) => selectorsMatch(chip.text, text))) {
      added.push({
        text,
        specificity: selectorSpecificity(text),
        state: '',
        simple: true,
        key: selectorKey(text),
        pending: true,
        inContext: true,
        fromComponent: false,
        fromInstance: true,
      });
    }
  }
  const out = [...marked, ...added];
  assert(out.length === list.length + added.length, 'withInstanceChips: every chip is kept');
  assert(added.length <= instanceClasses.length, 'withInstanceChips: at most one chip per instance class');
  return out;
}

/**
 * The block a new rule goes into in a source: its first parsed global block. A
 * component file's scoped blocks are not parsed (webflow.ts), and the page's
 * scoped block would hash the selector to the page's own markup, so a class
 * rule there would never reach the component's element. Falls back to the
 * first block when the source has no global one.
 */
export function writableRegion<Region extends StyleRegion>(regions: readonly Region[]): Region | undefined {
  const global = regions.find((region) => region.root !== undefined && isGlobalRegion(region));
  if (global !== undefined) {
    assert(isGlobalRegion(global), 'writableRegion: the chosen block is global');
    return global;
  }
  return regions[0];
}

/**
 * Where a rule for an instance class is written when none exists yet: the page
 * the instance sits on, when that page has a `<style is:global>`; else the first
 * stylesheet, which reaches every page. Undefined when neither is loaded, so the
 * source stays as it is.
 */
export function instanceStyleSource(documents: readonly InstanceStyleDocument[], contextPagePath: string | undefined): string | undefined {
  if (contextPagePath !== undefined) {
    const page = documents.find((document) => document.source.origin.kind === 'astro' && document.source.origin.path === contextPagePath);
    if (page !== undefined) {
      const region = writableRegion(page.regions);
      if (region !== undefined && region.root !== undefined && isGlobalRegion(region)) {
        return page.source.key;
      }
    }
  }
  const sheet = documents.find((document) => document.source.origin.kind === 'file');
  return sheet?.source.key;
}

/**
 * The source "Add custom styles in" points at for the active selector inside a
 * component opened from an instance: the file already holding the selector's
 * rule, else the instance's page (instanceStyleSource). Undefined when the
 * selector is not about an instance class, which leaves the component's own
 * source in place.
 */
export function instanceSourceKey(input: {
  readonly activeSelector: string;
  readonly instanceClasses: readonly string[];
  readonly documents: readonly InstanceStyleDocument[];
  readonly contextPagePath: string | undefined;
  readonly homeEmbedKey: string | undefined;
}): string | undefined {
  if (!namesInstanceClass(input.activeSelector, input.instanceClasses)) {
    return undefined;
  }
  const key = input.homeEmbedKey ?? instanceStyleSource(input.documents, input.contextPagePath);
  assert(key === undefined || key.length > 0, 'instanceSourceKey: a source key is never empty');
  return key;
}
