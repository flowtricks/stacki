// Settling the panel after a change: upgrading the default selector, and
// re-syncing focus when the context moves (EmbedEditor.tsx).

import { described } from '../../../../shared/properties/i18n/messageRef';
import { useTranslate, useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import { PLACEMENT_END } from '../../../editor/classAttr';
import { useEffect } from 'react';
import { hslaToRgba } from '../model/colorWrite';
import { contextKeyOf, editableRuleFor, selectedRulesSetting, type SourceKey } from '../model/resolved';
import { mediaParamsForBreakpoint, optionsFor } from '../model/nativeStyles';
import { createRuleInPlacedQuery, ensureNestPath, ensureQueryBlock, parseNestedInput, type NestStep } from '../model/css';
import {
  applyNativePropertyAt,
  applyNativeToNewBaseClass,
  blankStyleDocument,
  rebuildRules,
  removeNativePropertyAt,
  webflowApi,
  writeEmbedDocument,
  writeFirstStyleBlock,
  type EmbedDocument,
} from '../model/webflow';
import { getHost, walkNodes } from '../model/host';
import { authoredClassTokens } from '../model/webflowElement';
import { isAutoClassSelector, planFirstStyles, type FirstStylesPlan } from '../model/firstStyleBlock';
import { type PropWrite } from './EditorBasics';
import {
  upgradedDefault,
  type EmbedRegion,
  embedWriteTarget,
  placedQueryTarget,
  createRuleForWrite,
  type NativeAttempt,
  pseudoLayerChips,
  readPanelLayer,
  styledSelectorsFor,
  takeTypedPath,
} from './editorModel';
import { EMBED_ONLY_PROPS } from './ResolvedRows';
import { isGlobalSelector } from '../model/selectors';
import { asQuery } from './SelectorPicker';
import { useEditorRefs, useBusyState, useScanState, useSelectionState, useNativeState, usePendingWrites } from './useEditorFoundation';
import { useRefresh, useRefreshDerived } from './useEditorScanning';
import { usePropEdits, useElementTokens } from './useEditorRuleEdits';
import { useTokenDefault, useActiveSelector, useSelectorPick, useTypedSelector } from './useEditorElement';
import { useStyleContexts, useNativeTarget, useResolved } from './useEditorContexts';
import { useNativeRefresh, useNativeOps } from './useEditorNative';
export { useNativeRefresh, useNativeOps } from './useEditorNative';

// Upgrade a new element's default selector to one styled in the context.
export function useDefaultUpgrade(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
) {
  const { context, defaultTokensRef, pendingDefaultRef } = selectionState;
  const { nativeIdentityRef, nativeModel } = nativeState;
  const { model, snapshot, tokens } = elementTokens;
  const { elementIdentity } = tokenDefault;
  const { selectActiveSelector } = selectorPick;
  const { styleContexts } = styleContextsHook;

  // On selecting a new element, upgrade the raw all-classes default to the strongest
  // selector actually STYLED in the current context — so if `.media_card_title` is
  // styled in `@container (…)` but the full combo isn't, we land on `.media_card_title`.
  // Runs once the model is ready for the new element; skips if you already picked.
  useEffect(() => {
    if (!pendingDefaultRef.current || !model) {
      return;
    }
    // Wait until nativeModel is the CURRENT element's — it loads via a separate async
    // effect and lags the embed model on a switch. Defaulting off a stale nativeModel
    // would pick the previous element's native selectors (and clobber pendingDefaultRef),
    // leaving that selector stuck as a pending chip. Re-runs when nativeModel catches up.
    if (nativeIdentityRef.current !== elementIdentity) {
      return;
    }
    const activeContext = styleContexts.find((entry) => entry.key === context);
    if (!activeContext) {
      return;
    }
    // The element's default is one of its own selectors, never its ::after's.
    const styled = pseudoLayerChips(styledSelectorsFor(model, nativeModel, activeContext), readPanelLayer()).filter((entry) => entry.inContext !== false);
    // Nothing styled yet — likely mid-scan (embeds still streaming). Leave the default
    // armed so we retry as they arrive, instead of committing to the unstyled combo.
    if (!styled.length) {
      return;
    }
    pendingDefaultRef.current = false;
    // A global selector must never become the default. It matches nearly every
    // element, so picking one would both force its (hidden) chip back on screen
    // and point the style fields at a rule that isn't about this element —
    // editing `:focus-visible` here would restyle the whole site. With only
    // globals styling this element, the composed token selector stays the pick.
    const local = styled.filter((entry) => !isGlobalSelector(entry.text));
    if (!local.length) {
      return;
    }
    // Use the FRESH default the effect just set (not `activeSelector`, which is still
    // the previous element's here).
    const initial = upgradedDefault(local, {
      tokens,
      classList: snapshot?.classList ?? [],
      defaultTokens: defaultTokensRef.current,
    });
    if (initial !== undefined) {
      selectActiveSelector(initial.text);
    }
  }, [
    model,
    nativeModel,
    context,
    styleContexts,
    tokens,
    elementIdentity,
    snapshot,
    selectActiveSelector,
    defaultTokensRef,
    nativeIdentityRef,
    pendingDefaultRef,
  ]);
}

// Re-read the selection when the panel regains focus.
export function useFocusResync(
  editorRefs: ReturnType<typeof useEditorRefs>,
  refreshHook: ReturnType<typeof useRefresh>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
) {
  const { busyRef } = editorRefs;
  const { refresh } = refreshHook;
  const { refreshNative } = nativeRefresh;

  // Sync back edits made in the Designer itself — adding/removing a class, changing
  // a value in Webflow's native style panel, or editing another embed. Webflow fires
  // no event for these, so re-read the current selection whenever the panel regains
  // focus (the user returns to it after acting on the canvas / native panel). refresh
  // re-reads the element's classes + embeds (class changes flow through to the native
  // read via elementIdentity); refreshNative catches native value edits that leave the
  // class set unchanged.
  useEffect(() => {
    const api = webflowApi();
    if (!api?.getSelectedElement) {
      return;
    }
    let timer: number | undefined = undefined;
    const resync = () => {
      // Don't fight an in-progress write or an active edit inside the panel.
      if (busyRef.current) {
        return;
      }
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      if (timer !== undefined) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = undefined;
        void api.getSelectedElement?.().then((element) => {
          if (!element || busyRef.current) {
            return;
          }
          void refresh(element);
          void refreshNative();
        });
      }, 150);
    };
    const onVisible = () => {
      if (!document.hidden) {
        resync();
      }
    };
    window.addEventListener('focus', resync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      window.removeEventListener('focus', resync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, refreshNative, busyRef]);
}

// Create the picked selector's rule in an embed.
export function useWriteNewRule(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  resolvedHook: ReturnType<typeof useResolved>,
  editorRefs: ReturnType<typeof useEditorRefs>,
) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { setBusyBoth, setSaveError } = busyState;
  const { setStatus } = scanState;
  const { settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { selectActiveSelector, typedPathsRef } = selectorPick;
  const { primedRef } = editorRefs;
  const { resolved } = resolvedHook;

  // Writes target the picked selector's rule in the current context/state, and
  // create that rule on the first edit when it doesn't exist yet.
  const selectedRule = resolved?.selectedRule ?? undefined;
  // Where one property's edit goes: the rule its shown value comes from.
  const ruleFor = (prop: string) => (resolved ? editableRuleFor(resolved, prop) : undefined);
  // Every rule of the pick that sets a property — what clearing it empties.
  const rulesSetting = (prop: string) => (resolved ? selectedRulesSetting(resolved, prop) : []);
  // Create the picked selector's rule in the target embed, write the embed, and
  // refresh the panel's model.
  const writeNewRule = async (
    where: {
      embedDocument: EmbedDocument;
      region: EmbedRegion;
      embedContext: string | undefined;
      wrapper: string | undefined;
      bpMedia: string | undefined;
      selector: string;
      /** First styles (model/firstStyleBlock.ts): what else the write has to do besides
       *  adding a rule. Absent in every ordinary write. */
      firstStyles?: Exclude<FirstStylesPlan, { kind: 'normal' | 'refused' }>;
    },
    write: PropWrite,
  ) => {
    const { embedDocument, region, embedContext, wrapper, bpMedia, firstStyles } = where;
    const fullSelector = where.selector;
    setBusyBoth(true);
    setStatus('Saving…'); // i18n-ignore: write-only status, never rendered.
    // try/finally so `busy` always clears even if creating the rule / writing throws
    // (a stuck busy would disable every button in the panel).
    try {
      // The class goes on first when sources exist: the rule is built into a live document
      // below, and a refused class must not leave a rule in it that was never written.
      if (firstStyles?.kind === 'class') {
        const outcome = (await getHost().addClass?.(firstStyles.className, PLACEMENT_END)) ?? {
          tag: 'refused',
          ...described('styleModel.embed.hook.pageCannotTakeClass'),
        };
        if (outcome.tag === 'refused') {
          setSaveError(translate('styleModel.embed.hook.classNotOnElement', { selector: fullSelector, reason: translateDescribed(outcome) }));
          return;
        }
      }
      const nested = takeTypedPath(typedPathsRef.current, fullSelector, embedContext ?? '');
      const ok = createRuleForWrite(region, {
        nested,
        bpMedia,
        embedContext,
        wrapper,
        selector: fullSelector,
        write,
      });
      if (!ok) {
        setStatus('Nothing to save.'); // i18n-ignore: write-only status, never rendered.
        return;
      }
      const result =
        firstStyles !== undefined && firstStyles.kind !== 'class'
          ? await writeFirstStyleBlock(embedDocument, firstStyles.kind === 'block-and-class' ? firstStyles.className : undefined)
          : await writeEmbedDocument(embedDocument);
      if (firstStyles !== undefined && result.ok) {
        // The element changed, so what the canvas matched for these selectors no longer
        // holds (as for a class typed into the selector box), and the new class is the pick.
        primedRef.current = undefined;
        selectActiveSelector(fullSelector);
      }
      await refreshDerived();
      if (!settleEmbedWrite(embedDocument, result, 'rule')) {
        return;
      }
      setStatus(`Added ${fullSelector}.`); // i18n-ignore: write-only status, never rendered.
    } finally {
      setBusyBoth(false);
    }
  };
  return { selectedRule, ruleFor, rulesSetting, writeNewRule };
}

// Create a rule for the pick in the current context.
export function useCreateRule(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  resolvedHook: ReturnType<typeof useResolved>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
) {
  const translateDescribed = useTranslateDescribed();
  const { setStatus } = scanState;
  const { setSaveError } = busyState;
  const { documentByKey } = pendingWrites;
  const { model, snapshot } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { selectedEmbedKey } = resolvedHook;
  const { writeNewRule } = writeNewRuleHook;

  const createSelectedRule = (write: PropWrite, selectorOverride?: string) => {
    // A Webflow-breakpoint context with no equivalent embed query yet writes into a
    // synthesized @media block; otherwise the embed's base or existing query block.
    const embedContext = currentContext.embedAtContext;
    const bpMedia =
      embedContext === undefined && currentContext.breakpoint && currentContext.breakpoint !== 'main'
        ? mediaParamsForBreakpoint(currentContext.breakpoint)
        : undefined;
    // Write into the chosen embed when one is selected; otherwise the embed of a
    // matching rule in this context (or the first embed).
    const where = newRuleTarget();
    const requested = selectorOverride ?? activeSelector;
    const plan = firstStylesPlan(requested);
    if (plan.kind === 'refused') {
      setSaveError(translateDescribed(plan));
      return;
    }
    if (plan.kind === 'normal') {
      if (!where) {
        setStatus('No embed here to write to — add an HTML embed first.'); // i18n-ignore: write-only status, never rendered.
        return;
      }
      void writeNewRule({ ...where, embedContext, wrapper: currentContext.wrapper, bpMedia, selector: requested }, write);
      return;
    }
    // First styles (model/firstStyleBlock.ts). A block with no source yet is built in a blank
    // document and handed to the host with its class, as one edit; with a block already there
    // the rule goes into it and the class is put on first.
    const firstStyles = plan;
    const selector = plan.kind === 'block' ? requested : `.${plan.className}`;
    const target = plan.kind === 'class' ? where : blankTarget();
    if (!target) {
      setStatus('No embed here to write to — add an HTML embed first.'); // i18n-ignore: write-only status, never rendered.
      return;
    }
    void writeNewRule({ ...target, embedContext, wrapper: currentContext.wrapper, bpMedia, selector, firstStyles }, write);
  };
  const blankTarget = () => {
    const embedDocument = blankStyleDocument();
    const region = embedDocument.regions[0];
    return region === undefined ? undefined : { embedDocument, region };
  };
  // What a rule that is about to be created does first: nothing, for any project that has a
  // style of its own.
  const firstStylesPlan = (selector: string): FirstStylesPlan => {
    const host = getHost();
    const tag = snapshot?.tag;
    const elementClasses = snapshot?.classes ?? [];
    const bareTag = tag !== undefined && selector === tag && elementClasses.length === 0;
    const documents = [...documentByKey.values()];
    // Reading every rule of every source is the one costly step, and only a source made of
    // this mode's own rules can matter, so it is read only for a class-less tag with sources.
    const ruleSelectors = bareTag && documents.length > 0 ? rebuildRules(documents).flatMap((rule) => rule.selectors.map((info) => info.text)) : [];
    const taken = new Set<string>(elementClasses);
    walkNodes(host.nodes, (node) => {
      for (const name of authoredClassTokens(node)) {
        taken.add(name);
      }
    });
    for (const text of ruleSelectors) {
      if (isAutoClassSelector(text)) {
        taken.add(text.trim().slice(1));
      }
    }
    return planFirstStyles({
      selector,
      tag,
      elementClasses,
      sourceCount: documents.length,
      ruleSelectors,
      takenClasses: taken,
      filePath: host.openFilePath,
    });
  };
  // The stylesheet a new rule in the current context lands in. A query row names
  // its block's stylesheet, so that wins over the source dropdown's pick, which
  // still decides for Base and breakpoints (editorModel.ts placedQueryTarget).
  const newRuleTarget = () => {
    const embedContext = currentContext.embedAtContext;
    const chosen = embedWriteTarget({ model, selectedEmbedKey, documentByKey }, (rule) => contextKeyOf(rule) === (embedContext ?? ''));
    if (!embedContext) {
      return chosen;
    }
    return placedQueryTarget(chosen, documentByKey, { atContextKey: embedContext, wrapper: currentContext.wrapper, source: currentContext.source });
  };
  // A live write (a drag, typing) in a nested context where the pick has no rule
  // yet. Without it the canvas stood still until the commit: a live write only
  // ever updated a rule that already existed. The block gets the value now, the
  // same way the commit will write it, so the commit then finds it in place.
  const liveCreateInNestedQuery = (write: PropWrite): boolean => {
    const embedContext = currentContext.embedAtContext;
    const wrapper = currentContext.wrapper;
    if (wrapper === undefined || !embedContext || !activeSelector) {
      return false;
    }
    const where = newRuleTarget();
    if (!where) {
      return false;
    }
    const placed = createRuleInPlacedQuery(where.region, { atContextKey: embedContext, wrapper, selector: activeSelector }, write.prop, {
      value: write.value,
      important: write.important,
    });
    if (placed) {
      void writeEmbedDocument(where.embedDocument, true);
    }
    return placed;
  };
  return { createSelectedRule, liveCreateInNestedQuery };
}

// Scaffold a just-typed query into the embed.
export function useEmptyContext(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  elementTokens: ReturnType<typeof useElementTokens>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { documentByKey, settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { model } = elementTokens;
  const { selectedEmbedKey } = resolvedHook;

  // Add a just-typed query to the embed IMMEDIATELY as an empty block, so it persists and
  // reads back as a real context without waiting for the first property. `ctxKey` (wrap)
  // scaffolds a top-level `@query {}`; `path` (nest) scaffolds `selector { @query {} }`.
  // Targets the same embed createSelectedRule would; if there's no embed to write into
  // yet, it no-ops and the query stays a pending local context until the first edit.
  const writeEmptyContext = ({ path, contextKey }: { readonly path?: NestStep[]; readonly contextKey?: string }) => {
    const where = embedWriteTarget({ model, selectedEmbedKey, documentByKey }, undefined);
    // No embed here yet — keep it as a pending local context.
    if (!where) {
      return;
    }
    const { embedDocument, region } = where;
    void (async () => {
      setBusyBoth(true);
      setStatus('Adding query…'); // i18n-ignore: write-only status, never rendered.
      // try/finally so a throw while scaffolding the query block can't leave `busy` stuck
      // true — that would wrongly disable every add button (transforms, shadows, …).
      try {
        const ok = path ? ensureNestPath(region, path) : contextKey ? ensureQueryBlock(region, contextKey) : false;
        if (!ok) {
          setStatus('Couldn’t add the query.'); // i18n-ignore: write-only status, never rendered.
          return;
        }
        await refreshDerived();
        const result = await writeEmbedDocument(embedDocument);
        if (!settleEmbedWrite(embedDocument, result, 'rule')) {
          return;
        }
        setStatus('Query added.'); // i18n-ignore: write-only status, never rendered.
      } finally {
        setBusyBoth(false);
      }
    })();
  };
  return { writeEmptyContext };
}

// Add a query, and route a property write to its layer.
export function useAddQuery(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  propEdits: ReturnType<typeof usePropEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  typedSelector: ReturnType<typeof useTypedSelector>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  createRule: ReturnType<typeof useCreateRule>,
  emptyContext: ReturnType<typeof useEmptyContext>,
) {
  const { setContext } = selectionState;
  const { nativeModel } = nativeState;
  const { onSetProp } = propEdits;
  const { activeSelector } = activeSelectorHook;
  const { setTypedContexts } = selectorPick;
  const { addTypedSelector } = typedSelector;
  const { canNative } = nativeTarget;
  const { nativeContextOk, resolved, selectedNativeIndex } = resolvedHook;
  const { ruleFor } = writeNewRuleHook;
  const { createSelectedRule } = createRule;
  const { writeEmptyContext } = emptyContext;

  // Add a custom query (@media/@container/@supports) to the current selector from the
  // query dropdown's "Add query" form. `wrap` registers the query as a context and
  // switches to it — the first edit creates a new `@query { selector { … } }` block;
  // `nest` reuses the typed nesting path so the edit writes `selector { @query { … } }`
  // inside the selector's own rule. A bare `(…)` / condition defaults to `@media`.
  const onAddQuery = (raw: string, mode: 'wrap' | 'nest') => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return;
    }
    const query = asQuery(trimmed);
    if (mode === 'nest' && activeSelector) {
      const nestedInput = `${activeSelector} { ${query} }`;
      addTypedSelector(nestedInput, PLACEMENT_END);
      // Scaffold the empty nested query block (`selector { @query {} }`) into the embed
      // now, so the query persists without waiting for the first property.
      const parsed = parseNestedInput(nestedInput);
      if (parsed && parsed.path.length) {
        writeEmptyContext({ path: parsed.path });
      }
      return;
    }
    setTypedContexts((previous) => (previous.includes(query) ? previous : [...previous, query]));
    setContext(query);
    // Scaffold the empty top-level query block (`@query {}`) into the embed now.
    writeEmptyContext({ contextKey: query });
  };
  // Write a property to the embed for the picked selector — its existing rule, or a
  // new one. Also the fallback target when a native value won't apply.
  const writeEmbedProp = (write: PropWrite) => {
    const rule = ruleFor(write.prop);
    return rule ? onSetProp(rule, write.prop, write.value, write.important) : createSelectedRule(write);
  };

  // Native edits go to the picked class style. Webflow accepts nearly any
  // property/value (storing unsupported ones as custom properties), so "regular"
  // and "custom property" are one call; we verify it actually applied and, if not,
  // move the property to custom code (an embed) — the try-native-else-custom-code chain.
  const nativeHandle = () => (nativeModel && selectedNativeIndex !== undefined ? nativeModel.styles[selectedNativeIndex]?.style : undefined);
  // Where a property's edit goes: the layer that currently holds its editable
  // value (native when the class sets it, the picked embed when it fell back);
  // a brand-new property defaults to native-first when the selection allows it.
  const propLayer = (prop: string): SourceKey => {
    // Transitions have no native Designer API — always write them to the embed.
    if (EMBED_ONLY_PROPS.has(prop)) {
      return 'embed';
    }
    // A custom query can't be written natively — always target the embed there.
    if (!nativeContextOk) {
      return 'embed';
    }
    const resolvedProp = resolved?.props.get(prop);
    const origin = resolvedProp?.source === 'selected' ? resolvedProp.selectedOrigin : undefined;
    // The style attribute is not a layer: its own writes never come here
    // (useInlineTarget.ts), and anything else picks a layer as for a new property.
    if (origin === 'embed' || origin === 'native') {
      return origin;
    }
    return canNative ? 'native' : 'embed';
  };
  return { nativeHandle, onAddQuery, propLayer, writeEmbedProp };
}

