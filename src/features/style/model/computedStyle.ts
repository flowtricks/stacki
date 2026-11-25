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

import { useEffect, useMemo, useRef, useState } from 'react';
import { CASCADE_PROPERTIES_MAX, parseCascadeProperty, type CascadeProperty } from '../../../../shared/properties/cascadeOrigin';
import { hasCanvas, onCanvasReady, queryCanvas } from '../../../editor/canvasQuery';
import { assert } from '../../../../shared/core/assert';
import { findNode, getHost, onHostChange } from './host';
import { createQueryCache } from './queryCache';
import { textStyleContext } from './styleQuery';

const AUTHORED_PREFIX = 'authored:';
const SOURCE_LABEL_PREFIX = 'source-label:';
const SOURCE_PATH_PREFIX = 'source-path:';
const CASCADE_PREFIX = 'cascade:';
// The winning declaration as written, with no computed fallback: '' when no stylesheet the page can
// read sets the property (a browser default, an inaccessible sheet). Seeds the large value editor.
const DECLARED_PREFIX = 'declared:';
const PREFIXES = [AUTHORED_PREFIX, SOURCE_LABEL_PREFIX, SOURCE_PATH_PREFIX, CASCADE_PREFIX, DECLARED_PREFIX];
// Answers are kept per element, under a key naming the node as well as its rendered path
// (`nodeId NUL path`): the tag check and the text-node context belong to the node asked
// about, which is not always the one selected. The panel asks about the NEXT element while
// it still shows the current one (prefetchComputedStyles), so the switch paints the new
// element's values in the same frame as its header instead of blanks first.
const ELEMENT_KEY_SEPARATOR = '\u0000';
const cache = createQueryCache(async (elementKey, keys) => {
  const { nodeId, path } = parseElementKey(elementKey);
  const expected = tagOf(nodeId);
  const propertyOf = (key: string) => {
    const prefix = PREFIXES.find((prefix) => key.startsWith(prefix));
    return prefix ? key.slice(prefix.length) : key;
  };
  const props = [...new Set(keys.map(propertyOf))];
  const answer = await queryCanvas(path, [], [], props, textStyleContext(path, nodeId));
  const tag = answer?.identity?.tag;
  if (tag && expected && tag !== expected) {
    return undefined;
  }
  return Object.fromEntries(
    keys.map((key) => {
      const property = propertyOf(key);
      const source = answer?.inheritedSources?.[property];
      if (key.startsWith(CASCADE_PREFIX)) {
        const origin = answer?.authoredOrigins[property];
        return [key, origin === undefined ? undefined : JSON.stringify(origin)];
      }
      if (key.startsWith(SOURCE_LABEL_PREFIX)) {
        return [key, source?.label];
      }
      if (key.startsWith(SOURCE_PATH_PREFIX)) {
        return [key, source?.path];
      }
      if (key.startsWith(DECLARED_PREFIX)) {
        return [key, answer?.authoredProps[property]?.trim()];
      }
      const computed = answer?.computedProps[property];
      const value = key.startsWith(AUTHORED_PREFIX) ? answer?.authoredProps[property] || computed : computed;
      return [key, value?.trim()];
    }),
  );
});

// The selection is not part of the scope: answers are keyed by element, so the
// current element's answers survive a switch away and back, and the next element's
// prefetched answers survive the switch to it. Anything that changes what the page
// renders (another project, file, tree, device, or an undo) still drops them all.
function currentCache() {
  const host = getHost();
  cache.setScope([host.projectPath, host.openFilePath, host.nodes, host.device, host.historyTick]);
  return cache;
}

function elementKeyOf(nodeId: string, path: string): string {
  assert(nodeId.length > 0, 'elementKeyOf: a node id is never empty');
  assert(!nodeId.includes(ELEMENT_KEY_SEPARATOR), 'elementKeyOf: a node id holds no separator');
  return `${nodeId}${ELEMENT_KEY_SEPARATOR}${path}`;
}

function parseElementKey(elementKey: string): { readonly nodeId: string; readonly path: string } {
  const separator = elementKey.indexOf(ELEMENT_KEY_SEPARATOR);
  assert(separator > 0, 'parseElementKey: the key names a node');
  return { nodeId: elementKey.slice(0, separator), path: elementKey.slice(separator + 1) };
}

// Every key a control has asked for this session, so a prefetch asks the next element
// the same questions the panel's fields will. Bounded: the panel has a fixed set of
// controls, and a key past the cap is still answered, only not prefetched.
const LEARNED_KEYS_MAX = 512;
const learnedKeys = new Set<string>();

function learnKey(key: string): void {
  if (learnedKeys.size < LEARNED_KEYS_MAX) {
    learnedKeys.add(key);
  }
  assert(learnedKeys.size <= LEARNED_KEYS_MAX, 'learnKey: the learned keys are bounded');
}

