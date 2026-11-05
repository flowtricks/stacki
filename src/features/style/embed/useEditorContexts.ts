// Where an edit lands and what it resolves to: the embed and style contexts,
// the native target, a component's own source, the resolved properties, the
// selector chips and changing context (EmbedEditor.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { resolveStyle, selectorsMatch, type ContextInfo, type ContextKey, type MatchedSelector, type SourceKey, type StyleContext } from '../model/resolved';
import { breakpointForAtContext, breakpointTier, buildStyleContexts, nativeContribsFor, nativeHasValues, selectedNativeIndexFor } from '../model/nativeStyles';
import { listAtRuleBlocks } from '../model/css';
import {
  contextKeysWithStyles,
  indexPlacedContexts,
  modelForContext,
  nestedQueryOfKey,
  placedContextKey,
  ruleContextKey,
  ruleSourcedContextKey,
  sourcedContextKey,
  splitSourcedKey,
} from '../model/queryWrapper';
import { reachOfWrapper, type WrapperReach } from '../model/queryReach';
import { canvasWidthForQuery } from '../model/queryWidth';
import type { MatchTarget } from '../model/selectors';
import { nativeStylingAvailable, rebuildRules } from '../model/webflow';
import { indexQueriesByClass, orderContexts, relativeContexts, relativesOf } from '../model/contextOrder';
import { getHost, onHostChange } from '../model/host';
import { contextAfterDevice, deviceTargetOf } from '../model/deviceContext';
import { EMPTY_RULE_MODEL } from './EditorBasics';
import { chipsFor, styledSelectorsFor, usePseudoTarget } from './editorModel';
import { isGlobalSelector } from './LayoutRows';
import { useEditorRefs, useScanState, useSelectionState, useNativeState, usePendingWrites } from './useEditorFoundation';
import { useElementTokens } from './useEditorRuleEdits';
import { useTokenDefault, useActiveSelector, useSelectorPick, useSourceDocument, useContextKeys } from './useEditorElement';

// The queries the source file holds and the ones styling the element.
export function useEmbedContexts(
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
  contextKeys: ReturnType<typeof useContextKeys>,
) {
  const { context } = selectionState;
  const { model } = elementTokens;
  const { sourceDocument } = sourceDocumentHook;
  const { allContextKeys } = contextKeys;

  // Embed queries where THIS element actually has styles — so custom @media /
  // @container (and up-breakpoints) only appear in the dropdown when used. The
  // current context is kept so viewing an empty query doesn't hide itself.
  // The at-contexts the file being written into holds — the component's own
  // queries, as opposed to ones reaching this element from a page stylesheet.
  const sourceContexts = useMemo(() => {
    const set = new Set<string>();
    if (sourceDocument) {
      for (const region of sourceDocument.regions) {
        for (const block of listAtRuleBlocks(region)) {
          set.add(sourcedContextKey(placedContextKey(block.atContext.join(' › '), block.placement), sourceDocument.source.key));
        }
      }
    }
    return set;
  }, [sourceDocument]);
  const styledEmbedContexts = useMemo(() => {
    const set = new Set<string>();
    // Keyed by where each rule's query is written (model/queryWrapper.ts), so a
    // nested block the element has styles in names that block, not the query.
    if (model) {
      const known = new Set(allContextKeys);
      for (const key of contextKeysWithStyles(model)) {
        if (known.has(key)) {
          set.add(key);
        }
      }
    }
    if (context) {
      set.add(context);
    }
    // …plus the queries the file being written into already uses. Those are
    // offered for any element in it: the dropdown is how you get INTO a query
    // to write the first rule there, so hiding a query until something is
    // already in it is a door that only opens from the far side.
    for (const key of sourceContexts) {
      set.add(key);
    }
    return set;
  }, [model, allContextKeys, context, sourceContexts]);
  return { sourceContexts, styledEmbedContexts };
}

