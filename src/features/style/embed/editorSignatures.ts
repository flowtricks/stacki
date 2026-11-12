// When the style editor's inputs have changed: a signature of the sheets,
// the snapshot and the native model, the order selectors are styled in, and
// the throttle and polling intervals that read them (editorModel.ts).

import { type RuleModel } from '../model/cascade';
import { listMatchedSelectors, selectorKey, type MatchedSelector, type StyleContext } from '../model/resolved';
import { nativeSelectorChips } from '../model/nativeStyles';
import { canonicalCompound, compareSpecificity } from '../model/selectors';
import { getHost, walkNodes, type HostNode } from '../model/host';
import type { ElementSnapshot, NativeModel, ParsedRule, Specificity } from '../model/styleTypes';

// Re-read every embed no more than this often when just switching selection.
export const BG_REFRESH_THROTTLE_MS = 4000;

/** Which stylesheets the host is offering, as a comparable string: the files, the components
 *  with a global block, and the open file's own `<style>` blocks. A block that appears (the
 *  first styles of a page, or one inserted from the palette) is a new place for rules, so it
 *  must change this, or the panel would not look for them until its next poll. */
export function sheetSignature(): string {
  const host = getHost();
  return [...host.files, ...host.astroFiles].map((file) => file.path).join('|') + `#${styleBlockIds(host.nodes)}`;
}

// The ids of the `<style>` blocks of a node list. A signature is asked for on every host
// change, and the host swaps `nodes` only when the page model changes, so the answer is kept
// per list.
const styleBlockIdsOf = new WeakMap<readonly HostNode[], string>();
function styleBlockIds(nodes: readonly HostNode[]): string {
  const known = styleBlockIdsOf.get(nodes);
  if (known !== undefined) {
    return known;
  }
  const ids: string[] = [];
  walkNodes(nodes, (node) => {
    if (node.kind === 'raw' && node.name === 'style') {
      ids.push(node.id);
    }
  });
  const joined = ids.join(',');
  styleBlockIdsOf.set(nodes, joined);
  return joined;
}
// How often to poll the Designer for out-of-app edits (classes / attributes /
// native styles). The API has no change events, so we re-read on this cadence and
// apply only when a signature actually differs.
export const DESIGNER_SYNC_INTERVAL_MS = 1500;

/** The selectors currently in play, as one comparable string: what the canvas was
 *  last asked about. Values aren't in it — changing one doesn't change which rules
 *  target the element, so it doesn't warrant asking again. */
export const selectorKeyOf = (rules: ParsedRule[]): string => rules.map((rule) => rule.selectorText).join('\n');

// A fingerprint of the selected element's identity (tag + id + classes + attrs) —
// changes when a class or data attribute is added/removed in the Designer.
export function snapshotSignature(snap: ElementSnapshot): string {
  return JSON.stringify([snap.tag, snap.id, snap.classes, snap.attributes]);
}
// A fingerprint of the element's native Webflow class styles — changes when a
// style value is edited on a class (even without touching the element's classes).
export function nativeSignature(model: NativeModel | undefined): string {
  if (!model) {
    return '';
  }
  return model.styles
    .map(
      (style) =>
        `${style.className}:${[...style.propsByContext]
          .map(
            ([contextKey, props]) =>
              `${contextKey}{${[...props].map(([prop, declared]) => `${prop}=${declared.value}${declared.isVariable ? '~' : ''}`).join(';')}}`,
          )
          .join('|')}`,
    )
    .join('||');
}

