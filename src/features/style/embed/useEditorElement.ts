// The selected element as the editor reads it: its default token, the native
// read and its cache, the active selector, picking and typing one, focusing a
// property, the source document, and the queries it offers — renamed, keyed
// and suggested (EmbedEditor.tsx).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultSelectorTokens, selectorToClassTokens, tokensToSelector } from '../model/elementTokens';
import { stateForSelector, STATES, type ContextKey } from '../model/resolved';
import { listAtRuleBlocks, parseNestedInput, renameAtRuleQuery, atRuleQueryText, queryKey, splitQuery } from '../model/css';
import { canonicalCompound } from '../model/selectors';
import { findNode, getHost, onHostChange } from '../model/host';
import { readNativeStyleByName, readNativeStyles, resolveIdentityElement, writeEmbedDocument, type EmbedDocument } from '../model/webflow';
import type { NativeModel } from '../model/styleTypes';
import { standaloneNativeClass } from './EditorBasics';
import { PLACEMENT_END, type ClassPlacement } from '../../../editor/classAttr';
import { loneTypedClass, type NestedInput, nativeModelCache, pseudoPickFor, rememberTypedPath, type TypedPaths, usePseudoTarget } from './editorModel';
import { asQuery, type QuerySuggestion, COMMON_QUERIES } from './SelectorPicker';
import { useEditorRefs, useBusyState, useScanState, useSelectionState, useNativeState, usePendingWrites } from './useEditorFoundation';
import { assert } from '../../../../shared/core/assert';
import { useRefreshDerived } from './useEditorScanning';
import { useApplyEdit, useElementTokens } from './useEditorRuleEdits';

// Re-default the picked selector when the element changes.
export function useTokenDefault(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { setNativeFallback } = scanState;
  const { defaultTokensRef, pendingDefaultRef, setSelectedSelectorText, setSelectedTokens, setStateKey, tokenIdentityRef, typedClassRef } = selectionState;
  const { tokens } = elementTokens;

  // Re-default the picked selector when the element changes: the element's FIRST
  // class → else last data attribute → else the tag. Also reset context/state.
  //
  // It used to be every class the element has, joined — Webflow's model, where
  // a combo IS the thing being styled. Here it meant the first property written
  // created `.layout.card.theme-dark.flex-grow.theme-brand { … }`, and because
  // the combo then counted as "already styled", the upgrade below kept it and
  // every property after it landed there too. A five-class rule nothing else can
  // reuse, built one property at a time, from a default nobody chose.
  //
  // The primary class is what a class system is authored against; a combo is a
  // deliberate act, so it takes picking that chip.
  useEffect(() => {
    const identity = tokens.map((token) => token.name).join('|');
    if (identity === tokenIdentityRef.current) {
      return;
    }
    tokenIdentityRef.current = identity;
    const typedClass = typedClassRef.current;
    if (typedClass !== undefined) {
      if (tokens.some((token) => token.name === `class:${typedClass}`)) {
        // The class the user typed reached the element: the same element, with
        // the selector they chose already active.
        typedClassRef.current = undefined;
        return;
      }
    }
    const next = defaultSelectorTokens(tokens);
    setSelectedTokens(next);
    setSelectedSelectorText(undefined);
    defaultTokensRef.current = next;
    pendingDefaultRef.current = true;
    // Keep the current query (context) — switching elements stays on the same
    // breakpoint/query so you can style a different element within it. It only
    // changes when you pick a different query yourself.
    setStateKey('');
    // Keep the picked source embed too: switching elements shouldn't forget where
    // the user chose to add new styles. (It falls back to the first embed only if
    // that source isn't available for the new element — see effectiveSourceSel.)
    setNativeFallback(undefined);
  }, [
    tokens,
    defaultTokensRef,
    pendingDefaultRef,
    setNativeFallback,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    tokenIdentityRef,
    typedClassRef,
  ]);

  // The element's identity (tag + classes + attrs) as a stable key — drives the
  // native-style read so it re-runs on selection or class changes, not on every
  // background embed refresh.
  const elementIdentity = useMemo(() => tokens.map((token) => token.name).join('|'), [tokens]);
  return { elementIdentity };
}