// Native write attempts, and clearing a coerced value after a failed one.
export function useNativeAttempt(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeOps: ReturnType<typeof useNativeOps>,
) {
  const { selectedRef } = editorRefs;
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { stateKey } = selectionState;
  const { currentContext } = styleContextsHook;
  const { nativeWriteTargetAt } = nativeOps;

  // Webflow's native API rejects hsl()/hsla(), so a value on its way THERE is
  // normalized to rgb. Only there: this used to run on every write, which meant
  // CSS written to a file or an embed — everything, in this app, where native
  // styling is not available at all — could never come out as `hsl(…)`. Picking
  // HSL in the colour picker changed the numbers on screen and left `rgb(224, 4,
  // 4)` in the file, because the notation was converted back out on the way
  // past.
  // Run one native write attempt with the panel busy. The busy flag disables every
  // control — it must always clear, even if the Designer call hangs or throws, or the
  // panel freezes. A throw is a failed attempt, with its message as the reason.
  const attemptNative = async (status: string, attempt: () => Promise<NativeAttempt>): Promise<NativeAttempt> => {
    try {
      setBusyBoth(true);
      setStatus(status);
      return await attempt();
    } catch (error: unknown) {
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    } finally {
      setBusyBoth(false);
    }
  };
  // The failed native write may have left a COERCED value on the class — Webflow stores
  // an unparseable calc()/function as `0` rather than nothing — which would shadow the
  // embed value about to be written (e.g. width stuck at 0px). Clear it first so only
  // the embed declaration applies. Best-effort: a no-op when Webflow stored nothing
  // (the common drop case).
  const clearCoercedNative = async (index: number, prop: string) => {
    try {
      setBusyBoth(true);
      await removeNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), [prop], optionsFor(currentContext, stateKey));
    } catch {
      /* best-effort cleanup */
    } finally {
      setBusyBoth(false);
    }
  };
  return { attemptNative, clearCoercedNative };
}

