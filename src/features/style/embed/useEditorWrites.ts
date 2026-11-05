// Writing a property — set, clear and the live set, with native writes and
// their fallback — and the cards the panel draws: source options, the embed
// navigation, and the selection, context and source cards (EmbedEditor.tsx).

import { useMemo } from 'react';
import { saveEmbedSource } from '../model/toolPreferences';
import { hslaToRgba } from '../model/colorWrite';
import { clampNonNegative } from '../model/cssProperties';
import { contextKeyOf } from '../model/resolved';
import type { ParsedRule } from '../model/styleTypes';
import { optionsFor } from '../model/nativeStyles';
import { embedSourceClassSuffix, type EmbedDocument } from '../model/webflow';
import { type SetProp, type PropWrite, type LiveSetProp, EMPTY_RESOLVED, EMPTY_RULE_MODEL } from './EditorBasics';
import { isSupportedCssValue } from './ResolvedRows';
import { type SourceOption } from './LayoutRows';
import { useBusyState, useScanState, useSelectionState, useNativeState } from './useEditorFoundation';
import { useRefresh } from './useEditorScanning';
import { usePropEdits, useLiveEdits, useRuleActions, useOpenEmbed, useElementTokens } from './useEditorRuleEdits';
import { useActiveSelector, useSelectorPick, useTypedSelector, useFocusProp, useSourceDocument, useRenameQuery, useQuerySuggestions } from './useEditorElement';
import { useStyleContexts, useNativeTarget, useResolved, useSelectorChips, useContextChange } from './useEditorContexts';
import { useNativeOps, useWriteNewRule, useCreateRule, useAddQuery, useNativeSet, useNativeCreate, useAutoSelect } from './useEditorResolution';

// Commit a property to the pick's layer.
export function useSetProp(
  scanState: ReturnType<typeof useScanState>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
  createRule: ReturnType<typeof useCreateRule>,
  addQuery: ReturnType<typeof useAddQuery>,
  nativeSet: ReturnType<typeof useNativeSet>,
  nativeCreate: ReturnType<typeof useNativeCreate>,
  autoSelect: ReturnType<typeof useAutoSelect>,
) {
  const { setStatus } = scanState;
  const { liveOriginRef } = liveEdits;
  const { activeSelector } = activeSelectorHook;
  const { creatableClass } = nativeTarget;
  const { selectedNativeIndex } = resolvedHook;
  const { createSelectedRule } = createRule;
  const { propLayer, writeEmbedProp } = addQuery;
  const { nativeSetOrFallback } = nativeSet;
  const { nativeCreateAndSet } = nativeCreate;
  const { autoSelectForEdit } = autoSelect;

  const setProp: SetProp = (prop, typed, important) => {
    // A gap or a padding cannot go below zero. Here rather than in the fields
    // themselves: a value reaches this point from a typed edit, an arrow step, a
    // drag, a variable pick and the add-property row, and a rule enforced in one
    // field is a rule the other four ways around it don't have.
    const write: PropWrite = { prop, value: clampNonNegative(prop, typed), important };
    // A commit is the new baseline: whatever a live write overwrote on the way here is
    // no longer what "revert" should restore.
    liveOriginRef.current.delete(prop);
    if (!activeSelector) {
      const route = autoSelectForEdit();
      if (route && 'native' in route) {
        nativeSetOrFallback(route.native, write);
        return;
      }
      if (route && 'embedSelector' in route) {
        createSelectedRule(write, route.embedSelector);
        return;
      }
      setStatus('Nothing to style here — add a class in Webflow first.');
      return;
    }
    if (propLayer(prop) === 'native') {
      if (selectedNativeIndex !== undefined) {
        nativeSetOrFallback(selectedNativeIndex, write);
        return;
      }
      if (creatableClass) {
        nativeCreateAndSet(creatableClass, write);
        return;
      }
    }
    writeEmbedProp(write);
  };
  return { setProp };
}