// The selectors that carry styles for the element in a given context: embed
// selectors matching it there, plus native class-style selectors with values at
// the context's breakpoint. Sorted weakest → strongest. Shared by the chip picker
// and the on-context-switch auto-select.
// Depth of the applied class chain a selector's classes form a PREFIX of (1 = the
// base class `.test`, 2 = `.test.is-2`, …), or 0 when they aren't that prefix (a
// standalone/global class like `.is-2`). `classList` is the element's applied
// classes, primary first.
export function chainPrefixDepth(classes: string[], classList: string[]): number {
  const classCount = classes.length;
  if (!classCount || classCount > classList.length) {
    return 0;
  }
  const set = new Set(classes);
  if (set.size !== classCount) {
    return 0;
  }
  for (let i = 0; i < classCount; i += 1) {
    if (!set.has(classList[i] ?? '')) {
      return 0;
    }
  }
  return classCount;
}

// The chip display order: tag → base class (`.test`) → its pseudos (`.test:hover`,
// `.test:is(:hover,:focus)`) → the applied combo chain (`.test.is-2` → `.test.is-2.ready`
// + pseudos) → the element's remaining classes IN THE ORDER THEY'RE APPLIED →
// data attributes → complex/nested selectors (`body > .test`). Returns a
// comparable [category, depth, pseudo] tuple.
export function selectorOrder(text: string, classList: string[]): [number, number, number] {
  const canon = canonicalCompound(text);
  const classes = canon.tokens.filter((token) => token.startsWith('class:')).map((token) => token.slice('class:'.length));
  const hasTag = canon.tokens.some((token) => token.startsWith('tag:'));
  const hasAttr = canon.tokens.some((token) => token.startsWith('attr:'));
  const pseudo = text.includes(':') ? 1 : 0; // a pseudo variant sorts after its plain selector
  if (!canon.oneCompound) {
    return [4, 0, 0];
  } // complex / nested — last
  if (classes.length) {
    const depth = chainPrefixDepth(classes, classList);
    if (depth > 0) {
      return [1, depth, pseudo];
    } // element's own chain: base(1) → combos
    // Not a prefix chain of the applied classes. These all used to tie at 0 and
    // fall through to specificity, then alphabetical — so the chips came out in
    // an order the element knows nothing about. Rank them by where the class
    // actually sits in `class="…"` instead. A combo sorts by its last applied
    // class; a class that isn't on the element at all goes after them.
    let applied = -1;
    for (const cls of classes) {
      const at = classList.indexOf(cls);
      if (at > applied) {
        applied = at;
      }
    }
    return [2, applied === -1 ? classList.length : applied, pseudo];
  }
  if (hasAttr) {
    return [3, 0, pseudo];
  } // data attributes
  if (hasTag) {
    return [0, 0, 0];
  } // a tag that has styles — first
  return [4, 0, 0];
}

export function styledSelectorsFor(model: RuleModel | undefined, nativeModel: NativeModel | undefined, context: StyleContext): MatchedSelector[] {
  const byKey = new Map<string, MatchedSelector>();
  const add = (chip: MatchedSelector) => {
    if (!byKey.has(chip.key)) {
      byKey.set(chip.key, chip);
    }
  };
  if (model) {
    for (const matched of listMatchedSelectors(model, context.embedAtContext ?? ' native-only')) {
      add(matched);
    }
  }
  // Native class styles have no per-query context — only breakpoints. List them in
  // EVERY context (dimmed when the current one is a query they can't target — e.g. a
  // container query — or a breakpoint they aren't styled at). inContext holds only
  // when the context IS a breakpoint the selector is actually styled at.
  for (const ns of nativeSelectorChips(nativeModel, context.breakpoint ?? 'main')) {
    const key = selectorKey(ns.text);
    const inContext = context.breakpoint ? ns.inContext : false;
    const existing = byKey.get(key);
    if (existing) {
      if (inContext) {
        existing.inContext = true;
      }
      continue;
    }
    const specificity: Specificity = [0, ns.classDepth, 0];
    byKey.set(key, {
      text: ns.text,
      specificity,
      state: ns.state,
      simple: true,
      key,
      inContext,
      fromComponent: false,
    });
  }
  return [...byKey.values()].sort((left, right) => compareSpecificity(left.specificity, right.specificity) || left.text.localeCompare(right.text));
}