/** Whether every learned key has an answer for `nodeId` under the current scope: a prefetch
 *  is lost when the scope moves on (an edit, an undo) before the element is shown. */
export function computedStylesSettled(nodeId: string): boolean {
  const path = hasCanvas() ? renderedPathOf(nodeId) : undefined;
  if (path === undefined || path.length === 0) {
    return true;
  }
  const elementKey = elementKeyOf(nodeId, path);
  const reading = currentCache();
  return [...learnedKeys].every((key) => reading.read(elementKey, key).kind === 'settled');
}

/**
 * Ask the page about `nodeId` before it is selected: every key a control has asked for,
 * in one batch. Resolves once each has an answer (or the page could not answer), so the
 * caller can show the element with its values settled. Without a canvas, or with no path
 * for the node, there is nothing to ask and it resolves at once.
 */
export async function prefetchComputedStyles(nodeId: string): Promise<void> {
  const path = hasCanvas() ? renderedPathOf(nodeId) : undefined;
  if (path === undefined || path.length === 0) {
    return;
  }
  const elementKey = elementKeyOf(nodeId, path);
  const asking = currentCache();
  await Promise.all([...learnedKeys].map((key) => asking.request(elementKey, key)));
}

/** Forget everything: the page changed under us, so the answers may have too. */
export function forgetComputedStyles(): void {
  cache.clear();
}
// A new page's answers are not the old one's.
onCanvasReady(forgetComputedStyles);

function selectionKey(): string | undefined {
  const nodeId = getHost().selectedId;
  if (nodeId === undefined || nodeId.length === 0) {
    return undefined;
  }
  const path = renderedPathOf(nodeId);
  return path ? elementKeyOf(nodeId, path) : undefined;
}

// The last rendered path seen for each node. While the canvas re-renders (some selections
// make it, and an edit does) it reports no paths for a moment; read as "nothing to ask",
// every inherited value blanked for that moment and came back. The node's last path is
// where the page will answer once it has rendered, so it is asked there and the field
// holds its value meanwhile (useStableStyleValue). Bounded: cleared when full.
const RENDERED_PATHS_MAX = 512;
const renderedPaths = new Map<string, string>();

function renderedPathOf(nodeId: string): string | undefined {
  const path = getHost().pathOf?.(nodeId);
  if (path === undefined || path.length === 0) {
    return renderedPaths.get(nodeId);
  }
  if (renderedPaths.size >= RENDERED_PATHS_MAX) {
    renderedPaths.clear();
  }
  renderedPaths.set(nodeId, path);
  assert(renderedPaths.size <= RENDERED_PATHS_MAX, 'renderedPathOf: the remembered paths are bounded');
  return path;
}

// A node's HTML tag, when it has one. A component instance's name is its
// component ('Card'), which says nothing about the tag it renders, so only a plain
// lowercase name counts — those are the ones a rendered tag can be checked against.
function tagOf(nodeId: string): string | undefined {
  const node = findNode(getHost().nodes, nodeId);
  if (node?.kind !== 'element') {
    return undefined;
  }
  const name = node.name ?? '';
  return /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
}

/** An answer from the page: what it said, and whether it is still being asked. */
type Answer = { value: string; pending: boolean; path: string | undefined };
// `path` is the element key (node and rendered path) the answer was read under.

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
  const path = hasCanvas() ? selectionKey() : undefined;
  // Nothing to ask — so nothing is pending either. No answer is ever coming, and
  // a control waiting forever would never show anything.
  if (!path) {
    return { value: '', pending: false, path: undefined };
  }
  learnKey(prop);
  const known = currentCache().read(path, prop);
  if (known.kind === 'pending') {
    // The page is being asked again (an edit dropped its answers): what it said last about this
    // element shows meanwhile, and the new answer refines it. A cleared field showed the empty
    // placeholder for the whole round trip, then the value; now it shows the ghost it had before.
    return { value: lastAnswers.get(lastAnswerKey(path, prop)) ?? '', pending: true, path };
  }
  rememberAnswer(path, prop, known.answer ?? '');
  return { value: known.answer ?? '', pending: false, path };
}

// The last answer the page gave per element and key, kept across the cache's invalidations (an
// edit, a re-render): the stand-in while the same question is asked again. Never sent anywhere and
// never written; bounded, and emptied when full.
const LAST_ANSWERS_MAX = 2048;
const lastAnswers = new Map<string, string>();

// Scoped to the project and file as well: the same node path in another page is another element.
function lastAnswerKey(path: string, prop: string): string {
  const host = getHost();
  return [host.projectPath ?? '', host.openFilePath ?? '', path, prop].join(ELEMENT_KEY_SEPARATOR);
}