// Clear, revert, and live-set a property.
export function useClearProp(
  selectionState: ReturnType<typeof useSelectionState>,
  propEdits: ReturnType<typeof usePropEdits>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  ruleActions: ReturnType<typeof useRuleActions>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  resolvedHook: ReturnType<typeof useResolved>,
  nativeOps: ReturnType<typeof useNativeOps>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  addQuery: ReturnType<typeof useAddQuery>,
) {
  const { stateKey } = selectionState;
  const { onClearProp } = propEdits;
  const { liveOriginRef } = liveEdits;
  const { onRevertProp } = ruleActions;
  const { currentContext } = styleContextsHook;
  const { selectedNativeIndex } = resolvedHook;
  const { nativeClearAt } = nativeOps;
  const { ruleFor, rulesSetting } = writeNewRuleHook;
  const { propLayer } = addQuery;

  const clearProp = (prop: string | string[]) => {
    const props = Array.isArray(prop) ? prop : [prop];
    props.forEach((prop) => liveOriginRef.current.delete(prop)); // clearing is a commit too
    const nativeProps = props.filter((prop) => propLayer(prop) === 'native');
    const embedProps = props.filter((prop) => propLayer(prop) === 'embed');
    if (nativeProps.length && selectedNativeIndex !== undefined) {
      void nativeClearAt(selectedNativeIndex, nativeProps, optionsFor(currentContext, stateKey));
    }
    // Each rule of the pick loses the properties it sets: clearing only the rule
    // whose value shows would surface the same property from an earlier rule.
    const byRule = new Map<string, { rule: ParsedRule; props: string[] }>();
    for (const embedProp of embedProps) {
      for (const rule of rulesSetting(embedProp)) {
        const entry = byRule.get(rule.ruleId) ?? { rule, props: [] };
        entry.props.push(embedProp);
        byRule.set(rule.ruleId, entry);
      }
    }
    byRule.forEach(({ rule, props: ruleProps }) => onClearProp(rule, ruleProps));
  };
  // Abandon the live writes for `prop` and put back what they overwrote — the dropdown
  // hover-scrub's counterpart to liveSetProp (closing the list without picking).
  const revertProp = (prop: string) => {
    const rule = ruleFor(prop);
    if (propLayer(prop) === 'native' || !rule) {
      return;
    }
    onRevertProp(rule, prop);
  };
  return { clearProp, revertProp };
}

// Live-set a property on the pick’s layer.
export function useLiveSetProp(
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
  liveEdits: ReturnType<typeof useLiveEdits>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeOps: ReturnType<typeof useNativeOps>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  addQuery: ReturnType<typeof useAddQuery>,
  autoSelect: ReturnType<typeof useAutoSelect>,
  clearPropHook: ReturnType<typeof useClearProp>,
  createRule: ReturnType<typeof useCreateRule>,
) {
  const { stateKey } = selectionState;
  const { nativeModelRef } = nativeState;
  const { onLiveSetProps } = liveEdits;
  const { activeSelector } = activeSelectorHook;
  const { currentContext } = styleContextsHook;
  const { nativeLiveSet } = nativeOps;
  const { ruleFor } = writeNewRuleHook;
  const { nativeHandle, propLayer } = addQuery;
  const { autoSelectForEdit } = autoSelect;
  const { revertProp } = clearPropHook;
  const { liveCreateInNestedQuery } = createRule;

  const liveSetProp: LiveSetProp = (propOrProps, typed, important) => {
    const props = typeof propOrProps === 'string' ? [propOrProps] : propOrProps;
    // `undefined` = abandon this property's live writes and put back what they
    // overwrote — the hover-scrub's counterpart (a dropdown closed without picking, a
    // field's edit cancelled). Nothing to undo if no live write happened.
    if (typed === undefined) {
      props.forEach(revertProp);
      return;
    }
    if (!activeSelector) {
      // Select the default target so the blur commit + later edits land on it; live-
      // preview natively when it's a class (an embed rule doesn't exist yet to scrub).
      const route = autoSelectForEdit();
      if (route && 'native' in route) {
        const handle = nativeModelRef.current?.styles[route.native]?.style;
        if (handle) {
          for (const prop of props) {
            const value = clampNonNegative(prop, typed);
            if (isSupportedCssValue(prop, value)) {
              nativeLiveSet(handle, prop, hslaToRgba(value), optionsFor(currentContext, stateKey));
            }
          }
        }
      }
      return;
    }
    const embedWrites: Array<{
      readonly rule: ParsedRule;
      readonly prop: string;
      readonly value: string;
      readonly important: boolean;
    }> = [];
    for (const prop of props) {
      const value = clampNonNegative(prop, typed);
      // Don't push half-typed / invalid values live: the native API can get stuck.
      if (!isSupportedCssValue(prop, value)) {
        continue;
      }
      if (propLayer(prop) === 'native') {
        const handle = nativeHandle();
        if (handle) {
          nativeLiveSet(handle, prop, hslaToRgba(value), optionsFor(currentContext, stateKey));
          continue;
        }
      }
      const rule = ruleFor(prop);
      if (rule) {
        embedWrites.push({ rule, prop, value, important });
      } else {
        liveCreateInNestedQuery({ prop, value, important });
      }
    }
    onLiveSetProps(embedWrites);
  };
  return { liveSetProp };
}