// Set a property natively, falling back to an embed.
export function useNativeSet(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeAttempt: ReturnType<typeof useNativeAttempt>,
) {
  const translate = useTranslate();
  const { selectedRef } = editorRefs;
  const { setNativeFallback, setStatus } = scanState;
  const { stateKey } = selectionState;
  const { currentContext } = styleContextsHook;
  const { refreshNative } = nativeRefresh;
  const { nativeWriteTargetAt, runNativeOp } = nativeOps;
  const { writeEmbedProp } = addQuery;
  const { attemptNative, clearCoercedNative } = nativeAttempt;

  const nativeSetOrFallback = (index: number, write: PropWrite) => {
    const { prop } = write;
    const value = hslaToRgba(write.value);
    void runNativeOp(async () => {
      setNativeFallback(undefined); // clear any prior fallback notice as this edit begins
      const { applied, reason } = await attemptNative('Saving…', async () => {
        const result = await applyNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), prop, value, optionsFor(currentContext, stateKey));
        return { applied: result.applied, reason: result.error ?? '' };
      });
      if (applied) {
        await refreshNative();
        setStatus('Saved to Webflow class style.'); // i18n-ignore: write-only status, never rendered.
        return;
      }
      await clearCoercedNative(index, prop);
      setStatus(`Couldn’t set ${prop} as a Webflow style${reason ? ` (${reason})` : ''}` + ' — moving it to an embed.');
      // The status line isn't rendered, so surface the reason inline — otherwise the
      // fall-through to an embed is invisible and looks like "it always writes code".
      setNativeFallback(
        reason ? translate('styleModel.embed.hook.nativeApplyFailedReason', { prop, reason }) : translate('styleModel.embed.hook.nativeApplyFailed', { prop }),
      );
      writeEmbedProp({ ...write, value });
    });
  };
  return { nativeSetOrFallback };
}

