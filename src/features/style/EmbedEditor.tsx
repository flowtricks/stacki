import { ProvenanceEmbedNav } from './ProvenanceList';
import { type RuleModel } from './model/cascade';
import { type ScanState, type Phase, SaveIndicator } from './embed/EditorBasics';
import { type StyleCardProps } from './embed/QueryForms';
import { StyleCard } from './embed/StyleCard';
import {
  useEditorRefs,
  useBusyState,
  useScanState,
  useSelectionState,
  useNativeState,
  usePendingWrites,
  useContentBuild,
  useContentStore,
  useContentRebuild,
  useApplyResolve,
} from './embed/useEditorFoundation';
import {
  useBackgroundRefresh,
  useRematch,
  useDesignerSync,
  useElementReset,
  useScanWithoutSelection,
  useScanSelection,
  useRefresh,
  useSelectionSubscriptions,
  useChangeSubscriptions,
  useRefreshDerived,
} from './embed/useEditorScanning';
import { useSplitForEdit, useApplyEdit, usePropEdits, useLiveEdits, useRuleActions, useOpenEmbed, useElementTokens } from './embed/useEditorRuleEdits';
import {
  useTokenDefault,
  useCachedNative,
  useNativeRead,
  useActiveSelector,
  useSelectorPick,
  useTypedSelector,
  useFocusProp,
  usePseudoRequest,
  useSourceDocument,
  useRenameQuery,
  useContextKeys,
  useQuerySuggestions,
} from './embed/useEditorElement';
import {
  useEmbedContexts,
  useStyleContexts,
  useWrapperReach,
  useNativeTarget,
  useComponentSource,
  useResolved,
  useSelectorChips,
  useContextChange,
} from './embed/useEditorContexts';
import {
  useDefaultUpgrade,
  useNativeRefresh,
  useFocusResync,
  useNativeOps,
  useWriteNewRule,
  useCreateRule,
  useEmptyContext,
  useAddQuery,
  useNativeAttempt,
  useNativeSet,
  useCreateNativeClass,
  useNativeCreate,
  useAutoSelect,
} from './embed/useEditorResolution';
import './embedEditor.css';
import {
  useSetProp,
  useClearProp,
  useLiveSetProp,
  useSourceOptions,
  useEmbedNav,
  useSelectionCard,
  useContextCard,
  useSourceCard,
} from './embed/useEditorWrites';

export { SelectorPicker } from './embed/SelectorPicker';

export { useRemovedClasses, withoutClasses } from './embed/editorModel';

export default function EmbedEditor() {
  const editorFoundation = useEditorFoundation();
  const editorScanning = useEditorScanning(editorFoundation);
  const editorSelection = useEditorSelection(editorFoundation, editorScanning);
  const editorRuleEdits = useEditorRuleEdits(editorFoundation, editorSelection);
  const editorElement = useEditorElement(editorFoundation, editorRuleEdits);
  const editorContexts = useEditorContexts(editorFoundation, editorSelection, editorElement);
  const editorResolution = useEditorResolution(editorFoundation, editorElement, editorContexts);
  const editorRuleWrites = useEditorRuleWrites(editorFoundation, editorSelection, editorElement, editorContexts, editorResolution);
  const editorNativeCalls = useEditorNativeCalls(editorFoundation, editorRuleEdits, editorElement, editorContexts, editorResolution, editorRuleWrites);
  const editorPropWrites = useEditorPropWrites(
    editorFoundation,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
    editorRuleWrites,
    editorNativeCalls,
  );
  const editorSources = useEditorSources(editorFoundation, editorRuleEdits, editorElement, editorContexts, editorResolution);
  const editorCardView = useEditorCardView(
    editorFoundation,
    editorSelection,
    editorRuleEdits,
    editorElement,
    editorContexts,
    editorResolution,
    editorRuleWrites,
    editorNativeCalls,
    editorPropWrites,
    editorSources,
  );
  return <EditorRoot view={editorCardView.editorView.view} />;
}

// The panel's refs and state.
function useEditorFoundation() {
  const editorRefs = useEditorRefs();
  const busyState = useBusyState(editorRefs);
  const scanState = useScanState(editorRefs);
  const selectionState = useSelectionState();
  const nativeState = useNativeState(selectionState);
  const pendingWrites = usePendingWrites(editorRefs, busyState, scanState, nativeState);
  return { busyState, editorRefs, nativeState, pendingWrites, scanState, selectionState };
}