// The source dropdown: every embed, grouped by component.
export function useSourceOptions(
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const { nativeModel } = nativeState;
  const { model } = elementTokens;
  const { currentContext } = styleContextsHook;
  const { creatableClass, embedList } = nativeTarget;
  const { effectiveSource, selectedNativeIndex } = resolvedHook;

  // The name to badge when editing a native class style.
  const nativeStyleName =
    effectiveSource === 'native'
      ? selectedNativeIndex !== undefined && nativeModel
        ? nativeModel.styles[selectedNativeIndex]?.displayName || nativeModel.styles[selectedNativeIndex]?.className || ''
        : creatableClass
      : undefined;
  const sourceNote: string | undefined = undefined;

  // Which embeds carry a rule for this element in the current context (dropdown dot).
  const embedsWithRules = useMemo(() => {
    const set = new Set<string>();
    if (!model || currentContext.embedAtContext === undefined) {
      return set;
    }
    for (const matched of [...model.base, ...model.conditional]) {
      if (contextKeyOf(matched.rule) === currentContext.embedAtContext) {
        set.add(matched.rule.embedKey);
      }
    }
    return set;
  }, [model, currentContext]);

  // The source dropdown: every embed in page order (later embeds win the cascade).
  // Webflow isn't a choice — styles apply natively first and fall back to the
  // picked embed. This just chooses which embed catches that fallback. Page-level
  // embeds lead; component embeds are grouped under a component subheader so it's
  // clear which embeds belong to which component.
  const sourceOptions = useMemo<SourceOption[]>(() => {
    const embedOption = (embedDocument: EmbedDocument, indent = false): SourceOption => ({
      value: embedDocument.source.key,
      label: embedDocument.source.label,
      marked: embedsWithRules.has(embedDocument.source.key),
      fromComponent: embedDocument.source.fromComponent,
      indent,
    });
    const optionList: SourceOption[] = [];
    for (const embedDocument of embedList) {
      if (!embedDocument.source.fromComponent) {
        optionList.push(embedOption(embedDocument));
      }
    }
    const byComponent = new Map<string, EmbedDocument[]>();
    for (const embedDocument of embedList) {
      if (!embedDocument.source.fromComponent) {
        continue;
      }
      const name = embedDocument.source.componentName ?? 'Component';
      byComponent.set(name, [...(byComponent.get(name) ?? []), embedDocument]);
    }
    for (const [name, docs] of byComponent) {
      optionList.push({ value: `__component__${name}`, label: name, heading: true });
      docs.forEach((embedDocument, i) => {
        // List row: group-scoped "Embed #1"; closed trigger: full "Global Styles #1".
        const triggerName = docs.length > 1 ? `${name} #${i + 1}` : name;
        optionList.push({
          ...embedOption(embedDocument, true),
          triggerLabel: `${triggerName}${embedSourceClassSuffix(embedDocument.source)}`,
        });
      });
    }
    return optionList;
  }, [embedList, embedsWithRules]);
  return { nativeStyleName, sourceNote, sourceOptions };
}

// Embed labels and navigation for the provenance chips.
export function useEmbedNav(
  nativeState: ReturnType<typeof useNativeState>,
  openEmbed: ReturnType<typeof useOpenEmbed>,
  sourceOptionsHook: ReturnType<typeof useSourceOptions>,
) {
  const { nativeModel } = nativeState;
  const { openEmbedByKey } = openEmbed;
  const { sourceOptions } = sourceOptionsHook;

  // The full embed label per key (e.g. "Global Styles #1" for a component embed),
  // matching the source dropdown's trigger — used by provenance chips.
  const embedLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of sourceOptions) {
      if (option.heading) {
        continue;
      }
      map.set(option.value, option.triggerLabel ?? option.label);
    }
    return map;
  }, [sourceOptions]);

  // Provided to every ProvenanceList so its embed chips can name (full label) and
  // navigate to the source embed on the canvas.
  const embedNav = useMemo(() => ({ open: openEmbedByKey, labelFor: (key: string) => embedLabelByKey.get(key) ?? key }), [openEmbedByKey, embedLabelByKey]);

  const nativeHasAny = nativeModel?.styles.some((style) => style.propsByContext.size > 0) ?? false;
  return { embedLabelByKey, embedNav, nativeHasAny };
}