// Create a class natively, recovering when it already exists.
export function useCreateNativeClass(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
) {
  const { selectedRef } = editorRefs;
  const { stateKey } = selectionState;
  const { nativeModelRef } = nativeState;
  const { currentContext } = styleContextsHook;
  const { refreshNative } = nativeRefresh;
  const { nativeWriteTargetAt } = nativeOps;

  const createNativeClass = async (className: string, write: PropWrite): Promise<NativeAttempt> => {
    const options = optionsFor(currentContext, stateKey);
    const result = await applyNativeToNewBaseClass(selectedRef.current, className, write.prop, write.value, options);
    const reason = result.error ?? '';
    // The class already exists — almost always because the edit landed before the
    // native scan finished, so we didn't yet know `.className` was a real Webflow
    // class (nativeIndex was undefined → it looked creatable). Recover by re-reading and
    // writing to the existing base class instead of wrongly spilling into an embed.
    if (result.applied || !/duplicate/i.test(reason)) {
      return { applied: result.applied, created: result.applied, reason };
    }
    await refreshNative();
    const baseIndex = nativeModelRef.current?.styles.findIndex((entry) => !entry.isCombo && entry.namePath.length === 1 && entry.className === className) ?? -1;
    if (baseIndex < 0) {
      return { applied: false, created: false, reason };
    }
    const retry = await applyNativePropertyAt(selectedRef.current, nativeWriteTargetAt(baseIndex), write.prop, write.value, options);
    return { applied: retry.applied, created: false, reason: retry.error ?? '' };
  };
  return { createNativeClass };
}

