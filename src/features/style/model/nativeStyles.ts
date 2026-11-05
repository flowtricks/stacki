// Native Webflow class styles — the responsive/breakpoint model + the pure
// helpers that project a NativeModel (read in webflow.ts) into the resolved
// style panel. Class styles are read/written through the Designer Style API
// (getProperties/setProperty), keyed by (breakpoint, pseudo). Tag styles have no
// Designer API, so they never appear here — those edits fall back to an embed.

import { assert } from '../../../../shared/core/assert';
import { STATES, type NativeContribution, type StateKey, type StyleContext } from './resolved';
import type { BreakpointId, NativeModel } from './styleTypes';
import { nestedQueryOfKey, splitSourcedKey } from './queryWrapper';

// ─────────────────────────── Breakpoints + states ───────────────────────────

export type NativeStyleOptions = { breakpoint?: BreakpointId; pseudo?: string };

export type BreakpointDefinition = {
  id: BreakpointId;
  label: string;
  /** Canonical `@media` condition, used to merge an equivalent embed query. */
  media: string | undefined;
};

// Webflow's fixed breakpoint scale, largest → smallest (the order the dropdown
// lists them after Base). `main` is the base breakpoint (= the panel's Base).
export const BREAKPOINTS: readonly BreakpointDefinition[] = [
  { id: 'xxl', label: 'Desktop ≥1920', media: '(min-width: 1920px)' },
  { id: 'xl', label: 'Desktop ≥1440', media: '(min-width: 1440px)' },
  { id: 'large', label: 'Desktop ≥1280', media: '(min-width: 1280px)' },
  { id: 'main', label: 'Base', media: undefined },
  { id: 'medium', label: 'Tablet', media: '(max-width: 991px)' },
  { id: 'small', label: 'Mobile (L)', media: '(max-width: 767px)' },
  { id: 'tiny', label: 'Mobile', media: '(max-width: 479px)' },
];

function isBreakpointId(value: string): value is BreakpointId {
  return BREAKPOINTS.some((breakpoint) => breakpoint.id === value);
}

// No breakpoint is listed for its own sake. Tablet, Mobile (L) and Mobile used
// to be, because a Webflow project always has them; an Astro one does not, and
// three device widths nobody had written a rule for sat above the queries the
// project actually uses. Every breakpoint now appears on the same terms as the
// desktop ones — when it carries styles — so a project that does use them still
// sees them, and one that does not is not asked to scroll past them.

// The panel's interaction state → Webflow pseudo (undefined = base / noPseudo).
const PSEUDO_FOR_STATE: Record<StateKey, string | undefined> = {
  '': undefined,
  ':hover': 'hover',
  ':focus': 'focus',
  ':active': 'active',
};

export const breakpointLabel = (id: BreakpointId): string => BREAKPOINTS.find((bp) => bp.id === id)?.label ?? id;

/** The `@media` condition for a breakpoint (e.g. `(max-width: 767px)`), or undefined for
 *  main/base. */
export const mediaParamsForBreakpoint = (id: BreakpointId): string | undefined => BREAKPOINTS.find((bp) => bp.id === id)?.media;

// Same compilation Webflow applies to a class display name → CSS class name.
// Duplicated (not imported from webflow.ts) to keep this module free of the
// Designer bridge and avoid an import cycle.
function compileClass(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-');
}