// The card's selector props.
export function useSelectionCard(
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  activeSelectorHook: ReturnType<typeof useActiveSelector>,
  selectorPick: ReturnType<typeof useSelectorPick>,
  typedSelector: ReturnType<typeof useTypedSelector>,
  focusPropHook: ReturnType<typeof useFocusProp>,
  selectorChipsHook: ReturnType<typeof useSelectorChips>,
) {
  const { selectedSelectorText } = selectionState;
  const { selectorSuggestions, snapshot } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { selectActiveSelector } = selectorPick;
  const { addTypedSelector, deselect } = typedSelector;
  const { onSelectSelector } = focusPropHook;
  const { selectorChips } = selectorChipsHook;

  const cardSelection = {
    snapshot,
    selectedSelector: activeSelector,
    activePicked: selectedSelectorText !== undefined,
    selectors: selectorChips,
    suggestions: selectorSuggestions,
    activeSelector,
    onSelectActive: selectActiveSelector,
    onDeselect: deselect,
    onAddSelector: addTypedSelector,
    onSelectSelector,
  };
  return { cardSelection };
}

// The card's context and query props.
export function useContextCard(
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  sourceDocumentHook: ReturnType<typeof useSourceDocument>,
  renameQuery: ReturnType<typeof useRenameQuery>,
  querySuggestionsHook: ReturnType<typeof useQuerySuggestions>,
  resolvedHook: ReturnType<typeof useResolved>,
  selectorChipsHook: ReturnType<typeof useSelectorChips>,
  contextChange: ReturnType<typeof useContextChange>,
  addQuery: ReturnType<typeof useAddQuery>,
  embedNavHook: ReturnType<typeof useEmbedNav>,
) {
  const { cssCodeOpen, setCssCodeOpen } = scanState;
  const { context } = selectionState;
  const { model } = elementTokens;
  const { queryUses, sourceDocument } = sourceDocumentHook;
  const { onRenameQuery } = renameQuery;
  const { querySuggestions } = querySuggestionsHook;
  const { resolved } = resolvedHook;
  const { contextInfos, orderedContexts } = selectorChipsHook;
  const { onContextChange } = contextChange;
  const { onAddQuery } = addQuery;
  const { embedLabelByKey } = embedNavHook;

  const cardContexts = {
    cssCodeOpen,
    onToggleCssCode: () => setCssCodeOpen((open) => !open),
    model: model ?? EMPTY_RULE_MODEL,
    resolved: resolved ?? EMPTY_RESOLVED,
    contexts: orderedContexts,
    contextInfos,
    context,
    onContext: onContextChange,
    onAddQuery,
    onRenameQuery,
    queryUses,
    // The name the source pill below shows for the same file, so the two lines agree
    // on what "ContentWrapper" is called.
    sourceLabel: (sourceDocument && embedLabelByKey.get(sourceDocument.source.key)) ?? sourceDocument?.source.label ?? 'this file',
    querySuggestions,
  };
  return { cardContexts };
}

// The card's source and write props.
export function useSourceCard(
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  refreshHook: ReturnType<typeof useRefresh>,
  ruleActions: ReturnType<typeof useRuleActions>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  writeNewRuleHook: ReturnType<typeof useWriteNewRule>,
  setPropHook: ReturnType<typeof useSetProp>,
  clearPropHook: ReturnType<typeof useClearProp>,
  liveSetPropHook: ReturnType<typeof useLiveSetProp>,
  sourceOptionsHook: ReturnType<typeof useSourceOptions>,
) {
  const { busy } = busyState;
  const { phase, scanningMore } = scanState;
  const { pendingKeys, setSourceSelection } = nativeState;
  const { resolving } = refreshHook;
  const { onRemoveRule, onSaveCssRule } = ruleActions;
  const { effectiveSourceSelection } = nativeTarget;
  const { selectedRule } = writeNewRuleHook;
  const { setProp } = setPropHook;
  const { clearProp } = clearPropHook;
  const { liveSetProp } = liveSetPropHook;
  const { nativeStyleName, sourceNote, sourceOptions } = sourceOptionsHook;

  const cardSource = {
    sourceValue: effectiveSourceSelection,
    sourceOptions,
    onSourceChange: (value: string) => {
      setSourceSelection(value);
      saveEmbedSource(value);
    },
    sourceNote,
    nativeStyleName,
    loading: phase === 'scanning' || scanningMore,
    resolving,
    busy,
    pending: selectedRule ? pendingKeys.has(selectedRule.embedKey) : false,
  };
  const cardWrites = {
    setProp,
    clearProp,
    liveSetProp,
    onAdd: setProp,
    onSaveCssRule,
    onRemoveRule,
  };
  return { cardSource, cardWrites };
}