// Serve a cached native model for an element's class signature.
export function useCachedNative(nativeState: ReturnType<typeof useNativeState>) {
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // Read the selected element's native class styles across every Webflow breakpoint
  // AND every interaction state — the selector-chip picker lists stateful selectors
  // (`.test:hover`) regardless of the current view, so all states must be read.
  // Re-reads only on element / class change (not on state, which is now derived).
  // Instant: serve the cached model for this class-signature while re-reading in the
  // background, so re-selecting an element doesn't re-lag its native chips.
  const serveCachedNative = useCallback(
    (identity: string) => {
      const cached = nativeModelCache.get(identity);
      if (!cached && nativeModelRef.current) {
        // A class change on the same element: the model in hand describes the old
        // class list, so it can't stand in while the new one loads.
        nativeModelRef.current = undefined;
        nativeIdentityRef.current = '';
        setNativeModel(undefined);
      }
      if (cached) {
        // Show the cached chips immediately, but do NOT advance nativeIdentityRef here:
        // setNativeModel is async, so the ref would outrun the model the smart-default
        // effect still sees this render and let it default off a stale nativeModel. The
        // ref only advances in the async read below, where it moves with the model.
        nativeModelRef.current = cached;
        setNativeModel(cached);
      }
      return cached;
    },
    [nativeIdentityRef, nativeModelRef, setNativeModel],
  );
  return { serveCachedNative };
}

// Read the selected element's native class styles.
export function useNativeRead(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
  tokenDefault: ReturnType<typeof useTokenDefault>,
  cachedNative: ReturnType<typeof useCachedNative>,
) {
  const { selectedRef } = editorRefs;
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;
  const { elementIdentity } = tokenDefault;
  const { serveCachedNative } = cachedNative;

  useEffect(() => {
    const selectedElement = selectedRef.current;
    if (!selectedElement) {
      setNativeModel(undefined);
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      return;
    }
    const cached = serveCachedNative(elementIdentity);
    let cancelled = false;
    // On a cold read (no cache), stream each scan phase into the UI so the selected
    // element's class styles + selectors appear as they're found, not after the whole
    // scan. On a cache hit the shown model is already complete, so skip partials (they
    // would flash a less-complete model) and just swap in the fresh final model.
    const onPartial = cached
      ? undefined
      : (partial: NativeModel) => {
          if (cancelled) {
            return;
          }
          // Update the ref too, so a write mid-scan targets what's shown. Leave
          // nativeIdentityRef to the final model, so the smart-default selection is picked
          // off the COMPLETE model rather than an early partial.
          nativeModelRef.current = partial;
          setNativeModel(partial);
        };
    // Read native styles from the RESOLVED identity element (a component instance's
    // root), not the raw selection — the instance wrapper carries no classes of its
    // own, so reading it directly yields nothing outside the component.
    void resolveIdentityElement(selectedElement)
      .then((identity) => readNativeStyles(identity, STATES, onPartial))
      .then((model) => {
        if (cancelled) {
          return;
        }
        nativeModelCache.set(elementIdentity, model);
        nativeModelRef.current = model;
        nativeIdentityRef.current = elementIdentity;
        setNativeModel(model);
      });
    return () => {
      cancelled = true;
    };
  }, [elementIdentity, serveCachedNative, nativeIdentityRef, nativeModelRef, selectedRef, setNativeModel]);
}