function normalizeMedia(text: string): string {
  return text
    .replace(/^@media/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// ─────────────────────────── Context helpers ───────────────────────────

/** Key into NativeStyle.propsByContext for a (breakpoint, state) pair. */
export function nativeContextKey(breakpoint: BreakpointId, state: StateKey): string {
  return `${breakpoint}|${state}`;
}

/** The Webflow breakpoint an embed at-context is equivalent to, if any. */
export function breakpointForAtContext(atContext: string): BreakpointId | undefined {
  const norm = normalizeMedia(atContext);
  for (const bp of BREAKPOINTS) {
    if (bp.media && normalizeMedia(bp.media) === norm) {
      return bp.id;
    }
  }
  return undefined;
}

/**
 * Style options for a native read at a raw breakpoint + state. Returns `undefined`
 * for the base/main breakpoint with no pseudo, so the caller invokes
 * `getProperties()` with no argument — Webflow's documented way to read base. An
 * empty-object argument (`{}`) is truthy and can hit the API's "a breakpoint was
 * specified" path, which reads the Designer's *current* breakpoint instead of
 * base — hiding desktop/base styles whenever the Designer isn't on desktop.
 */
export function readOptionsFor(breakpoint: BreakpointId, state: StateKey): NativeStyleOptions | undefined {
  const options: NativeStyleOptions = {};
  if (breakpoint !== 'main') {
    options.breakpoint = breakpoint;
  }
  const pseudo = PSEUDO_FOR_STATE[state];
  if (pseudo) {
    options.pseudo = pseudo;
  }
  return Object.keys(options).length ? options : undefined;
}

/**
 * Style options for a native write at the current panel context + state. Returns
 * `undefined` for base/main with no pseudo so the write targets base via the
 * no-argument form (see readOptionsFor — an empty `{}` can be treated as the
 * Designer's current breakpoint instead of base).
 */
export function optionsFor(context: StyleContext, state: StateKey): NativeStyleOptions | undefined {
  const options: NativeStyleOptions = {};
  if (context.breakpoint && context.breakpoint !== 'main') {
    options.breakpoint = context.breakpoint;
  }
  const pseudo = PSEUDO_FOR_STATE[state];
  if (pseudo) {
    options.pseudo = pseudo;
  }
  return Object.keys(options).length ? options : undefined;
}

// ─────────────────────────── Projection into the panel ───────────────────────────

/** Breakpoints where any applied style has native values (across read states). */
export function nativeBreakpointsWithValues(model: NativeModel | undefined): Set<BreakpointId> {
  const out = new Set<BreakpointId>();
  if (!model) {
    return out;
  }
  for (const style of model.styles) {
    for (const [key, props] of style.propsByContext) {
      const breakpoint = key.split('|')[0];
      if (props.size && breakpoint && isBreakpointId(breakpoint)) {
        out.add(breakpoint);
      }
    }
  }
  return out;
}

/** True when a breakpoint has any native value (drives the dropdown dot). */
export function nativeHasValues(model: NativeModel | undefined, breakpoint: BreakpointId): boolean {
  return nativeBreakpointsWithValues(model).has(breakpoint);
}

/**
 * Build the panel's ordered context list: Base + embed `@media`/`@container`
 * contexts (tagging any that equal a Webflow breakpoint) + native-only Webflow
 * breakpoints that carry values. Ordering: Base, then the Webflow scale, then
 * other embed queries.
 *
 * The canvas device does not add an entry. It used to: a phone-width canvas put
 * "Mobile (L)" in the list, and a tablet one "Tablet", though no stylesheet held
 * either query, so the list named breakpoints the project never had. A query is
 * listed because it is written somewhere, never because the canvas is that wide.
 */
export function buildStyleContexts(
  embedContextKeys: string[],
  model: NativeModel | undefined,
  /** Embed at-contexts where the selected element actually has styles. Custom
   *  queries and up-breakpoints only appear in the list when they're in here. */
  styledEmbedContexts: ReadonlySet<string> = new Set(),
  /** At-contexts belonging to the file being written into — the open component's
   *  own queries. They lead the custom-query group; ones reaching this element
   *  from somewhere else in the project follow. */
  ownContexts: ReadonlySet<string> = new Set(),
): StyleContext[] {
  const list: StyleContext[] = [];
  const usedBp = new Set<BreakpointId>();

  const nativeBps = nativeBreakpointsWithValues(model);

  embedContextKeys.forEach((key) => {
    if (key === '') {
      list.push({ key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' });
      usedBp.add('main');
      return;
    }
    // A query nested inside a rule is its own row, labelled by its query and
    // carrying its wrapper (model/queryWrapper.ts); it is never a breakpoint's row,
    // which stands for the query at the top level.
    // A key may also name the stylesheet the block is in (queryWrapper.ts): the
    // same query in two stylesheets is two rows, each saying where it lives.
    const { placed, source } = splitSourcedKey(key);
    const sourced = source === undefined ? {} : { source };
    const nested = nestedQueryOfKey(key);
    if (nested !== undefined) {
      if (styledEmbedContexts.has(key)) {
        list.push({ key, label: nested.atContext, breakpoint: undefined, embedAtContext: nested.atContext, wrapper: nested.wrapper, ...sourced });
      }
      return;
    }
    const bp = breakpointForAtContext(placed);
    if (bp) {
      // A breakpoint query, listed when it carries values — native, or the
      // element has styles here. Key it by `bp:<id>` (NOT the embed @media
      // string) so the selected breakpoint stays stable across elements —
      // different elements may or may not have an equivalent embed @media, but
      // Tablet is always Tablet.
      if (usedBp.has(bp)) {
        return;
      }
      if (!nativeBps.has(bp) && !styledEmbedContexts.has(key)) {
        return;
      }
      usedBp.add(bp);
      list.push({
        key: `bp:${bp}`,
        label: breakpointLabel(bp),
        breakpoint: bp,
        embedAtContext: placed,
      });
    } else {
      // A custom @media/@container: show only when the element has styles there,
      // so it doesn't clutter the list for every page-wide query in an embed.
      if (!styledEmbedContexts.has(key)) {
        return;
      }
      list.push({ key, label: placed, breakpoint: undefined, embedAtContext: placed, ...sourced });
    }
  });

  // Any breakpoint the loop above did not reach, on the same terms: it is
  // listed because something is written there, not because it exists.
  for (const definition of BREAKPOINTS) {
    if (definition.id === 'main' || usedBp.has(definition.id)) {
      continue;
    }
    if (!nativeBps.has(definition.id)) {
      continue;
    }
    usedBp.add(definition.id);
    list.push({
      key: `bp:${definition.id}`,
      label: definition.label,
      breakpoint: definition.id,
      embedAtContext: undefined,
    });
  }

  // One row per context: an authored query that equals a breakpoint's is that
  // breakpoint's row, never a second one beside it.
  assert(new Set(list.map((context) => context.key)).size === list.length, 'buildStyleContexts: every context is listed once');
  const ordered = list
    .map((context, index) => ({ context, index }))
    .sort((left, right) => rank(left.context, ownContexts) - rank(right.context, ownContexts) || left.index - right.index)
    .map((entry) => entry.context);
  assert(ordered.length === list.length, 'buildStyleContexts: ordering keeps every context');
  return ordered;
}

function rank(context: StyleContext, ownContexts: ReadonlySet<string>): number {
  if (context.key === '') {
    return -1;
  }
  if (context.breakpoint) {
    return BREAKPOINTS.findIndex((bp) => bp.id === context.breakpoint);
  }
  // Non-breakpoint embed contexts (@container, custom @media) come last — and
  // among those, the open component's own queries come first. They're the ones
  // being worked on; a query reaching this element from a project-wide stylesheet
  // is further away in every sense.
  return ownContexts.has(context.key) ? 100 : 101;
}

/**
 * The breakpoints whose native values apply at `target`, weakest (base) first →
 * `target` last. Webflow's max-width breakpoints (Tablet/Mobile) inherit down
 * from `main`; the min-width desktop ones inherit up from `main`. Reading only
 * the exact bucket would hide inherited base styles when viewing a breakpoint.
 */
export function breakpointCascade(target: BreakpointId): BreakpointId[] {
  const targetIndex = BREAKPOINTS.findIndex((bp) => bp.id === target);
  const mainIndex = BREAKPOINTS.findIndex((bp) => bp.id === 'main');
  if (targetIndex < 0 || targetIndex === mainIndex) {
    return ['main'];
  }
  const chain: BreakpointId[] = ['main'];
  const step = targetIndex > mainIndex ? 1 : -1;
  for (let i = mainIndex + step; i !== targetIndex + step; i += step) {
    const breakpoint = BREAKPOINTS[i];
    if (breakpoint === undefined) {
      throw new Error(`Breakpoint cascade index ${i} is outside its bounds`);
    }
    chain.push(breakpoint.id);
  }
  return chain;
}

/** The cascade tier of a breakpoint (0 = base/main; higher = narrower). A value
 *  read at this tier is "set here"; a lower tier is inherited from a wider one. */
export function breakpointTier(target: BreakpointId): number {
  return breakpointCascade(target).length - 1;
}

/**
 * Native contributions for a context + state. Folds the whole breakpoint cascade
 * (base → the current breakpoint) so inherited base styles show alongside the
 * breakpoint's own overrides; `bpTier` marks each value's cascade position so a
 * narrower breakpoint wins a same-specificity tie. Empty for a non-breakpoint
 * context.
 */
export function nativeContribsFor(model: NativeModel | undefined, context: StyleContext, state: StateKey): NativeContribution[] {
  if (!model) {
    return [];
  }
  // An embed-only query context (@media/@container that isn't a Webflow breakpoint) has
  // no breakpoint of its own, but the element's native class styles still apply inside it
  // — fall back to the base (main) native cascade so they fold in (as inherited/orange),
  // rather than vanishing when you view a query.
  const chain = breakpointCascade(context.breakpoint || 'main');
  // In an interaction-state view (:hover/…), base-state values still apply and are
  // overridden by the state's own — fold both (base first). The state's values get a
  // pseudo-class specificity bump so they win, and `atState` marks them "set here"
  // (a base value shown in a hover view is inherited → orange).
  const stateChain: StateKey[] = state ? ['', state] : [''];
  const out: NativeContribution[] = [];
  for (const style of model.styles) {
    // A combo at index i is produced by i+1 classes; a standalone (attribute-only)
    // base class by exactly one — its true class-specificity.
    const baseDepth = style.applied ? style.index + 1 : 1;
    // The style's real selector is its whole combo chain (`.test.is-2`), not just
    // the leaf class — so an override names the full selector that beats a value.
    const baseSelector = `.${style.namePath.map(compileClass).join('.')}`;
    chain.forEach((bp, bpTier) => {
      for (const st of stateChain) {
        const props = style.propsByContext.get(nativeContextKey(bp, st));
        if (!props) {
          continue;
        }
        const atState = st === state;
        const classDepth = baseDepth + (st ? 1 : 0); // the :state pseudo adds specificity
        const selector = `${baseSelector}${st}`;
        props.forEach((native, prop) => {
          out.push({
            styleIndex: style.index,
            className: style.className,
            selector,
            prop,
            value: native.value,
            isVariable: native.isVariable,
            classDepth,
            bpTier,
            atState,
          });
        });
      }
    });
  }
  return out;
}

/** A native Webflow class-style selector for the picker (combo chain + any state). */
export type NativeSelectorChip = {
  text: string;
  classDepth: number;
  state: StateKey;
  inContext: boolean;
};

/**
 * Native class-style selectors — each style's full combo chain (`.test.is-2`) plus
 * any interaction state it sets (`.test:hover`). A selector is listed when it has
 * its OWN values in ANY breakpoint (not inherited base values); `inContext` marks
 * whether it does so at the requested `breakpoint`, so the picker can DIM (rather
 * than hide) selectors styled only in other breakpoints — matching how embed
 * selectors from every query are listed.
 */
export function nativeSelectorChips(model: NativeModel | undefined, breakpoint: BreakpointId): NativeSelectorChip[] {
  if (!model) {
    return [];
  }
  const out: NativeSelectorChip[] = [];
  for (const style of model.styles) {
    const classDepth = style.applied ? style.index + 1 : 1;
    const base = `.${style.namePath.map(compileClass).join('.')}`;
    for (const state of STATES) {
      const hasAnywhere = BREAKPOINTS.some((bp) => {
        const props = style.propsByContext.get(nativeContextKey(bp.id, state));
        return !!(props && props.size);
      });
      if (!hasAnywhere) {
        continue;
      }
      const here = style.propsByContext.get(nativeContextKey(breakpoint, state));
      out.push({ text: `${base}${state}`, classDepth, state, inContext: !!(here && here.size) });
    }
  }
  return out;
}

/** The picked tokens as a plain compiled class chain, or undefined (tag/attr present). */
function pickedClassNames(selectedTokens: string[]): string[] | undefined {
  const names: string[] = [];
  for (const token of selectedTokens) {
    if (!token.startsWith('class:')) {
      return undefined;
    }
    names.push(compileClass(token.slice('class:'.length)));
  }
  return names.length ? names : undefined;
}

/**
 * The native style whose class chain matches the picked class tokens, or undefined —
 * returns the position in `model.styles` (the index used for reads/writes).
 * A combo style at applied index i represents classes[0..i], so native editing is
 * offered when the pick equals that whole prefix set. A single picked class also
 * matches a standalone (attribute-only) project style of the same name — the case
 * where the element carries the class via its `class` attribute, not the Styles
 * panel, yet a Webflow class of that name exists and is editable.
 */
export function selectedNativeIndexFor(model: NativeModel | undefined, selectedTokens: string[]): number | undefined {
  if (!model) {
    return undefined;
  }
  const picked = pickedClassNames(selectedTokens);
  if (!picked) {
    return undefined;
  }
  const pickedSet = new Set(picked);

  // Combo-chain match against the applied prefix classes[0..i].
  const applied = model.styles.filter((style) => style.applied);
  for (let i = 0; i < applied.length; i += 1) {
    if (i + 1 !== pickedSet.size) {
      continue;
    }
    const chain = new Set(applied.slice(0, i + 1).map((style) => style.className));
    if (chain.size === pickedSet.size && [...pickedSet].every((name) => chain.has(name))) {
      const style = applied[i];
      if (style === undefined) {
        throw new Error(`Applied style index ${i} is outside its bounds`);
      }
      return model.styles.indexOf(style);
    }
  }

  // Standalone match: one class the element carries via its `class` attribute whose
  // project-level Webflow style we resolved by name.
  if (pickedSet.size === 1) {
    const [name] = [...pickedSet];
    const standalone = model.styles.find((style) => !style.applied && style.className === name);
    if (standalone) {
      return model.styles.indexOf(standalone);
    }
  }
  return undefined;
}
