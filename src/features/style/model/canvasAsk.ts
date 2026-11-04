// Asking the rendered page which selectors match an element: the forms a
// selector can be asked in, and the answers turned into matches (webflow.ts).

import { assert } from '../../../../shared/core/assert';
import type { CanvasAnswer } from '../../../editor/canvasReply';
import { getHost } from './host';
import type { ParsedRule } from './styleTypes';
import type { MatchTarget } from './selectors';
import { hasCanvas, queryCanvas } from '../../../editor/canvasQuery';

// ───────────────────────── Asking the rendered page ─────────────────────────

// State pseudo-classes describe a moment, not an element: `.card:hover` only
// matches while the pointer is there, but the panel is asking "does this rule
// target this element", which it does whether or not it's hovered right now.
// Stripped before asking, and the answer stored under the original text.
// Longest name first, and `(?![\w-])` rather than `\b` to close the trap that
// `-` is a non-word character: `:focus\b` happily matches inside
// `:focus-visible`, leaving the nonsense selector `a-visible`.
// The names are plain letters and hyphens, so they join into an alternation unescaped; the list
// order is the alternation order.
export const STATE_PSEUDO_NAMES = [
  'focus-visible',
  'focus-within',
  'focus',
  'hover',
  'active',
  'visited',
  'target',
  'checked',
  'indeterminate',
  'default',
  'disabled',
  'enabled',
  'placeholder-shown',
  'autofill',
  'user-invalid',
  'user-valid',
  'read-only',
  'read-write',
  'open',
] as const;
export const STATE_PSEUDO_RE = new RegExp(`:(?:${STATE_PSEUDO_NAMES.join('|')})(?![\\w-])`, 'g');
export const PSEUDO_ELEMENT_NAMES = [
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'placeholder',
  'marker',
  'backdrop',
  'file-selector-button',
] as const;
export const PSEUDO_ELEMENT_RE = new RegExp(`::?(?:${PSEUDO_ELEMENT_NAMES.join('|')})(?![\\w-])|::(?:part|slotted)\\([^)]*\\)`, 'g');

export function askableForm(text: string): string | undefined {
  const bare = text.replace(PSEUDO_ELEMENT_RE, standIn).replace(STATE_PSEUDO_RE, standIn).trim();
  // What's left has to still be a selector: `:hover {}` on its own strips to
  // nothing, and `.a > :hover` to a dangling combinator.
  if (!bare || /[>+~]\s*$/.test(bare) || bare.startsWith('>')) {
    return undefined;
  }
  // Only stand-ins left (`:hover {}`, `::before {}` on their own): that asks
  // about every element, not this one.
  if (bare.replace(/[\s*>+~]/g, '') === '') {
    return undefined;
  }
  return bare;
}

// What a stripped pseudo leaves in its place: nothing inside a compound
// (`details:open` → `details`), and `*` where it was the whole compound, so
// `:open > .faq_summary` (from `:open > &` nested in `.faq_summary`) asks
// `* > .faq_summary` rather than the dangling `> .faq_summary`, which is no
// selector, and the rule was never shown for the element it styles.
function standIn(match: string, offset: number, whole: string): string {
  assert(whole.slice(offset, offset + match.length) === match, 'A stand-in replaces what it matched');
  const before = offset === 0 ? '' : (whole[offset - 1] ?? '');
  const after = whole[offset + match.length] ?? '';
  const startsCompound = before === '' || /[\s>+~(,]/.test(before);
  const endsCompound = after === '' || /[\s>+~),:]/.test(after);
  return startsCompound && endsCompound ? '*' : '';
}

/** The selectors worth asking the DOM about, mapped back to the rule texts
 *  that asked for them. */
export function askableSelectors(rules: ParsedRule[]): Map<string, string[]> {
  // One entry per distinct selector, mapped back to every text that asked for
  // it — `.a:hover` and `.a` ask the same question of the DOM.
  const askedFor = new Map<string, string[]>();
  for (const rule of rules) {
    for (const selector of rule.selectors) {
      const ask = askableForm(selector.text);
      if (!ask) {
        continue;
      }
      const list = askedFor.get(ask);
      if (list) {
        list.push(selector.text);
      } else {
        askedFor.set(ask, [selector.text]);
      }
    }
  }
  return askedFor;
}

