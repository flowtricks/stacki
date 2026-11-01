import { useStableStyleValue } from './useStableStyleValue';
// What a control shows when nothing in the panel sets its property.
//
// The resolved model only knows what the project's CSS declares. A control whose
// property nobody declares still isn't showing nothing on the page: `pointer-events`
// may be `none` because a parent set it, `text-align` may be `center` from a `*` rule
// the panel's matcher can't see past a component edge, and `display` is whatever the
// user-agent stylesheet says for that tag. Guessing the CSS initial value gets all
// three wrong.
//
// So the page is asked, the same way colours are (see computedColor.ts): the canvas
// runs getComputedStyle on the selected element and hands back the values. Controls
// use it to highlight options and show inherited source metadata. It never claims
// that the selected selector owns the property; editing still uses the resolved model.

import { useEffect, useRef, useState } from 'react';
import { hasCanvas, onCanvasReady, queryCanvas } from '../../../editor/canvasQuery';
import { findNode, getHost, onHostChange } from './host';
import { createQueryCache } from './queryCache';
import { textStyleContext } from './styleQuery';

const AUTHORED_PREFIX = 'authored:';
const SOURCE_LABEL_PREFIX = 'source-label:';
const SOURCE_PATH_PREFIX = 'source-path:';
const PREFIXES = [AUTHORED_PREFIX, SOURCE_LABEL_PREFIX, SOURCE_PATH_PREFIX];
const cache = createQueryCache(async (path, keys) => {
  const expected = selectedTag();
  const propertyOf = (key: string) => {
    const prefix = PREFIXES.find((prefix) => key.startsWith(prefix));
    return prefix ? key.slice(prefix.length) : key;
  };
  const props = [...new Set(keys.map(propertyOf))];
  const answer = await queryCanvas(path, [], [], props, textStyleContext(path));
  const tag = answer?.identity?.tag;
  if (tag && expected && tag !== expected) {
    return undefined;
  }
  return Object.fromEntries(
    keys.map((key) => {
      const property = propertyOf(key);
      const source = answer?.inheritedSources?.[property];
      if (key.startsWith(SOURCE_LABEL_PREFIX)) {
        return [key, source?.label];
      }
      if (key.startsWith(SOURCE_PATH_PREFIX)) {
        return [key, source?.path];
      }
      const computed = answer?.computedProps[property];
      const value = key.startsWith(AUTHORED_PREFIX) ? answer?.authoredProps[property] || computed : computed;
      return [key, value?.trim()];
    }),
  );
});

function currentCache() {
  const host = getHost();
  cache.setScope([host.projectPath, host.openFilePath, host.nodes, host.selectedId, host.device, host.historyTick]);
  return cache;
}

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedStyles(): void {
  cache.clear();
}
// A new page's answers are not the old one's.
onCanvasReady(forgetComputedStyles);

function pathOfSelection(): string | undefined {
  const host = getHost();
  return host.selectedId ? host.pathOf?.(host.selectedId) : undefined;
}

// The selected node's HTML tag, when it has one. A component instance's name is its
// component ('Card'), which says nothing about the tag it renders, so only a plain
// lowercase name counts — those are the ones a rendered tag can be checked against.
function selectedTag(): string | undefined {
  const host = getHost();
  const node = host.selectedId ? findNode(host.nodes, host.selectedId) : undefined;
  if (node?.kind !== 'element') {
    return undefined;
  }
  const name = node.name ?? '';
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
}

/** An answer from the page: what it said, and whether it is still being asked. */
type Answer = { value: string; pending: boolean; path: string | undefined };

/**
 * What the page has already said about `prop`, read straight from the store.
 *
 * Read during render rather than kept in state. State is a render behind: the
 * moment a property is cleared, the control re-renders asking about a property
 * it was not asking about before, and a `pending` flag living in state still
 * says `false` for that first render — long enough to fall through to the
 * fallback and, worse, to record the fallback as "what was showing". The store
 * is the truth and it is synchronous, so it is read synchronously.
 */
function answeredNow(prop: string): Answer {
  if (!prop) {
    return { value: '', pending: false, path: undefined };
  }
  // `hasCanvas` is checked HERE, not once on mount: the panel can render before
  // the preview frame registers, and that first pass must not opt out for good.
  const path = hasCanvas() ? pathOfSelection() : undefined;
  // Nothing to ask — so nothing is pending either. No answer is ever coming, and
  // a control waiting forever would never show anything.
  if (!path) {
    return { value: '', pending: false, path: undefined };
  }
  const known = currentCache().read(path, prop);
  if (known.kind === 'pending') {
    return { value: '', pending: true, path };
  }
  return { value: known.answer ?? '', pending: false, path };
}