// The selector being edited, and a typed standalone class's native styles.
export function useActiveSelector(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { phase } = scanState;
  const { selectedSelectorText, selectedTokens } = selectionState;
  const { activeSelectorRef, nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;
  const { tokens } = elementTokens;

  const selectedSelector = useMemo(() => tokensToSelector(selectedTokens, tokens), [selectedTokens, tokens]);
  // The full selector currently being edited: an explicit chip/typed pick when set,
  // else the one composed from the token chips.
  const activeSelector = selectedSelectorText ?? selectedSelector;
  useEffect(() => {
    activeSelectorRef.current = activeSelector;
  }, [activeSelector, activeSelectorRef]);

  // With no canvas selection, a typed standalone class is still a complete native
  // target: look it up directly in the project's Style API so its values and state
  // styles can be shown and edited just like an applied class.
  const standaloneClass = phase === 'no-selection' ? standaloneNativeClass(activeSelector) : undefined;
  useEffect(() => {
    if (phase !== 'no-selection') {
      return;
    }
    if (!standaloneClass) {
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      setNativeModel(undefined);
      return;
    }
    let cancelled = false;
    void readNativeStyleByName(standaloneClass, STATES).then((next) => {
      if (cancelled) {
        return;
      }
      nativeModelRef.current = next;
      nativeIdentityRef.current = `standalone:${standaloneClass}`;
      setNativeModel(next);
    });
    return () => {
      cancelled = true;
    };
  }, [phase, standaloneClass, nativeIdentityRef, nativeModelRef, setNativeModel]);
  return { activeSelector };
}

// Pick a selector, or a typed nested one, as the edit target.
export function useSelectorPick(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
) {
  const { selectedRef } = editorRefs;
  const { pendingDefaultRef, setContext, setSelectedSelectorText, setSelectedTokens, setStateKey } = selectionState;
  const { tokens } = elementTokens;

  // Pick any matched selector (a chip, an override-note jump, or a typed one) as the
  // edit target. Sync the token pick + interaction state so native editing (class +
  // pseudo) still resolves; a complex selector clears the tokens (embed-only) and
  // its rule is created in the selected embed on first edit.
  // Queries typed into the add-selector field that may not exist in an embed yet —
  // kept so they're selectable in the dropdown until the rule is created.
  const [typedContexts, setTypedContexts] = useState<string[]>([]);
  // The nesting paths of typed selectors (`.hero { @container { .title } }`), so each
  // one's first edit writes NESTED source into the embed rather than a flat selector.
  const typedPathsRef = useRef<TypedPaths>(new Map());
  const selectActiveSelector = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      pendingDefaultRef.current = false;
      setSelectedSelectorText(trimmed);
      const simple = canonicalCompound(trimmed).simple;
      const matchedTokens = simple ? selectorToClassTokens(trimmed, tokens) : undefined;
      const standalone = !selectedRef.current ? standaloneNativeClass(trimmed) : undefined;
      setSelectedTokens(matchedTokens ?? (standalone ? [`class:${standalone}`] : []));
      setStateKey(stateForSelector(trimmed));
    },
    [tokens, pendingDefaultRef, selectedRef, setSelectedSelectorText, setSelectedTokens, setStateKey],
  );
  // Add a selector typed in the field — supports CSS nesting / a query, e.g.
  // `.hero { .title }`, `.hero { @container (width < 50em) { .title } }`, or
  // `.hero { @container (width < 50em) }`: resolve to the deepest selector + its query
  // context and select it there. A plain selector (no braces) is used as-is.
  // A selector typed with nesting / a query: select its deepest selector in its query
  // context, and remember the path so the first edit writes NESTED source, not a flat
  // rule.
  const selectNested = useCallback(
    (parsed: NestedInput) => {
      const contextKey = parsed.atContext.join(' › ');
      if (contextKey) {
        setTypedContexts((previous) => (previous.includes(contextKey) ? previous : [...previous, contextKey]));
        setContext(contextKey);
      } else {
        setContext('');
      }
      selectActiveSelector(parsed.selector);
      if (parsed.path.length >= 2) {
        rememberTypedPath(typedPathsRef.current, parsed.selector, contextKey, parsed.path);
      }
    },
    [selectActiveSelector, setContext],
  );
  return { selectActiveSelector, selectNested, setTypedContexts, typedContexts, typedPathsRef };
}