/** What the page said about one element: what it renders as, and which of the
 *  asked-for selectors target it. */
export type CanvasIdentity = {
  tag: string;
  id?: string | undefined;
  classes: string[];
  attributes: Record<string, string>;
};
/** One round trip's worth of answers. `unasked` means there was nothing to ask (no
 *  path for the node, or no canvas), which callers pass straight through so they
 *  don't ask again; an `asked` answer is undefined when the canvas didn't reply. */
export type CanvasAsk =
  | { readonly kind: 'unasked' }
  | {
      readonly kind: 'asked';
      readonly answer:
        | {
            readonly identity: CanvasIdentity | undefined;
            readonly matched: Readonly<Record<string, boolean>>;
          }
        | undefined;
      readonly askedFor: Map<string, string[]>;
    };

// The panel's identity of the element the canvas described. An element without
// an id carries no `id` key, as the page's own element does.
export function canvasIdentityOf(identity: CanvasAnswer['identity']): CanvasIdentity | undefined {
  if (identity === undefined) {
    return undefined;
  }
  const { id, ...rest } = identity;
  return id === undefined ? rest : { ...rest, id };
}

// Only a yes or a no is an answer; a selector the engine refused (absent) falls
// back to the source matcher.
export function matchedAnswers(matched: CanvasAnswer['matched']): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [selector, hit] of Object.entries(matched)) {
    if (typeof hit === 'boolean') {
      out[selector] = hit;
    }
  }
  return out;
}

/**
 * Ask the page everything the panel needs about the selected element, in ONE
 * round trip. Identity and selector matching used to be asked separately —
 * two questions about the same element at the same moment, each bounded by
 * its own 1.5s timeout, and the second couldn't start until the first came
 * back. The chips stayed blank for the sum of the two.
 *
 * Returns `unasked` when there's nothing to ask (no path for the node, or no
 * canvas), which callers pass straight through so they don't ask again.
 */
export async function askCanvasAbout(rootKey: string, rules: ParsedRule[]): Promise<CanvasAsk> {
  const path = getHost().pathOf?.(rootKey);
  if (!path || !hasCanvas()) {
    return { kind: 'unasked' };
  }
  const askedFor = askableSelectors(rules);
  const answer = await queryCanvas(path, [...askedFor.keys()]);
  return {
    kind: 'asked',
    answer:
      answer === undefined
        ? undefined
        : {
            identity: canvasIdentityOf(answer.identity),
            matched: matchedAnswers(answer.matched),
          },
    askedFor,
  };
}

/**
 * Fill `target.domMatched` from what the canvas said about these selectors.
 *
 * This is the whole point of the exercise: the rendered DOM knows what every
 * component renders, what every loop produced, and what classes a script or a
 * `class:list` expression put there — none of which the source tree can see.
 * Selectors the engine can't be asked about (or a canvas that doesn't answer)
 * are simply left out of the map, so they fall back to the source matcher.
 *
 * Pass `asked` (including `unasked`) to reuse an answer already in hand; omit it
 * and this asks on its own.
 */
export async function primeDomMatches(
  /** The match target to fill in place: the matcher reads it after this resolves. */
  target: MatchTarget,
  rules: ParsedRule[],
  asked?: CanvasAsk,
): Promise<void> {
  const ask = asked ?? (await askCanvasAbout(target.rootKey, rules));
  if (ask.kind === 'unasked') {
    return;
  }
  if (!ask.answer) {
    return;
  }
  const matched = new Map<string, boolean>();
  for (const [text, hit] of matchedTexts(ask)) {
    matched.set(text, hit);
  }
  // The target's identity is the cache key (EmbedEditor's primedRef compares it),
  // so its match cache is filled in place rather than copied.
  // eslint-disable-next-line no-param-reassign -- fills the matcher's cache slot by design
  target.domMatched = matched;
}

export function* matchedTexts(ask: Extract<CanvasAsk, { kind: 'asked' }>): Generator<[string, boolean]> {
  for (const [selector, texts] of ask.askedFor) {
    const hit = ask.answer?.matched[selector];
    if (typeof hit !== 'boolean') {
      continue;
    } // the engine refused it — fall back
    for (const text of texts) {
      yield [text, hit];
    }
  }
}