// `pending` is the part worth having. '' means two different things — "the page
// says nothing" and "the page has not been asked yet" — and a control that can't
// tell them apart has to guess during the wait. See useHighlight.
function useComputedAnswer(prop: string): Answer {
  const [, bump] = useState(0);

  useEffect(() => {
    if (!prop) {
      return undefined;
    }
    const sync = () => bump((count) => count + 1);
    const offCache = cache.subscribe(sync);
    // The selection moves, or the page re-renders under it: ask for the element
    // that's selected now.
    const off = onHostChange(sync);
    return () => {
      offCache();
      off();
    };
  }, [prop]);

  const answer = answeredNow(prop);
  // Asking is a side effect, so it waits until after the render that noticed the
  // answer was missing. `request` is idempotent — already answered, or already
  // queued for this flush, and it does nothing.
  useEffect(() => {
    if (answer.pending && answer.path) {
      void currentCache().request(answer.path, prop);
    }
  });

  const host = getHost();
  const value = useStableStyleValue(answer.value, { pending: answer.pending }, [host.projectPath, host.openFilePath, host.selectedId, answer.path, prop]);
  return { ...answer, value };
}

/**
 * The selected element's computed value for `prop` — '' until the page answers (or
 * forever, when there's no canvas to ask). Pass '' to skip asking entirely, so a
 * control that already has an authored value costs nothing.
 */
export function useComputedValue(prop: string): string {
  return useComputedAnswer(prop).value;
}

/** Preserve the winning declaration's units and variables in empty text fields.
 * Computed values remain the fallback for browser defaults and inaccessible CSS. */
export function useStyleHint(prop: string): string {
  return useComputedAnswer(prop ? `${AUTHORED_PREFIX}${prop}` : '').value;
}

/** Source metadata shares the value cache, so selection and history changes
 * invalidate hints and provenance together, including late replies. */
export function useInheritedSource(prop: string) {
  const label = useComputedAnswer(prop ? `${SOURCE_LABEL_PREFIX}${prop}` : '').value;
  const path = useComputedAnswer(prop ? `${SOURCE_PATH_PREFIX}${prop}` : '').value;
  return label ? { label, ...(path ? { path } : {}) } : undefined;
}

/**
 * The computed value for `prop`, but only when it's one of `values` — the options
 * this control can actually highlight. Anything else ('normal' for a justify-content
 * the page never sets, a resolved `14px` for a keyword control) returns '', leaving
 * the control's own default in charge.
 */
export function useComputedChoice(prop: string, values: readonly string[]): string {
  const computed = useComputedValue(prop).toLowerCase();
  return computed && values.includes(computed) ? computed : '';
}

/**
 * Which option a control should highlight: the authored value, else what the page
 * computes, else `fallback` — and, while the page is still being asked, whatever
 * was being highlighted a moment ago.
 *
 * That last clause is the whole point. Clearing a property drops the cached
 * computed values (an edit is exactly what changes them, see EmbedEditor), so the
 * control goes from "authored" straight to "asked, no answer yet" with a round
 * trip to the canvas in between. Filling that gap with `fallback` is a guess, and
 * a wrong one whenever the value came from somewhere else — an element inheriting
 * `pointer-events: none` from a parent would jump to Auto and then, a beat later,
 * slide back to None. The sliding pill made every wrong guess a visible move.
 *
 * Holding the previous highlight costs nothing when the guess would have been
 * right, and stops the control announcing an answer it doesn't have yet. It only
 * holds while an answer is actually coming: with no canvas to ask, `fallback` is
 * the best there is and it is used immediately.
 */
export function useHighlight(authored: string, prop: string, values: readonly string[], fallback: string): string {
  const answer = useComputedAnswer(authored || !prop ? '' : prop);
  const computed = answer.value.toLowerCase();
  const known = computed && values.includes(computed) ? computed : '';
  const settled = authored || known || (answer.pending ? '' : fallback);
  // Seeded with the fallback: on the very first render there is nothing else to
  // have been showing.
  const last = useRef(settled || fallback);
  const shown = settled || last.current;
  useEffect(() => {
    last.current = shown;
  }, [shown]);
  return shown;
}
