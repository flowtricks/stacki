// Writing a property — set, clear and the live set, with native writes and
// their fallback — and the cards the panel draws: source options, the embed
// navigation, and the selection, context and source cards (EmbedEditor.tsx).

import { CREATE_STYLE_TAG_KEY } from '../model/newStyleTarget';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { useEffect, useMemo, useRef } from 'react';
import { saveEmbedSource } from '../model/toolPreferences';
import { hslaToRgba } from '../model/colorWrite';
import { writtenValue } from '../model/lengthUnit';
import { contextKeyOf, ruleOnLayer } from '../model/resolved';
import { parseImportant } from '../model/styleDisplay';
import { HOVER_STYLE_LIMITS, HOVER_STYLE_MESSAGE, parseHoverStyleMessage, type HoverDeclaration } from '../../../../shared/properties/liveRules';
import { hoverStyle } from '../model/liveRuleEdits';
import { assert } from '../../../../shared/core/assert';
import { getHost } from '../model/host';
import type { PreviewProp } from '../connectFieldHelpers';
import { pseudoPickPending, usePanelLayer } from './editorModel';
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
    // A pick (or any write) of a previewed property takes the preview's place: the canvas keeps it until
    // the page holds the written value, so the old one never flashes between the hover and the save.
    hoverStyle.settle(prop, writtenValue(prop, typed));
    // A gap or a padding cannot go below zero. Here rather than in the fields
    // themselves: a value reaches this point from a typed edit, an arrow step, a
    // drag, a variable pick and the add-property row, and a rule enforced in one
    // field is a rule the other four ways around it don't have. The project's
    // length unit is held here for the same reason (model/lengthUnit.ts).
    const write: PropWrite = { prop, value: writtenValue(prop, typed), important };
    // A commit is the new baseline: whatever a live write overwrote on the way here is
    // no longer what "revert" should restore.
    liveOriginRef.current.delete(prop);
    if (pseudoPickPending(activeSelector)) {
      setStatus('Reading this pseudo-element’s rules. Try that again in a moment.'); // i18n-ignore: write-only status, never rendered.
      return undefined;
    }
    if (!activeSelector) {
      const route = autoSelectForEdit();
      if (route && 'native' in route) {
        return nativeSetOrFallback(route.native, write);
      }
      if (route && 'embedSelector' in route) {
        return createSelectedRule(write, route.embedSelector);
      }
      setStatus('Nothing to style here — add a class in Webflow first.'); // i18n-ignore: write-only status, never rendered.
      return undefined;
    }
    if (propLayer(prop) === 'native') {
      if (selectedNativeIndex !== undefined) {
        return nativeSetOrFallback(selectedNativeIndex, write);
      }
      if (creatableClass) {
        return nativeCreateAndSet(creatableClass, write);
      }
    }
    return writeEmbedProp(write);
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
  const { propLayer, supersedeFirstTagWrite } = addQuery;

  // Resolves once every write has finished and the model has been rebuilt from it, so the
  // panel knows when its optimistic cleared look (useOptimisticEdits.ts) can hand over.
  const clearProp = (prop: string | string[]): Promise<void> => {
    const props = Array.isArray(prop) ? prop : [prop];
    // Clearing is a write too; the page then computes the property's own cascade, not the preview.
    hoverStyle.clear(props);
    const settled: Promise<unknown>[] = [];
    props.forEach((prop) => liveOriginRef.current.delete(prop)); // clearing is a commit too
    const nativeProps = props.filter((prop) => propLayer(prop) === 'native');
    const embedProps = props.filter((prop) => propLayer(prop) === 'embed');
    if (nativeProps.length && selectedNativeIndex !== undefined) {
      settled.push(nativeClearAt(selectedNativeIndex, nativeProps, optionsFor(currentContext, stateKey)));
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
    // A clear is newer than a value still waiting for the page's first tag (firstTagLane.ts).
    for (const embedProp of embedProps) {
      supersedeFirstTagWrite(embedProp);
    }
    byRule.forEach(({ rule, props: ruleProps }) => settled.push(onClearProp(rule, ruleProps)));
    return Promise.all(settled).then(() => undefined);
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
    // Typing over a preview replaces it with what is typed, which the live write shows.
    hoverStyle.clear(props);
    // `undefined` = abandon this property's live writes and put back what they
    // overwrote — the hover-scrub's counterpart (a dropdown closed without picking, a
    // field's edit cancelled). Nothing to undo if no live write happened.
    if (typed === undefined) {
      props.forEach(revertProp);
      return;
    }
    // The commit says why nothing lands yet (useSetProp).
    if (pseudoPickPending(activeSelector)) {
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
            const value = writtenValue(prop, typed);
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
      const value = writtenValue(prop, typed);
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
  const previewProp = useCanvasPreview({ stateKey, activeSelector });
  return { liveSetProp, previewProp };
}

// Every hover preview of the panel: the hovered value shown on the canvas and nowhere else (a picker row,
// a dropdown option). It goes to the frame as a hover style (shared/properties/liveRules.ts), set inline
// on the selected element, and no save follows: nothing is mutated, written, put in history or marked
// dirty, so taking it back is only telling the frame to put the element's own style back, and a restore
// can never race a write. Fields and dropdowns reach it through PreviewPropContext with liveSetProp's own
// shape, so a hover-scrub that used to call liveSetProp calls this instead; `undefined` takes it back. A
// state or pseudo-element context has no element to show it on: there the control alone shows it.
function useCanvasPreview({ stateKey, activeSelector }: { readonly stateKey: string; readonly activeSelector: string | undefined }): PreviewProp {
  // Leaving the panel with a preview still up (a project switch) puts the element's own style back.
  useEffect(() => () => hoverStyle.clear(hoverStyle.showing()), []);
  return (propOrProps, typed, important) => {
    const props: readonly string[] = typeof propOrProps === 'string' ? [propOrProps] : propOrProps;
    assert(props.length > 0, 'Canvas preview: a preview names a property');
    const shown = typed === undefined ? undefined : hoverDeclarationsOf(props, typed, { important, stateKey, activeSelector });
    if (shown === undefined) {
      hoverStyle.clear(props);
      return;
    }
    hoverStyle.show(shown.path, shown.declarations);
    assert(hoverStyle.showing().length === shown.declarations.length, 'Canvas preview: the shown properties are remembered');
  };
}

// What the frame shows for `typed` on the selected element, or undefined when there is nowhere to show
// it: no selection, a value a property does not take, a state or pseudo-element context.
function hoverDeclarationsOf(
  props: readonly string[],
  typed: string,
  { important, stateKey, activeSelector }: { readonly important: boolean; readonly stateKey: string; readonly activeSelector: string | undefined },
): { readonly path: string; readonly declarations: readonly HoverDeclaration[] } | undefined {
  if (stateKey.length > 0) {
    return undefined;
  }
  if (activeSelector !== undefined) {
    if (activeSelector.includes('::')) {
      return undefined;
    }
  }
  const host = getHost();
  const nodeId = host.selectedId;
  if (nodeId === undefined) {
    return undefined;
  }
  const path = host.pathOf?.(nodeId);
  if (path === undefined) {
    return undefined;
  }
  // A field's text may carry its own flag (`12px !important`); a dropdown passes it apart.
  const parsed = parseImportant(typed.trim());
  const declarations: HoverDeclaration[] = [];
  for (const prop of props.slice(0, HOVER_STYLE_LIMITS.declarationsMax)) {
    const value = writtenValue(prop, parsed.value);
    if (value.length === 0) {
      return undefined;
    }
    // A half-made value is not sent: the frame would drop the declaration and show nothing.
    if (!isSupportedCssValue(prop, value)) {
      return undefined;
    }
    declarations.push({ property: prop, value, important: important || parsed.important });
  }
  // Parsed as the frame will parse it, so the panel never sends what the frame refuses.
  const message = parseHoverStyleMessage({ type: HOVER_STYLE_MESSAGE, op: 'show', path, declarations });
  return message?.op === 'show' ? { path: message.path, declarations: message.declarations } : undefined;
}

// The source dropdown: every embed, grouped by component.
export function useSourceOptions(
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  styleContextsHook: ReturnType<typeof useStyleContexts>,
  nativeTarget: ReturnType<typeof useNativeTarget>,
  resolvedHook: ReturnType<typeof useResolved>,
) {
  const translate = useTranslate();
  const { nativeModel } = nativeState;
  const { model } = elementTokens;
  const { currentContext } = styleContextsHook;
  const { createOffered, creatableClass, embedList } = nativeTarget;
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
  const layer = usePanelLayer();
  const embedsWithRules = useMemo(() => {
    const set = new Set<string>();
    if (!model || currentContext.embedAtContext === undefined) {
      return set;
    }
    for (const matched of [...model.base, ...model.conditional]) {
      if (contextKeyOf(matched.rule) === currentContext.embedAtContext && ruleOnLayer(matched, layer)) {
        set.add(matched.rule.embedKey);
      }
    }
    return set;
  }, [model, currentContext, layer]);

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
    // First in the list: where a new selector goes when the page has no `<style>` tag of its own.
    if (createOffered) {
      optionList.push({ value: CREATE_STYLE_TAG_KEY, label: translate('styleModel.embed.source.createStyleTag', { tag: '<style>' }), create: true });
    }
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
      const name = embedDocument.source.componentName ?? translate('styleModel.embed.source.component');
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
  }, [createOffered, embedList, embedsWithRules, translate]);
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
  const { scan, selectorSuggestions, snapshot } = elementTokens;
  const { activeSelector } = activeSelectorHook;
  const { selectActiveSelector } = selectorPick;
  const { addTypedSelector, deselect } = typedSelector;
  const { onSelectSelector } = focusPropHook;
  const { selectorChips } = selectorChipsHook;

  const cardSelection = {
    snapshot,
    selectedSelector: activeSelector,
    activePicked: selectedSelectorText !== undefined,
    // No scan at all (the panel's first moments) has nothing on its way to hold for.
    selectionSettled: scan === undefined || scan.settled,
    // Set by a change of element until its first settled answer (ScanState.awaitingFirstAnswer). Until then
    // the sections hold what they last showed (StyleCard HeldBody) rather than draw a skeleton or the
    // source-only fields that the canvas's answer would replace.
    selectionAwaiting: scan?.awaitingFirstAnswer === true,
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
  const { onContextChange, contextFollow, contextsSettled } = contextChange;
  const { onAddQuery } = addQuery;
  const { embedLabelByKey } = embedNavHook;

  // The dropdown's rows, their dots and the checked row are one picture. While the next element's rules
  // are still arriving they are rebuilt from partial answers, so the open list reshuffles and the trigger
  // changes label and back; the last settled picture stays until the settled one replaces it.
  const held = useHeldWhileUnsettled({ contexts: orderedContexts, contextInfos, context }, { settled: contextsSettled });
  const cardContexts = {
    cssCodeOpen,
    onToggleCssCode: () => setCssCodeOpen((open) => !open),
    model: model ?? EMPTY_RULE_MODEL,
    resolved: resolved ?? EMPTY_RESOLVED,
    contexts: held.contexts,
    contextInfos: held.contextInfos,
    context: held.context,
    onContext: onContextChange,
    contextFollow,
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
  const { manualSourcePickRef, pendingKeys, selectionKeyRef, setSourceSelection } = nativeState;
  const { resolving } = refreshHook;
  const { onRemoveRule, onSaveCssRule } = ruleActions;
  const { effectiveSourceSelection } = nativeTarget;
  const { selectedRule } = writeNewRuleHook;
  const { setProp } = setPropHook;
  const { clearProp } = clearPropHook;
  const { liveSetProp, previewProp } = liveSetPropHook;
  const { nativeStyleName, sourceNote, sourceOptions } = sourceOptionsHook;

  const cardSource = {
    sourceValue: effectiveSourceSelection,
    sourceOptions,
    onSourceChange: (value: string) => {
      manualSourcePickRef.current = { selectionKey: selectionKeyRef.current, sourceKey: value };
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
    previewProp,
    onAdd: setProp,
    onSaveCssRule,
    onRemoveRule,
  };
  return { cardSource, cardWrites };
}

/**
 * `value` while `state.settled`, else the last value that was drawn settled (the first value if none yet).
 * Holding is bounded: it ends the render a settled answer lands, and a value never held back is the
 * one drawn on the very first render.
 */
function useHeldWhileUnsettled<T>(value: T, state: { readonly settled: boolean }): T {
  const heldRef = useRef(value);
  if (state.settled) {
    heldRef.current = value;
  }
  return heldRef.current;
}