// Add a typed selector, or deselect.
export function useTypedSelector(
  editorRefs: ReturnType<typeof useEditorRefs>,
  selectionState: ReturnType<typeof useSelectionState>,
  applyEditHook: ReturnType<typeof useApplyEdit>,
  selectorPick: ReturnType<typeof useSelectorPick>,
) {
  const { primedRef } = editorRefs;
  const { pendingDefaultRef, setSelectedSelectorText, setSelectedTokens, setStateKey, typedClassRef } = selectionState;
  const { classGatesRef } = applyEditHook;
  const { selectActiveSelector, selectNested } = selectorPick;

  const addTypedSelector = useCallback(
    (input: string, placement: ClassPlacement) => {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }
      if (trimmed.includes('{')) {
        const parsed = parseNestedInput(trimmed);
        if (parsed) {
          selectNested(parsed);
          return;
        }
      }
      const loneClass = loneTypedClass(trimmed);
      if (loneClass !== undefined) {
        typedClassRef.current = loneClass;
        const gate = getHost().addClass?.(loneClass, placement);
        // The rule this selector will get depends on the page edit: its first
        // write waits for that edit's outcome (step 6, plan §3.3).
        if (gate) {
          classGatesRef.current.set(trimmed, gate);
        }
        // The element itself changed, so the matches the canvas gave us for these
        // same selectors no longer hold — ask again on the next refresh.
        primedRef.current = undefined;
      }
      selectActiveSelector(trimmed);
    },
    [selectActiveSelector, selectNested, classGatesRef, primedRef, typedClassRef],
  );
  // Deselect (click the active chip again): no selector is picked, so the panel
  // shows every property's cascade winner read-only. The first edit re-picks a
  // default target (see autoSelectForEdit).
  const deselect = useCallback(() => {
    pendingDefaultRef.current = false;
    setSelectedTokens([]);
    setSelectedSelectorText(undefined);
    setStateKey('');
  }, [pendingDefaultRef, setSelectedSelectorText, setSelectedTokens, setStateKey]);
  return { addTypedSelector, deselect };
}

// Jump to a selector and focus one of its property fields.
export function useFocusProp(editorRefs: ReturnType<typeof useEditorRefs>, selectorPick: ReturnType<typeof useSelectorPick>) {
  const { rootRef } = editorRefs;
  const { selectActiveSelector } = selectorPick;

  // A pending "focus this property's input" request — set when you click an override
  // tag, consumed once the newly-picked selector has rendered.
  const [focusProp, setFocusProp] = useState<string | undefined>(undefined);
  // Jump the pick to the selector that overrides the current value (e.g. click
  // `.test.is-2` in the override note) so you can edit whatever actually wins, then
  // focus that property's field.
  const onSelectSelector = useCallback(
    (selectorText: string, prop?: string) => {
      selectActiveSelector(selectorText);
      if (prop) {
        setFocusProp(prop);
      }
    },
    [selectActiveSelector],
  );
  useEffect(() => {
    if (!focusProp) {
      return;
    }
    // Wait a frame so the re-picked selector's fields have rendered, then focus.
    const raf = requestAnimationFrame(() => {
      const field = rootRef.current?.querySelector<HTMLElement>(`[data-prop="${focusProp}"]`);
      field?.focus();
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        field.select();
      }
      setFocusProp(undefined);
    });
    return () => cancelAnimationFrame(raf);
  }, [focusProp, rootRef]);
  return { onSelectSelector };
}

// The stylesheet new rules land in, and its queries' uses.
export function useSourceDocument(nativeState: ReturnType<typeof useNativeState>, pendingWrites: ReturnType<typeof usePendingWrites>) {
  const { sourceSelection } = nativeState;
  const { documentByKey } = pendingWrites;

  // The stylesheet a new rule would land in: the user's pick, or the first embed
  // in page order — the same default `effectiveSourceSel` settles on below, worked
  // out here because the queries dropdown needs it before that line runs.
  const sourceDocument = useMemo<EmbedDocument | undefined>(() => {
    if (sourceSelection && documentByKey.has(sourceSelection)) {
      return documentByKey.get(sourceSelection);
    }
    return [...documentByKey.values()].sort((left, right) => left.source.order - right.source.order)[0];
  }, [sourceSelection, documentByKey]);
  // How many blocks in that stylesheet each query is written in. Drives the edit
  // pencil in the query dropdown (a query this file doesn't hold can't be renamed
  // from here) and the "3 blocks in ContentWrapper" count on the rename form.
  const queryUses = useMemo(() => {
    const uses = new Map<string, number>();
    if (!sourceDocument) {
      return uses;
    }
    for (const region of sourceDocument.regions) {
      region.root?.walkAtRules((at) => {
        const name = at.name.toLowerCase();
        if (name !== 'media' && name !== 'supports' && name !== 'container') {
          return;
        }
        // Keyed so two spellings of one query count as one — the pencil on
        // either row then reports, and renames, both.
        const text = queryKey(atRuleQueryText(at));
        uses.set(text, (uses.get(text) ?? 0) + 1);
      });
    }
    return uses;
  }, [sourceDocument]);
  return { queryUses, sourceDocument };
}