// Create a class natively for its first property, falling back to an embed.
export function useNativeCreate(
  scanState: ReturnType<typeof useScanState>,
  nativeRefresh: ReturnType<typeof useNativeRefresh>,
  nativeOps: ReturnType<typeof useNativeOps>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeAttempt: ReturnType<typeof useNativeAttempt>,
  createNativeClassHook: ReturnType<typeof useCreateNativeClass>,
) {
  const translate = useTranslate();
  const { setNativeFallback, setStatus } = scanState;
  const { refreshNative } = nativeRefresh;
  const { runNativeOp } = nativeOps;
  const { writeEmbedProp } = addQuery;
  const { attemptNative } = nativeAttempt;
  const { createNativeClass } = createNativeClassHook;

  // First edit on a class that has no base Style yet: create the base class in
  // Webflow, write the property, then refresh (subsequent edits use the normal
  // native path once the style resolves). Falls back to an embed if creation fails.
  const nativeCreateAndSet = (className: string, write: PropWrite) => {
    const value = hslaToRgba(write.value); // see nativeSetOrFallback
    void runNativeOp(async () => {
      setNativeFallback(undefined);
      const { applied, created, reason } = await attemptNative('Creating Webflow class…', async () => createNativeClass(className, { ...write, value }));
      if (applied) {
        await refreshNative();
        setStatus(created ? `Created Webflow class .${className}.` : 'Saved to Webflow class style.'); // i18n-ignore: write-only status, never rendered.
        return;
      }
      setStatus(`Couldn’t create .${className} as a Webflow class${reason ? ` (${reason})` : ''}` + ' — moving it to an embed.');
      setNativeFallback(
        reason
          ? translate('styleModel.embed.hook.nativeCreateFailedReason', { className, reason })
          : translate('styleModel.embed.hook.nativeCreateFailed', { className }),
      );
      writeEmbedProp({ ...write, value });
    });
  };
  return { nativeCreateAndSet };
}

// Pick a default target for a first edit with no chip selected.
export function useAutoSelect(
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  selectorPick: ReturnType<typeof useSelectorPick>,
) {
  const { nativeModelRef } = nativeState;
  const { snapshot } = elementTokens;
  const { selectActiveSelector } = selectorPick;

  // First edit with no chip selected: pick a default target — the element's first
  // applied Webflow class (edit it natively), else its tag (edit it in an embed) —
  // select it for the UI and return the route to write THIS edit to (state won't
  // update in time). Undefined → nothing to style.
  const autoSelectForEdit = (): { native: number } | { embedSelector: string } | undefined => {
    const styles = nativeModelRef.current?.styles ?? [];
    const baseIndex = styles.findIndex((style) => style.applied);
    const base = styles[baseIndex];
    if (base) {
      selectActiveSelector(`.${base.className}`);
      return { native: baseIndex };
    }
    const tag = snapshot?.tag;
    if (tag) {
      selectActiveSelector(tag);
      return { embedSelector: tag };
    }
    return undefined;
  };
  return { autoSelectForEdit };
}