function rememberAnswer(path: string, prop: string, value: string): void {
  const key = lastAnswerKey(path, prop);
  if (lastAnswers.get(key) === value) {
    return;
  }
  if (lastAnswers.size >= LAST_ANSWERS_MAX) {
    lastAnswers.clear();
  }
  lastAnswers.set(key, value);
  assert(lastAnswers.size <= LAST_ANSWERS_MAX, 'rememberAnswer: the remembered answers are bounded');
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

/**
 * The declaration that wins `prop` for the selected element, as written (`var(--text)`, never the
 * `rgb(…)` it computes to), from whichever rule, inline style or ancestor it comes: '' when only a
 * browser default sets it. Pass '' to skip asking. Read, never written: the value a field shows for a
 * property its selector does not set.
 */
export function useDeclaredValue(prop: string): string {
  return useComputedAnswer(prop ? `${DECLARED_PREFIX}${prop}` : '').value;
}

/** Source metadata shares the value cache, so selection and history changes
 * invalidate hints and provenance together, including late replies. */
export function useInheritedSource(prop: string) {
  const label = useComputedAnswer(prop ? `${SOURCE_LABEL_PREFIX}${prop}` : '').value;
  const path = useComputedAnswer(prop ? `${SOURCE_PATH_PREFIX}${prop}` : '').value;
  return label ? { label, ...(path ? { path } : {}) } : undefined;
}

// The browser's cascade answer for one property, read from the answer's JSON text.
function readCascadeProperty(text: string): CascadeProperty | undefined {
  if (text.length === 0) {
    return undefined;
  }
  try {
    const raw: unknown = JSON.parse(text);
    return parseCascadeProperty(raw);
  } catch {
    return undefined;
  }
}

/**
 * What the page's own cascade says about each of `props` for the selected element: the winning
 * declaration, the used value and the declarations that reach it. A property the page did not
 * answer for (no canvas, an inaccessible stylesheet, an inherited value) is absent, and the
 * caller keeps what the panel read from the files. Shares the computed-value cache, so a switch,
 * an edit or an undo drops these answers together with the values.
 */
export function useCascadeTruth(props: readonly string[]): ReadonlyMap<string, CascadeProperty> {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((tick) => tick + 1);
    const offCache = cache.subscribe(sync);
    const off = onHostChange(sync);
    return () => {
      offCache();
      off();
    };
  }, []);
  const path = hasCanvas() ? selectionKey() : undefined;
  const asked = props.slice(0, CASCADE_PROPERTIES_MAX);
  const reading = path === undefined ? undefined : currentCache();
  const texts = asked.map((prop) => {
    if (path === undefined || reading === undefined) {
      return '';
    }
    learnKey(`${CASCADE_PREFIX}${prop}`);
    const known = reading.read(path, `${CASCADE_PREFIX}${prop}`);
    return known.kind === 'pending' ? '' : (known.answer ?? '');
  });
  useEffect(() => {
    if (path === undefined) {
      return;
    }
    for (const prop of asked) {
      void currentCache().request(path, `${CASCADE_PREFIX}${prop}`);
    }
  });
  const askedKey = asked.join(UNIT_SEPARATOR);
  const textsKey = texts.join(UNIT_SEPARATOR);
  return useMemo(() => cascadeTruthOf(askedKey, textsKey), [askedKey, textsKey]);
}

const UNIT_SEPARATOR = '\u0001';

// The answers, rebuilt from the two joined strings that stand for them, so the result is
// the same object until an answer or the question changes.
function cascadeTruthOf(askedKey: string, textsKey: string): ReadonlyMap<string, CascadeProperty> {
  const found = new Map<string, CascadeProperty>();
  if (askedKey.length === 0) {
    return found;
  }
  const names = askedKey.split(UNIT_SEPARATOR);
  const answers = textsKey.split(UNIT_SEPARATOR);
  names.forEach((name, index) => {
    const parsed = readCascadeProperty(answers[index] ?? '');
    if (parsed !== undefined) {
      found.set(name, parsed);
    }
  });
  return found;
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
  // What was highlighted, and for which element. The sections are not remounted on a switch
  // (StyleCard.tsx), so the memory carries the element it was for: another element's
  // highlight is a guess about this one, and the fallback is the honest wait.
  const elementKey = getHost().selectedId ?? '';
  // Seeded with the fallback: on the very first render there is nothing else to
  // have been showing.
  const last = useRef({ elementKey, shown: settled || fallback });
  // Only a value the control can show as one of its options is worth holding. A variable or
  // a custom value (`var(--tt)`) is what was just cleared, and holding it kept its chip in
  // the field until the page answered, or for good when it never did.
  const sameElement = last.current.elementKey === elementKey;
  const held = sameElement && values.includes(last.current.shown) ? last.current.shown : fallback;
  const shown = settled || held;
  useEffect(() => {
    last.current = { elementKey, shown };
  }, [elementKey, shown]);
  return shown;
}