// Rename a query everywhere the source stylesheet spells it.
export function useRenameQuery(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  pendingWrites: ReturnType<typeof usePendingWrites>,
  refreshDerivedHook: ReturnType<typeof useRefreshDerived>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
) {
  const { setBusyBoth } = busyState;
  const { setStatus } = scanState;
  const { setContext } = selectionState;
  const { settleEmbedWrite } = pendingWrites;
  const { refreshDerived } = refreshDerivedHook;
  const { setTypedContexts } = selectorPick;
  const { sourceDocument } = sourceDocumentHook;

  // Rename a query everywhere the source stylesheet spells it. A breakpoint lives
  // in a file as several identical `@media` lines — changing one of them by hand
  // splits the breakpoint in two — so this rewrites all of them in one write, and
  // the panel follows the query it was showing to its new name.
  const onRenameQuery = (from: string, to: string) => {
    const embedDocument = sourceDocument;
    if (!embedDocument) {
      return;
    }
    const next = asQuery(to);
    if (!splitQuery(next)) {
      setStatus('A query starts with @ — @media, @container or @supports.');
      return;
    }
    if (next === from) {
      return;
    }
    void (async () => {
      setBusyBoth(true);
      setStatus('Renaming query…');
      // try/finally so a throw mid-rename can't leave every button disabled.
      try {
        let count = 0;
        for (const region of embedDocument.regions) {
          count += renameAtRuleQuery(region, from, next);
        }
        if (!count) {
          setStatus('That query isn’t in this file any more.');
          return;
        }
        await refreshDerived();
        const result = await writeEmbedDocument(embedDocument);
        if (!settleEmbedWrite(embedDocument, result, 'query')) {
          return;
        }
        // The context key is the at-rule chain; only the renamed link changes, so
        // a nested context stays selected too.
        const swap = (key: ContextKey) =>
          key
            .split(' › ')
            .map((part) => (part === from ? next : part))
            .join(' › ');
        setTypedContexts((previous) => previous.map(swap));
        setContext((previous) => swap(previous));
        setStatus(count === 1 ? `Renamed to ${next}.` : `Renamed ${count} blocks to ${next}.`);
      } finally {
        setBusyBoth(false);
      }
    })();
  };
  return { onRenameQuery };
}

// Every embed query the element could switch to.
export function useContextKeys(
  pendingWrites: ReturnType<typeof usePendingWrites>,
  elementTokens: ReturnType<typeof useElementTokens>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
) {
  const { documentByKey } = pendingWrites;
  const { model } = elementTokens;
  const { typedContexts } = selectorPick;
  const { sourceDocument } = sourceDocumentHook;

  // Every embed query the picked element could switch to: Base + each
  // @media/@container block in the embeds whose rules match this element.
  const allContextKeys = useMemo<ContextKey[]>(() => {
    const keys: ContextKey[] = [''];
    const seen = new Set<ContextKey>(['']);
    const take = (embedDocument: EmbedDocument) => {
      for (const region of embedDocument.regions) {
        for (const block of listAtRuleBlocks(region)) {
          const contextLabel = block.atContext.join(' › ');
          if (!seen.has(contextLabel)) {
            seen.add(contextLabel);
            keys.push(contextLabel);
          }
        }
      }
    };
    if (model) {
      const matchedDocumentKeys = new Set([...model.base, ...model.conditional].map((matched) => matched.rule.embedKey));
      for (const [key, embedDocument] of documentByKey) {
        if (!matchedDocumentKeys.has(key)) {
          continue;
        }
        take(embedDocument);
      }
    }
    // Every query the file being written into already uses, whether or not this
    // element has a rule in one. That dropdown is where a query is chosen to
    // write into, and a stylesheet's own queries are the ones worth offering: a
    // component with a `prefers-reduced-motion` block should offer it on every
    // element in that component, not only on the ones already inside it.
    if (sourceDocument) {
      take(sourceDocument);
    }
    // Queries typed into the add-selector field (may not exist in any embed yet).
    for (const typedContext of typedContexts) {
      if (!seen.has(typedContext)) {
        seen.add(typedContext);
        keys.push(typedContext);
      }
    }
    return keys;
  }, [model, documentByKey, typedContexts, sourceDocument]);
  return { allContextKeys };
}