// Scanning the embeds and resolving the element against them.
function useEditorScanning(editorFoundation: ReturnType<typeof useEditorFoundation>) {
  const { editorRefs, nativeState, scanState } = editorFoundation;

  const contentBuild = useContentBuild(editorRefs);
  const contentStore = useContentStore(editorRefs, contentBuild);
  const contentRebuild = useContentRebuild(editorRefs, scanState, nativeState, contentBuild, contentStore);
  const applyResolveHook = useApplyResolve(editorRefs, scanState);
  const backgroundRefreshHook = useBackgroundRefresh(editorRefs, scanState, contentRebuild, applyResolveHook);
  const rematch = useRematch(editorRefs, scanState);
  const designerSync = useDesignerSync(editorRefs, nativeState, rematch);
  return { applyResolveHook, backgroundRefreshHook, contentRebuild, designerSync };
}

// Following the Designer's selection and keeping the panel in sync.
function useEditorSelection(editorFoundation: ReturnType<typeof useEditorFoundation>, editorScanning: ReturnType<typeof useEditorScanning>) {
  const { editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { applyResolveHook, backgroundRefreshHook, contentRebuild, designerSync } = editorScanning;

  const elementReset = useElementReset(editorRefs, scanState, selectionState, nativeState);
  const scanWithoutSelectionHook = useScanWithoutSelection(editorRefs, scanState, contentRebuild);
  const scanSelectionHook = useScanSelection(editorRefs, scanState, contentRebuild, applyResolveHook, backgroundRefreshHook);
  const refreshHook = useRefresh(editorRefs, elementReset, scanWithoutSelectionHook, scanSelectionHook);
  useSelectionSubscriptions(editorRefs, scanState, refreshHook);
  useChangeSubscriptions(scanState, backgroundRefreshHook, designerSync);
  const refreshDerivedHook = useRefreshDerived(editorRefs, scanState);
  return { refreshDerivedHook, refreshHook };
}

// Edits to embed rules.
function useEditorRuleEdits(editorFoundation: ReturnType<typeof useEditorFoundation>, editorSelection: ReturnType<typeof useEditorSelection>) {
  const { busyState, editorRefs, nativeState, pendingWrites, scanState } = editorFoundation;
  const { refreshDerivedHook } = editorSelection;

  const splitForEditHook = useSplitForEdit(nativeState);
  const applyEditHook = useApplyEdit(busyState, scanState, pendingWrites, refreshDerivedHook);
  const propEdits = usePropEdits(splitForEditHook, applyEditHook);
  const liveEdits = useLiveEdits(editorRefs, pendingWrites, splitForEditHook);
  const ruleActions = useRuleActions(editorRefs, busyState, pendingWrites, splitForEditHook, applyEditHook, liveEdits);
  const openEmbed = useOpenEmbed(editorRefs, scanState, pendingWrites);
  return { applyEditHook, liveEdits, openEmbed, propEdits, ruleActions };
}

// The element's tokens, native styles, and picked selector.
function useEditorElement(editorFoundation: ReturnType<typeof useEditorFoundation>, editorRuleEdits: ReturnType<typeof useEditorRuleEdits>) {
  const { editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { applyEditHook } = editorRuleEdits;

  const elementTokens = useElementTokens(scanState);
  const tokenDefault = useTokenDefault(scanState, selectionState, elementTokens);
  const cachedNative = useCachedNative(nativeState);
  useNativeRead(editorRefs, nativeState, tokenDefault, cachedNative);
  const activeSelectorHook = useActiveSelector(scanState, selectionState, nativeState, elementTokens);
  const selectorPick = useSelectorPick(editorRefs, selectionState, elementTokens);
  const typedSelector = useTypedSelector(editorRefs, selectionState, applyEditHook, selectorPick);
  const focusPropHook = useFocusProp(editorRefs, selectorPick);
  usePseudoRequest(typedSelector, selectorPick, elementTokens, selectionState);
  return {
    activeSelectorHook,
    elementTokens,
    focusPropHook,
    selectorPick,
    tokenDefault,
    typedSelector,
  };
}

// The source stylesheet, its queries, and the style contexts.
function useEditorContexts(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorElement: ReturnType<typeof useEditorElement>,
) {
  const { busyState, editorRefs, nativeState, pendingWrites, scanState, selectionState } = editorFoundation;
  const { refreshDerivedHook } = editorSelection;
  const { elementTokens, selectorPick } = editorElement;

  const sourceDocumentHook = useSourceDocument(nativeState, pendingWrites);
  const renameQuery = useRenameQuery(busyState, scanState, selectionState, pendingWrites, refreshDerivedHook, selectorPick, sourceDocumentHook);
  const contextKeys = useContextKeys(pendingWrites, elementTokens, selectorPick, sourceDocumentHook);
  const querySuggestionsHook = useQuerySuggestions(pendingWrites);
  const embedContexts = useEmbedContexts(selectionState, elementTokens, sourceDocumentHook, contextKeys);
  const wrapperReachHook = useWrapperReach(editorRefs, elementTokens, contextKeys);
  const styleContextsHook = useStyleContexts(selectionState, nativeState, contextKeys, embedContexts, wrapperReachHook);
  const nativeTarget = useNativeTarget(selectionState, nativeState, pendingWrites);
  const componentSource = useComponentSource(scanState, nativeState, nativeTarget);
  return {
    componentSource,
    nativeTarget,
    querySuggestionsHook,
    renameQuery,
    sourceDocumentHook,
    styleContextsHook,
  };
}

// The resolved style, the selector chips, and the default pick.
function useEditorResolution(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
) {
  const { nativeState, pendingWrites, scanState, selectionState } = editorFoundation;
  const { activeSelectorHook, elementTokens, selectorPick, tokenDefault } = editorElement;
  const { componentSource, nativeTarget, styleContextsHook } = editorContexts;

  const resolvedHook = useResolved(
    selectionState,
    nativeState,
    elementTokens,
    tokenDefault,
    activeSelectorHook,
    styleContextsHook,
    nativeTarget,
    componentSource,
  );
  const selectorChipsHook = useSelectorChips(scanState, selectionState, nativeState, elementTokens, activeSelectorHook, styleContextsHook, pendingWrites);
  const contextChange = useContextChange(selectionState, nativeState, elementTokens, activeSelectorHook, selectorPick, styleContextsHook);
  useDefaultUpgrade(selectionState, nativeState, elementTokens, tokenDefault, selectorPick, styleContextsHook);
  return { contextChange, resolvedHook, selectorChipsHook };
}

// Native reads and writes, and creating embed rules and queries.
function useEditorRuleWrites(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
) {
  const { busyState, editorRefs, nativeState, pendingWrites, scanState } = editorFoundation;
  const { refreshDerivedHook, refreshHook } = editorSelection;
  const { activeSelectorHook, elementTokens, selectorPick } = editorElement;
  const { styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;

  const nativeRefresh = useNativeRefresh(editorRefs, nativeState);
  useFocusResync(editorRefs, refreshHook, nativeRefresh);
  const nativeOps = useNativeOps(editorRefs, busyState, scanState, nativeState, nativeRefresh);
  const writeNewRuleHook = useWriteNewRule(busyState, scanState, pendingWrites, refreshDerivedHook, selectorPick, resolvedHook);
  const createRule = useCreateRule(scanState, pendingWrites, elementTokens, activeSelectorHook, styleContextsHook, resolvedHook, writeNewRuleHook);
  const emptyContext = useEmptyContext(busyState, scanState, pendingWrites, refreshDerivedHook, elementTokens, resolvedHook);
  return { createRule, emptyContext, nativeOps, nativeRefresh, writeNewRuleHook };
}

// Native property writes with their embed fallbacks.
function useEditorNativeCalls(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
) {
  const { busyState, editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { propEdits } = editorRuleEdits;
  const { activeSelectorHook, selectorPick, typedSelector } = editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;
  const { createRule, emptyContext, nativeOps, nativeRefresh, writeNewRuleHook } = editorRuleWrites;

  const addQuery = useAddQuery(
    selectionState,
    nativeState,
    propEdits,
    activeSelectorHook,
    selectorPick,
    typedSelector,
    nativeTarget,
    resolvedHook,
    writeNewRuleHook,
    createRule,
    emptyContext,
  );
  const nativeAttempt = useNativeAttempt(editorRefs, busyState, scanState, selectionState, styleContextsHook, nativeOps);
  const nativeSet = useNativeSet(editorRefs, scanState, selectionState, styleContextsHook, nativeRefresh, nativeOps, addQuery, nativeAttempt);
  const createNativeClassHook = useCreateNativeClass(editorRefs, selectionState, nativeState, styleContextsHook, nativeRefresh, nativeOps);
  const nativeCreate = useNativeCreate(scanState, nativeRefresh, nativeOps, addQuery, nativeAttempt, createNativeClassHook);
  return { addQuery, nativeCreate, nativeSet };
}

// The property writes the sections call.
function useEditorPropWrites(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
  editorNativeCalls: ReturnType<typeof useEditorNativeCalls>,
) {
  const { nativeState, scanState, selectionState } = editorFoundation;
  const { liveEdits, propEdits, ruleActions } = editorRuleEdits;
  const { activeSelectorHook, elementTokens, selectorPick } = editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook } = editorResolution;
  const { createRule, nativeOps, writeNewRuleHook } = editorRuleWrites;
  const { addQuery, nativeCreate, nativeSet } = editorNativeCalls;

  const autoSelect = useAutoSelect(nativeState, elementTokens, selectorPick);
  const setPropHook = useSetProp(
    scanState,
    liveEdits,
    activeSelectorHook,
    nativeTarget,
    resolvedHook,
    createRule,
    addQuery,
    nativeSet,
    nativeCreate,
    autoSelect,
  );
  const clearPropHook = useClearProp(selectionState, propEdits, liveEdits, ruleActions, styleContextsHook, resolvedHook, nativeOps, writeNewRuleHook, addQuery);
  const liveSetPropHook = useLiveSetProp(
    selectionState,
    nativeState,
    liveEdits,
    activeSelectorHook,
    styleContextsHook,
    nativeOps,
    writeNewRuleHook,
    addQuery,
    autoSelect,
    clearPropHook,
    createRule,
  );
  return { clearPropHook, liveSetPropHook, setPropHook };
}

// The source dropdown, embed navigation, and the card's selector props.
function useEditorSources(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
) {
  const { nativeState, selectionState } = editorFoundation;
  const { openEmbed } = editorRuleEdits;
  const { activeSelectorHook, elementTokens, focusPropHook, selectorPick, typedSelector } = editorElement;
  const { nativeTarget, styleContextsHook } = editorContexts;
  const { resolvedHook, selectorChipsHook } = editorResolution;

  const sourceOptionsHook = useSourceOptions(nativeState, elementTokens, styleContextsHook, nativeTarget, resolvedHook);
  const embedNavHook = useEmbedNav(nativeState, openEmbed, sourceOptionsHook);
  const selectionCard = useSelectionCard(selectionState, elementTokens, activeSelectorHook, selectorPick, typedSelector, focusPropHook, selectorChipsHook);
  return { embedNavHook, selectionCard, sourceOptionsHook };
}

// The card's remaining props and the root's view.
function useEditorCardView(
  editorFoundation: ReturnType<typeof useEditorFoundation>,
  editorSelection: ReturnType<typeof useEditorSelection>,
  editorRuleEdits: ReturnType<typeof useEditorRuleEdits>,
  editorElement: ReturnType<typeof useEditorElement>,
  editorContexts: ReturnType<typeof useEditorContexts>,
  editorResolution: ReturnType<typeof useEditorResolution>,
  editorRuleWrites: ReturnType<typeof useEditorRuleWrites>,
  editorNativeCalls: ReturnType<typeof useEditorNativeCalls>,
  editorPropWrites: ReturnType<typeof useEditorPropWrites>,
  editorSources: ReturnType<typeof useEditorSources>,
) {
  const { busyState, editorRefs, nativeState, scanState, selectionState } = editorFoundation;
  const { refreshHook } = editorSelection;
  const { ruleActions } = editorRuleEdits;
  const { elementTokens } = editorElement;
  const { nativeTarget, querySuggestionsHook, renameQuery, sourceDocumentHook } = editorContexts;
  const { contextChange, resolvedHook, selectorChipsHook } = editorResolution;
  const { writeNewRuleHook } = editorRuleWrites;
  const { addQuery } = editorNativeCalls;
  const { clearPropHook, liveSetPropHook, setPropHook } = editorPropWrites;
  const { embedNavHook, selectionCard, sourceOptionsHook } = editorSources;

  const contextCard = useContextCard(
    scanState,
    selectionState,
    elementTokens,
    sourceDocumentHook,
    renameQuery,
    querySuggestionsHook,
    resolvedHook,
    selectorChipsHook,
    contextChange,
    addQuery,
    embedNavHook,
  );
  const sourceCard = useSourceCard(
    busyState,
    scanState,
    nativeState,
    refreshHook,
    ruleActions,
    nativeTarget,
    writeNewRuleHook,
    setPropHook,
    clearPropHook,
    liveSetPropHook,
    sourceOptionsHook,
  );
  const editorView = useEditorView(editorRefs, busyState, scanState, nativeState, elementTokens, embedNavHook, selectionCard, contextCard, sourceCard);
  return { editorView };
}

// What the panel's root renders from.
function useEditorView(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  elementTokens: ReturnType<typeof useElementTokens>,
  embedNavHook: ReturnType<typeof useEmbedNav>,
  selectionCard: ReturnType<typeof useSelectionCard>,
  contextCard: ReturnType<typeof useContextCard>,
  sourceCard: ReturnType<typeof useSourceCard>,
) {
  const { rootRef } = editorRefs;
  const { busy, saveError } = busyState;
  const { nativeFallback, phase, scan, scanningMore, setNativeFallback } = scanState;
  const { pendingKeys } = nativeState;
  const { model } = elementTokens;
  const { embedNav, nativeHasAny } = embedNavHook;
  const { cardSelection } = selectionCard;
  const { cardContexts } = contextCard;
  const { cardSource, cardWrites } = sourceCard;

  const card: StyleCardProps = { ...cardSelection, ...cardContexts, ...cardSource, ...cardWrites };
  const view: EditorView = {
    embedNav,
    rootRef,
    busy,
    saveError,
    pendingCount: pendingKeys.size,
    nativeFallback,
    dismissFallback: () => setNativeFallback(undefined),
    phase,
    card,
    scanningMore,
    model,
    nativeHasAny,
    scan,
  };
  return { view };
}

// What the panel's root renders from.
interface EditorView {
  embedNav: { open: (embedKey: string) => void; labelFor: (key: string) => string };
  rootRef: React.RefObject<HTMLDivElement>;
  busy: boolean;
  saveError: string | undefined;
  pendingCount: number;
  nativeFallback: string | undefined;
  dismissFallback: () => void;
  phase: Phase;
  card: StyleCardProps;
  scanningMore: boolean;
  model: RuleModel | undefined;
  nativeHasAny: boolean;
  scan: ScanState | undefined;
}

function EditorRoot({ view }: { view: EditorView }) {
  const { phase, model, pendingCount } = view;
  return (
    <ProvenanceEmbedNav.Provider value={view.embedNav}>
      <div className="embed-editor_root" ref={view.rootRef}>
        {/* Save/context state lives in the header (spinner / check / error /
          in-component warning) — hover the header icon for details, no body text. */}
        <SaveIndicator
          busy={view.busy}
          error={view.saveError}
          pending={
            pendingCount
              ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} ` + "to the page's styles — not on the canvas until you leave this component"
              : undefined
          }
        />
        <PendingNote count={pendingCount} />
        {view.nativeFallback ? <FallbackNote note={view.nativeFallback} onDismiss={view.dismissFallback} /> : undefined}

        {/* The panel is always usable once Webflow responds, including when no canvas
          element is selected. Embeds and native class values fill in as they load. */}
        {phase === 'scanning' || phase === 'ready' || phase === 'no-selection' ? (
          <section className="embed-editor_section">
            <div className="embed-editor_list">
              <StyleCard {...view.card} />
            </div>
          </section>
        ) : undefined}

        {phase === 'ready' && !view.scanningMore && model && model.matchedRuleCount === 0 && !view.nativeHasAny ? (
          <EmptyScanNote scan={view.scan} />
        ) : undefined}
      </div>
    </ProvenanceEmbedNav.Provider>
  );
}

// Edits to the page's own <style> blocks held while a component is open.
function PendingNote({ count }: { count: number }) {
  if (!count) {
    return undefined;
  }
  return (
    <p className="embed-editor_pending-note">
      {count} change{count === 1 ? '' : 's'} to the page's own &lt;style&gt; block
      {count === 1 ? '' : 's'} {count === 1 ? 'is' : 'are'} held here — the canvas won't show {count === 1 ? 'it' : 'them'} until you leave this component, and{' '}
      {count === 1 ? 'it saves' : 'they save'} when you do.
    </p>
  );
}

// Why a native write fell back to an embed, until dismissed.
function FallbackNote({ note, onDismiss }: { note: string; onDismiss: () => void }) {
  return (
    <p className="embed-editor_fallback-note" role="status">
      {note}
      <button type="button" className="embed-editor_fallback-dismiss" aria-label="Dismiss" onClick={onDismiss}>
        ✕
      </button>
    </p>
  );
}

// Nothing targets the element: how many embeds were scanned, or that there were none.
function EmptyScanNote({ scan }: { scan: ScanState | undefined }) {
  return (
    <div className="embed-editor_empty">
      {scan?.embedCount
        ? `Scanned ${scan.embedCount} embed${scan.embedCount === 1 ? '' : 's'}` +
          (scan.componentEmbedCount ? ` (${scan.componentEmbedCount} in components)` : '') +
          ', but none target this element.'
        : 'No HTML embeds with <style> blocks were found on this page.'}
    </div>
  );
}
