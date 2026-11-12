// The Style panel's first-styles mode, for a project with nothing to write styles into.
//
// A person who has never written CSS opens a page, selects an element and drags a padding.
// Until now nothing happened: with no `<style>` block and no stylesheet the panel had no rule
// to change and no place to put a new one, and the message that said so was never drawn.
// Rather than ask them to know what a stylesheet is, the panel makes one: a `<style is:global>`
// block at the end of the page they are on, and a class on the element, in one undo step.
//
// This file holds only the decisions, as pure functions, so every case is a table in a test:
// which of four things to do (planFirstStyles), what to call a new class (autoClassName), and
// where a block may be written (styleBlockFileSupported). The panel and the two hosts (Desktop's
// gestures, Studio's source edits) do the writing.

import { assert } from '../../../../shared/core/assert';
import { indentUnitOf } from '../../../../shared/core/indent';

/** The name a first-styled element's class starts from. Literal, so a person reading their own
 *  file finds `.class` and knows it is the one to rename. */
export const AUTO_CLASS_BASE = 'class';

// `.class`, `.class-2`, `.class-3`, …: the names autoClassName makes. `-1` is never made, so
// `.class-1` is a person's own name and does not count.
const AUTO_CLASS_SELECTOR = /^\.class(?:-(?:[2-9]|[1-9]\d+))?$/;

// Page files a `<style>` block is valid in. Markdown and MDX are not: their body is prose, and
// Astro does not scope or hoist a `<style>` written there the way it does in a component.
const STYLE_BLOCK_FILE = /\.astro$/i;

/** Whether a file can hold a `<style is:global>` block the panel adds (`.astro` only). */
export function styleBlockFileSupported(filePath: string | undefined): boolean {
  return filePath !== undefined && STYLE_BLOCK_FILE.test(filePath);
}

/** Whether a selector is one this mode wrote: exactly `.class` or `.class-<n>`, n at least 2. */
export function isAutoClassSelector(selector: string): boolean {
  return AUTO_CLASS_SELECTOR.test(selector.trim());
}

/**
 * The first of `class`, `class-2`, `class-3`, … that is not taken. Several elements styled in
 * this mode must never share a rule by accident, so a second element does not get `.class`
 * again. Total: `taken` holds `taken.size` names, so one of the first `taken.size + 1`
 * candidates is free, and the loop is bounded by exactly that.
 */
export function autoClassName(taken: ReadonlySet<string>): string {
  const candidatesMax = taken.size + 1;
  let free: string | undefined = undefined;
  for (let ordinal = 1; ordinal <= candidatesMax && free === undefined; ordinal += 1) {
    const candidate = ordinal === 1 ? AUTO_CLASS_BASE : `${AUTO_CLASS_BASE}-${ordinal}`;
    free = taken.has(candidate) ? undefined : candidate;
  }
  // Pigeonhole: candidatesMax distinct names cannot all be inside a set of fewer.
  assert(free !== undefined, 'autoClassName: a free name exists among taken.size + 1 candidates');
  return free;
}

/** What the panel knows when an edit would create a new rule. */
export type FirstStylesInput = {
  /** The selector the new rule is for. */
  readonly selector: string;
  /** The selected element's tag, or undefined when the canvas has not said. */
  readonly tag: string | undefined;
  /** The classes the selected element carries. */
  readonly elementClasses: readonly string[];
  /** How many style sources the panel lists: stylesheets, global-style components, `<style>` blocks. */
  readonly sourceCount: number;
  /** Every selector of every rule in those sources. */
  readonly ruleSelectors: readonly string[];
  /** The class names already in use in the open file, and by this mode's rules. */
  readonly takenClasses: ReadonlySet<string>;
  /** The file the edit lands in. */
  readonly filePath: string | undefined;
};

/**
 * What an edit that needs a new rule does.
 *
 * - `normal`: the panel's own path (write into the sources it lists). Any project with a
 *   hand-written style is here, and nothing below touches it.
 * - `block`: no style source at all, and the selector already names the element (a class it
 *   carries): add the block, write the rule, add no class.
 * - `block-and-class`: no style source, and the element is the bare tag with no class, which
 *   a rule for would restyle every such tag: add the block and a new class on the element.
 * - `class`: the sources hold only rules this mode wrote, so a class-less element is still
 *   waiting for a class of its own: add the class, write its rule into the block that exists.
 * - `refused`: a block is needed but this file cannot hold one; the message says what to do.
 */
export type FirstStylesPlan =
  | { readonly kind: 'normal' }
  | { readonly kind: 'block' }
  | { readonly kind: 'block-and-class'; readonly className: string }
  | { readonly kind: 'class'; readonly className: string }
  | { readonly kind: 'refused'; readonly message: string };

export const UNSUPPORTED_FILE_MESSAGE = 'This page has no place for a style block. Add a stylesheet to the project, or style it from an .astro page.';

export function planFirstStyles(input: FirstStylesInput): FirstStylesPlan {
  const { selector, tag, elementClasses, sourceCount, ruleSelectors, takenClasses, filePath } = input;
  assert(sourceCount >= 0, 'planFirstStyles: a count of sources is not negative');
  assert(Number.isSafeInteger(sourceCount), 'planFirstStyles: a count of sources is an integer');
  // The bare tag of an element with no class: the panel's fallback pick, and a rule that would
  // restyle every such element on the page.
  const bareTag = tag !== undefined && selector === tag && elementClasses.length === 0;
  if (sourceCount === 0) {
    if (!styleBlockFileSupported(filePath)) {
      return { kind: 'refused', message: UNSUPPORTED_FILE_MESSAGE };
    }
    return bareTag ? { kind: 'block-and-class', className: autoClassName(takenClasses) } : { kind: 'block' };
  }
  // Sources exist. They are this mode's own only when they hold rules and every one is an
  // auto class: an empty block, or any hand-written selector, is a project this does not touch.
  const ownRulesOnly = ruleSelectors.length > 0 && ruleSelectors.every(isAutoClassSelector);
  if (ownRulesOnly && bareTag) {
    return { kind: 'class', className: autoClassName(takenClasses) };
  }
  return { kind: 'normal' };
}

/** How the file a block goes into writes: one level of indentation, and its line ending. */
export type FileLayout = { readonly unit: string; readonly eol: '\n' | '\r\n' };

/** The layout of a file's text: its indent unit (shared/core/indent.ts) and whether it ends lines with CRLF. */
export function fileLayoutOf(source: string): FileLayout {
  return { unit: indentUnitOf(source), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * The text between a new block's tags: `css`, the rule as the panel builds it (tab-indented,
 * lines ended by `\n`), set on lines of its own and indented one level inside the tag, in the
 * file's own indent unit and line ending, the way a hand-written `<style>` reads. A file that
 * indents with spaces gets spaces, so the block never sits in a different style from the lines
 * around it.
 */
export function styleBlockInner(css: string, layout: FileLayout): string {
  const lines = css.replace(/^\n+|\s+$/g, '').split('\n');
  assert(lines[0] !== undefined, 'styleBlockInner: a split always has a first line');
  assert(lines[0].length > 0, 'styleBlockInner: a block holds at least one rule line');
  assert(!css.includes('\r'), 'styleBlockInner: the panel builds CSS with \\n line ends');
  const indented = lines.map((line) => {
    if (line.length === 0) {
      return line;
    }
    const tabs = /^\t*/.exec(line)?.[0].length ?? 0;
    return `${layout.unit}${layout.unit.repeat(tabs)}${line.slice(tabs)}`;
  });
  return `${layout.eol}${indented.join(layout.eol)}${layout.eol}`;
}