// Suggestions for the add-query form.
export function useQuerySuggestions(pendingWrites: ReturnType<typeof usePendingWrites>) {
  const { documentByKey } = pendingWrites;

  // Suggestions for the "Add query" form: every @media/@container/@supports already
  // used ANYWHERE in the project's embeds (labeled "used"), then a curated set of
  // common queries — deduped (normalized), project ones first.
  const querySuggestions = useMemo<QuerySuggestion[]>(() => {
    const seen = new Set<string>();
    const out: QuerySuggestion[] = [];
    const add = (query: string, kind: string) => {
      const norm = query.trim();
      const key = norm.replace(/\s+/g, ' ').toLowerCase();
      if (!norm || seen.has(key)) {
        return;
      }
      seen.add(key);
      out.push({ query: norm, kind });
    };
    for (const embedDocument of documentByKey.values()) {
      for (const region of embedDocument.regions) {
        // Each LINK of a nesting chain, not the chain — `@media A › @supports B`
        // is how the panel names a context, but only `@media A` and `@supports B`
        // are queries somebody can write into a file.
        for (const block of listAtRuleBlocks(region)) {
          for (const part of block.atContext) {
            add(part, 'used');
          }
        }
      }
    }
    for (const common of COMMON_QUERIES) {
      add(common.query, common.kind);
    }
    // Size first. Breakpoints are what this list is reached for nearly every time
    // — a layout has several and they get edited together — while hover, pointer
    // and the prefers-* queries are set once and left. Sorting is stable, so
    // within each group the file's own queries still come before the suggested
    // ones, in the order the file has them.
    const bySize = (query: string) => (/@container\b/.test(query) || /\b(width|height)\b/.test(query) ? 0 : 1);
    return out.sort((left, right) => bySize(left.query) - bySize(right.query));
  }, [documentByKey]);
  return { querySuggestions };
}

// A ::before or ::after picked in the navigator: once its element is the
// selection, pick its pseudo-element's selector the way typing it would.
// Each request is handled once (by its serial), and waits while the element
// is not yet the selection.
export function usePseudoRequest(
  typedSelector: ReturnType<typeof useTypedSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  elementTokens: ReturnType<typeof useElementTokens>,
  selectionState: ReturnType<typeof useSelectionState>,
) {
  const { addTypedSelector } = typedSelector;
  const { selectActiveSelector } = selectorPick;
  const { model, snapshot } = elementTokens;
  const { defaultTokensRef, pendingDefaultRef, setSelectedSelectorText, setSelectedTokens } = selectionState;
  const [request, setRequest] = useState(() => getHost().pseudoRequest);
  useEffect(() => onHostChange(() => setRequest(getHost().pseudoRequest)), []);
  const handledRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (request === undefined || handledRef.current === request.serial) {
      return;
    }
    const host = getHost();
    if (host.selectedId !== request.nodeId) {
      return;
    }
    const pick = pseudoPickFor(findNode(host.nodes, request.nodeId), request.pseudo, { snapshot, model });
    if (pick?.kind === 'wait') {
      return; // The panel's rules are still another element's.
    }
    handledRef.current = request.serial;
    if (pick?.kind === 'existing') {
      selectActiveSelector(pick.selector);
    } else if (pick?.kind === 'typed') {
      addTypedSelector(pick.input, PLACEMENT_END);
    }
  }, [request, snapshot, model, addTypedSelector, selectActiveSelector]);

  // Leaving the layer for its own element (the element's row, same selection):
  // the pseudo-element's selector is no longer the target, so the panel goes
  // back to the element's default pick, as selecting the element does.
  const target = usePseudoTarget();
  const heldTargetRef = useRef(target);
  useEffect(() => {
    const held = heldTargetRef.current;
    heldTargetRef.current = target;
    if (held === undefined) {
      return;
    }
    if (target !== undefined) {
      return;
    }
    assert(held !== target, 'usePseudoRequest: the layer changed');
    setSelectedTokens(defaultTokensRef.current);
    setSelectedSelectorText(undefined);
    pendingDefaultRef.current = true;
  }, [target, defaultTokensRef, pendingDefaultRef, setSelectedSelectorText, setSelectedTokens]);
}