// The unified context list and the current context.
export function useStyleContexts(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  contextKeys: ReturnType<typeof useContextKeys>,
  embedContexts: ReturnType<typeof useEmbedContexts>,
  wrapperReachHook: ReturnType<typeof useWrapperReach>,
) {
  const { context, setContext, stickyContextRef } = selectionState;
  const { nativeModel } = nativeState;
  const { allContextKeys } = contextKeys;
  const { sourceContexts, styledEmbedContexts } = embedContexts;
  const { reachOf } = wrapperReachHook;

  // The unified context list: Base + the breakpoints/queries that are written
  // somewhere (never a preset nobody authored). Drives the dropdown and which
  // breakpoint native reads/writes target.
  const styleContexts = useMemo<StyleContext[]>(() => {
    // A query nested inside a rule is listed only where it can reach the element
    // (model/queryReach.ts): undecided ones stay, misses go.
    const list = buildStyleContexts(allContextKeys, nativeModel, styledEmbedContexts, sourceContexts).filter((entry) => reachOf(entry.key).kind !== 'misses');
    // Keep the manually-selected query available on any element — even one with no
    // styles there yet — so switching elements stays on it and you can add a style.
    // Only needed for custom @media/@container (breakpoints are always built). A
    // nested query that cannot reach this element is not kept: the effect below
    // returns the panel to Base instead.
    const sticky = stickyContextRef.current;
    if (context && sticky && sticky.key === context && !list.some((entry) => entry.key === context) && reachOf(context).kind !== 'misses') {
      list.push(sticky);
    }
    return list;
  }, [allContextKeys, nativeModel, styledEmbedContexts, sourceContexts, context, stickyContextRef, reachOf]);
  const currentContext = useMemo<StyleContext>(
    () =>
      styleContexts.find((entry) => entry.key === context) ??
      // A typed query, once written, is listed under its stylesheet: the typed key
      // names no stylesheet, so it is the written row's place that matches.
      styleContexts.find((entry) => splitSourcedKey(context).source === undefined && entry.key !== '' && splitSourcedKey(entry.key).placed === context) ??
      styleContexts[0] ?? { key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' },
    [styleContexts, context],
  );
  // Remember the selected context object so it survives an element switch (the list
  // rebuilds per element; a custom query the new element lacks gets re-injected above).
  useEffect(() => {
    if (currentContext.key === context) {
      stickyContextRef.current = currentContext;
    } else if (currentContext.key !== '' && splitSourcedKey(currentContext.key).placed === context) {
      // The typed query was written: follow it to its row, which names the stylesheet.
      setContext(currentContext.key);
    }
  }, [currentContext, context, stickyContextRef, setContext]);
  useDesktopReturnsToBase(currentContext, setContext);
  // The selection moved somewhere the chosen nested query cannot reach: writing
  // there would do nothing, so the panel goes back to Base.
  const contextReach = reachOf(context).kind;
  useEffect(() => {
    if (contextReach === 'misses') {
      setContext('');
    }
  }, [contextReach, setContext]);
  return { currentContext, styleContexts };
}

/**
 * Whether each nested query's wrapper reaches the selected element: the element
 * is the wrapper or sits inside it (model/queryReach.ts). Worked out against the
 * match target each time the element's model is rebuilt, which is also when the
 * target changes. Until an answer for the current target lands, every wrapper is
 * undecided, and undecided rows are shown.
 */
export function useWrapperReach(
  editorRefs: ReturnType<typeof useEditorRefs>,
  elementTokens: ReturnType<typeof useElementTokens>,
  contextKeys: ReturnType<typeof useContextKeys>,
) {
  const { selectedRef, targetRef } = editorRefs;
  const { model } = elementTokens;
  const { allContextKeys } = contextKeys;
  const wrappers = useMemo(() => {
    const set = new Set<string>();
    for (const key of allContextKeys) {
      const nested = nestedQueryOfKey(key);
      if (nested !== undefined) {
        set.add(nested.wrapper);
      }
    }
    return [...set].sort();
  }, [allContextKeys]);
  const wrappersKey = wrappers.join('\u0000');
  const [answers, setAnswers] = useState<{ readonly target: MatchTarget | undefined; readonly reach: ReadonlyMap<string, WrapperReach> }>({
    target: undefined,
    reach: new Map(),
  });
  useEffect(() => {
    // No element selected: a typed selector may be styled anywhere, so nothing is hidden.
    const target = selectedRef.current ? targetRef.current : undefined;
    let cancelled = false;
    void (async () => {
      const reach = new Map<string, WrapperReach>();
      for (const wrapper of wrappers) {
        reach.set(wrapper, await reachOfWrapper(wrapper, target));
      }
      if (!cancelled) {
        setAnswers({ target, reach });
      }
    })();
    return () => {
      cancelled = true;
    };
    // `model` is the trigger: a new target is set just before its model lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wrappersKey stands for wrappers
  }, [model, wrappersKey, selectedRef, targetRef]);
  const reachOf = useCallback(
    (key: ContextKey): WrapperReach => {
      const nested = nestedQueryOfKey(key);
      if (nested === undefined) {
        return { kind: 'reaches' };
      }
      const target = selectedRef.current ? targetRef.current : undefined;
      if (answers.target !== target) {
        return { kind: 'unknown' };
      }
      return answers.reach.get(nested.wrapper) ?? { kind: 'unknown' };
    },
    [answers, selectedRef, targetRef],
  );
  return { reachOf };
}

// Switching the canvas to desktop takes an `@media` context back to Base
// (model/deviceContext.ts says why and which contexts stay). It reacts to the
// host's device CHANGING to desktop: pressing Desktop while already on it is no
// switch, and so changes nothing.
function useDesktopReturnsToBase(currentContext: StyleContext, setContext: (context: ContextKey) => void): void {
  // Read through a ref so the subscription is made once, not on every context change.
  const currentContextRef = useRef(currentContext);
  currentContextRef.current = currentContext;
  useEffect(() => {
    let deviceLast = getHost().device;
    return onHostChange(() => {
      const device = getHost().device;
      if (device === deviceLast) {
        return;
      }
      deviceLast = device;
      const next = contextAfterDevice(currentContextRef.current, deviceTargetOf(device));
      switch (next.kind) {
        case 'base':
          setContext('');
          return;
        case 'keep':
          return;
        default: {
          const exhaustive: never = next;
          return exhaustive;
        }
      }
    });
  }, [setContext]);
}

// Which native class style the pick maps to, and the embeds that could style it.
export function useNativeTarget(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { selectedTokens } = selectionState;
  const { nativeModel, sourceSelection } = nativeState;
  const { documentByKey } = pendingWrites;

  // Which native class style the picked class tokens map to (if any), whether the
  // Native layer is available, and the layer actually in effect (Native falls back
  // to Embed for the tag / attributes / complex selectors that have no class Style).
  const nativeIndex = useMemo(() => selectedNativeIndexFor(nativeModel, selectedTokens), [nativeModel, selectedTokens]);
  const nativeAvailable = nativeIndex !== undefined;
  // A single class with no class Style yet (e.g. one that exists only as a combo,
  // like `is-2`) can still be edited natively — we create its base class on the
  // first edit. `creatableClass` is that class's display name.
  const creatableClass = useMemo<string | undefined>(() => {
    if (nativeIndex !== undefined || selectedTokens.length !== 1) {
      return undefined;
    }
    const token = selectedTokens[0] ?? '';
    return token.startsWith('class:') ? token.slice('class:'.length) : undefined;
  }, [nativeIndex, selectedTokens]);
  // …but only when a native styling system exists. Without one (a plain CSS
  // project) every property is authored into the stylesheet instead, or the
  // first edit on an unstyled class would route to a native write that cannot
  // happen and fail silently.
  const canNative = nativeStylingAvailable() && (nativeAvailable || creatableClass !== undefined);

  // Every embed that could style this element, in page/cascade order — later embeds
  // win (their CSS is injected after Webflow's stylesheet and after earlier embeds).
  const embedList = useMemo(() => [...documentByKey.values()].sort((left, right) => left.source.order - right.source.order), [documentByKey]);

  // The dropdown picks the fallback embed only — Webflow is never a choice. Styles
  // always try to apply natively first; whatever the class can't take natively
  // lands in the selected embed. The user's pick (sourceSel) overrides the default
  // (first embed in page order) and persists across element switches.
  const sourceKeys = useMemo(() => embedList.map((embedDocument) => embedDocument.source.key), [embedList]);
  // The source dropdown only picks where NEW styles are created — it does not scope
  // which existing rule is editable. So it just tracks the user's pick, defaulting to
  // the first embed in page order.
  const effectiveSourceSelection = sourceSelection && sourceKeys.includes(sourceSelection) ? sourceSelection : (sourceKeys[0] ?? '');
  return { canNative, creatableClass, effectiveSourceSelection, embedList, nativeIndex };
}

// Point the style source at an open component's own embed.
export function useComponentSource(
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
) {
  const { scan } = scanState;
  const { pageSourceRef, previousInComponentRef, setSourceSelection, sourceSelectionRef, wantCompSourceRef } = nativeState;
  const { embedList } = nativeTarget;

  // Open a component → point the source at that component's own embed; close it →
  // restore the page pick. The switch is in-memory only (persistence stays the page
  // pick). Component embeds stream in after the page tree, so a pending switch waits
  // for the component embed to appear rather than firing once on the transition.
  //
  // The open component's own blocks are the node sources marked as a component's:
  // a node source is one only while a component file is open. Pinning follows
  // them too, not just the scan's flag, so a component drilled into from a page
  // defaults to its own <style> rather than whichever source sorts first.
  const ownKey = embedList.find((embedDocument) => embedDocument.source.fromComponent && embedDocument.source.origin.kind === 'node')?.source.key;
  const inComponentContext = (scan?.inComponentContext ?? false) || ownKey !== undefined;
  useEffect(() => {
    const componentSourceKey = ownKey ?? embedList.find((embedDocument) => embedDocument.source.fromComponent)?.source.key;
    if (inComponentContext !== previousInComponentRef.current) {
      previousInComponentRef.current = inComponentContext;
      if (inComponentContext) {
        // Stash the page pick to restore on exit.
        pageSourceRef.current = sourceSelectionRef.current;
        wantCompSourceRef.current = true;
      } else {
        wantCompSourceRef.current = false;
        setSourceSelection(pageSourceRef.current);
      }
    }
    // Fulfill a pending switch once the open component's embed has loaded.
    if (inComponentContext && wantCompSourceRef.current && componentSourceKey) {
      wantCompSourceRef.current = false;
      setSourceSelection(componentSourceKey);
    }
  }, [inComponentContext, embedList, ownKey, pageSourceRef, previousInComponentRef, setSourceSelection, sourceSelectionRef, wantCompSourceRef]);
  return { inComponentContext };
}

// The layer edits go to, and the resolved style for the pick.
export function useResolved(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  componentSource: ReturnType<typeof useComponentSource>,
) {
  const { stateKey } = selectionState;
  const { nativeModel, setSourceSelection } = nativeState;
  const { model } = elementTokens;
  const { elementIdentity } = tokenDefault;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { canNative, effectiveSourceSelection, nativeIndex } = nativeTarget;
  const { inComponentContext } = componentSource;

  // Webflow's native style system only supports its own breakpoints (Base/Tablet/…)
  // and interaction states — NOT a custom `@media`/`@container` the user added (those
  // have no `breakpoint`). Editing in a custom query must go to the embed, or the
  // native write silently lands on Base instead of the query.
  const nativeContextOk = currentContext.breakpoint !== undefined;
  // Native is the primary layer whenever the selection can carry a class Style AND the
  // context is native-capable; otherwise (tag / attribute / complex selector, or a
  // custom query) the embed is the only target.
  const effectiveSource: SourceKey = canNative && nativeContextOk ? 'native' : 'embed';
  // The chosen embed: always the fallback target, and the editable layer for props
  // the native class doesn't set.
  const selectedEmbedKey = effectiveSourceSelection || undefined;
  const selectedNativeIndex = canNative && nativeContextOk ? nativeIndex : undefined;

  // Native contributions for the current context + state, folded into the model.
  const nativeContribs = useMemo(() => nativeContribsFor(nativeModel, currentContext, stateKey), [nativeModel, currentContext, stateKey]);

  const pseudoLayer = usePseudoTarget();
  const resolved = useMemo(
    () =>
      resolveStyle(modelForContext(model ?? EMPTY_RULE_MODEL, currentContext), currentContext.embedAtContext ?? ' native-only', activeSelector, {
        source: effectiveSource,
        contribs: nativeContribs,
        selectedIndex: selectedNativeIndex,
        selectedEmbedKey,
        ...(currentContext.breakpoint ? { currentTier: breakpointTier(currentContext.breakpoint) } : {}),
        pseudoLayer,
      }),
    [model, currentContext, activeSelector, effectiveSource, nativeContribs, selectedNativeIndex, selectedEmbedKey, pseudoLayer],
  );

  // The stylesheet the active selector's rule already lives in. resolveStyle
  // picks selectedRule by selector identity and explicitly does NOT scope it to
  // the source dropdown, so reading it here can't feed back into itself.
  const homeEmbedKey = resolved.selectedRule?.embedKey;

  // Selecting an element points "Add custom styles in" at the file that already
  // defines its selector, so a new declaration joins the rule that's there
  // instead of landing in whichever stylesheet happens to be first in page
  // order. An explicit pick still wins: the effect only re-runs when the element
  // or the selector's home changes, not on every render. Left alone inside a
  // component, where the source is pinned to that component's own embed.
  useEffect(() => {
    if (!homeEmbedKey || inComponentContext) {
      return;
    }
    setSourceSelection((previous) => (previous === homeEmbedKey ? previous : homeEmbedKey));
  }, [elementIdentity, activeSelector, homeEmbedKey, inComponentContext, setSourceSelection]);
  return { effectiveSource, nativeContextOk, resolved, selectedEmbedKey, selectedNativeIndex };
}

// The chip picker's selectors and the context dropdown's info.
export function useSelectorChips(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
) {
  const { removedClasses } = scanState;
  const { documentByKey } = pendingWrites;
  const { selectedSelectorText } = selectionState;
  const { nativeModel } = nativeState;
  const { model, snapshot, tokens } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { currentContext, styleContexts } = styleContextsHook;
  const pseudo = usePseudoTarget();

  // Every selector (with styles) that targets this element in the current context —
  // the element's own classes, stateful, and complex/ancestor selectors — for the
  // chip picker. Include the active selector even when it has no rule yet (a fresh
  // pick/typed one) so it shows as selected while you add its first property.
  const selectorChips = useMemo<MatchedSelector[]>(
    () =>
      chipsFor({
        model: model === undefined ? undefined : modelForContext(model, currentContext),
        nativeModel,
        currentContext,
        activeSelector,
        selectedSelectorText,
        tokens,
        classList: snapshot?.classList ?? [],
        removedClasses,
        pseudo,
      }),
    [model, nativeModel, currentContext, activeSelector, selectedSelectorText, tokens, snapshot, removedClasses, pseudo],
  );

  // Per-context dropdown info: embed hasStyles/combos (for the dot + auto-highlight)
  // plus whether the breakpoint carries native values.
  const contextInfos = useMemo<ContextInfo[]>(() => {
    // Each row read through its own placement (model/queryWrapper.ts): a nested
    // row's dot is about that block, and its wrapper is where the block is.
    const embedInfos = indexPlacedContexts(model ?? EMPTY_RULE_MODEL, styleContexts);
    return styleContexts.map((sc, index) => {
      const embed = embedInfos[index];
      const nativeHas = sc.breakpoint ? nativeHasValues(nativeModel, sc.breakpoint) : false;
      return {
        key: sc.key,
        hasStyles: (embed?.hasStyles ?? false) || nativeHas,
        styledCombos: embed?.styledCombos ?? [],
        bestTokens: embed?.bestTokens,
        ...(embed?.wrapper === undefined ? {} : { wrapper: embed.wrapper }),
      };
    });
  }, [model, styleContexts, nativeModel]);

  // The dropdown's order (model/contextOrder.ts): Base, the queries this element
  // has styles in, the ones its nearest relatives have styles in, then the rest.
  // The class index is rebuilt per scan (documentByKey is), which is also when
  // the selection or the rules change; relatives come from the host's page tree,
  // so ordering asks the canvas nothing.
  const queryIndex = useMemo(
    () =>
      indexQueriesByClass(rebuildRules([...documentByKey.values()]), (atContext, rule) => {
        // A nested block's row is its placed key; only a top-level query can be a breakpoint's row.
        const placed = ruleContextKey(rule);
        const breakpoint = placed === atContext ? breakpointForAtContext(atContext) : undefined;
        return breakpoint === undefined ? ruleSourcedContextKey(rule) : `bp:${breakpoint}`;
      }),
    [documentByKey],
  );
  const orderedContexts = useMemo(() => {
    const own = new Set(contextInfos.filter((info) => info.hasStyles).map((info) => info.key));
    const host = getHost();
    const relatives = relativeContexts(relativesOf(host.nodes, host.selectedId), queryIndex);
    return orderContexts(styleContexts, own, relatives);
  }, [contextInfos, queryIndex, styleContexts]);
  return { contextInfos, orderedContexts, selectorChips };
}

// The canvas page's root font size, for a `rem` query width. The canvas query
// protocol does not report the root element's computed font size, so this is
// the browser default; a page that changes it gets a canvas a little off the
// query's edge, still on the side the arithmetic put it.
const ROOT_FONT_SIZE_PX = 16;

// Switch context, keeping or re-picking a selector styled there.
export function useContextChange(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
) {
  const { pendingDefaultRef, setContext } = selectionState;
  const { nativeModel } = nativeState;
  const { model } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { selectActiveSelector } = selectorPick;
  const { styleContexts } = styleContextsHook;

  // Switching context auto-selects a selector that has styles in the new query:
  // keep the current pick if it's styled there, otherwise jump to the strongest.
  const onContextChange = useCallback(
    (next: ContextKey) => {
      pendingDefaultRef.current = false;
      setContext(next);
      const nextContext = styleContexts.find((entry) => entry.key === next);
      // A picked media query moves the canvas inside it, so the styles written
      // there show (model/queryWidth.ts). The canvas becomes a `custom` width,
      // never `desktop`, so this can't trip the Desktop-returns-to-Base rule
      // (model/deviceContext.ts) and undo the pick it was made for.
      if (nextContext?.embedAtContext) {
        const width = canvasWidthForQuery(nextContext.embedAtContext, ROOT_FONT_SIZE_PX);
        if (width.kind === 'width') {
          getHost().setCanvasWidth?.(width.widthPx);
        }
      }
      if (!nextContext || !model) {
        return;
      }
      // Only selectors with styles IN this context (drop the dimmed other-context ones).
      // Never jump to a global selector (`:focus-visible`, `*`): editing one edits
      // most of the site, and it isn't about this element.
      const styled = styledSelectorsFor(modelForContext(model, nextContext), nativeModel, nextContext).filter(
        (entry) => entry.inContext !== false && !isGlobalSelector(entry.text),
      );
      if (!styled.length) {
        return;
      }
      if (activeSelector && styled.some((entry) => selectorsMatch(entry.text, activeSelector))) {
        return;
      }
      const strongest = styled[styled.length - 1];
      if (strongest !== undefined) {
        selectActiveSelector(strongest.text);
      }
    },
    [styleContexts, model, nativeModel, activeSelector, selectActiveSelector, pendingDefaultRef, setContext],
  );
  return { onContextChange };
}
