// The style editor's foundation hooks: its refs, the busy state, the scan,
// the selection, the native model, pending writes, and building, storing and
// rebuilding content, then applying a resolve (EmbedEditor.tsx). EmbedEditor.tsx
// composes the hook groups in order; each later group takes the earlier
// groups' results.

import { useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import { assert } from '../../../../shared/core/assert';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadEmbedSource } from '../model/toolPreferences';
import { computeRuleModel } from '../model/cascade';
import { type ContextKey, type StateKey, type StyleContext } from '../model/resolved';
import { type MatchTarget } from '../model/selectors';
import {
  loadEmbedDocs,
  rebuildRules,
  askCanvasAbout,
  embedWritesStarted,
  primeDomMatches,
  resolveTarget,
  scanPage,
  serializeElementId,
  writeEmbedDocument,
  type EmbedDocument,
  type EmbedScan,
} from '../model/webflow';
import type { ElementSnapshot, NativeModel } from '../model/styleTypes';
import { type ScanState, type Phase } from './EditorBasics';
import {
  streamDocs,
  loadComponentDocs,
  mergedContent,
  scanStateFor,
  resolveStatus,
  type EmbedWriteResult,
  type RescanOptions,
  type Content,
  selectorKeyOf,
  editorSession,
  viewKeyMatches,
  useRemovedClasses,
} from './editorModel';

// The panel's refs: the selection, the scanned content, and the bookkeeping that
// async work reads without re-rendering.
export function useEditorRefs() {
  const selectedRef = useRef<unknown>(undefined);
  // The view this panel had when it was last unmounted, if the same element is still
  // selected — the chips render from it on the first paint instead of an empty well.
  const restoredRef = useRef(viewKeyMatches(editorSession.view) ? editorSession.view : undefined);
  // Identity of the last element we reset the selection for — so a NEW element clears
  // the previous one's picked selector (the token signature isn't reliable: distinct
  // elements can share it, especially when classes aren't readable in a component).
  // Seeded from the restored view, so returning to the SAME element doesn't read as a
  // change and blank everything.
  const selectedElementKeyRef = useRef(restoredRef.current?.elementKey ?? '');
  // The panel root — used to focus a specific property's field by [data-prop].
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<Content | undefined>(editorSession.scan?.content);
  const docsRef = useRef<EmbedDocument[]>(editorSession.scan?.docs ?? []);
  // Page-level embeds from the last full page scan — kept alive across the
  // enter/exit-component boundary so their rules still match (and stay editable)
  // while a component is open, then flushed on exit.
  const pageDocsRef = useRef<EmbedDocument[]>(editorSession.scan?.pageDocs ?? []);
  // The current page's component instances — used to enter a component when
  // navigating to one of its (globally-read) embeds from a provenance chip.
  const pageInstancesRef = useRef<unknown[]>([]);
  const inComponentRef = useRef(editorSession.scan?.inComponent ?? false);
  const pendingKeysRef = useRef<Set<string>>(new Set());
  // Selected element's ordered classes — for recomputing query scaffolds on edit.
  const classListRef = useRef<string[]>([]);
  const targetRef = useRef<MatchTarget | undefined>(undefined);
  const seqRef = useRef(0);
  // Monotonic ordering key so a slow partial render can never overwrite the
  // fuller result that followed it (key = seq * 2 + (partial ? 0 : 1)).
  const appliedKeyRef = useRef(-1);
  const refreshingRef = useRef(false);
  const busyRef = useRef(false);
  // Defer the VISIBLE busy state (which disables controls + spins the save indicator)
  // so a quick save — the common case — never flashes the panel disabled. The poll
  // gate (busyRef) still flips immediately; only the on-screen disable waits out this
  // delay, so a genuinely slow/stuck write still locks the controls to stop edits
  // piling up. Most single writes finish well under this, so they never disable.
  const busyTimerRef = useRef<number | undefined>(undefined);
  // What the canvas was last asked about, and for which element — see
  // refreshDerived.
  const primedRef = useRef<{ target: MatchTarget; key: string } | undefined>(undefined);
  const lastSnapSigRef = useRef('');
  const lastScanAtRef = useRef(editorSession.scan?.scanAt ?? 0);
  return {
    appliedKeyRef,
    busyRef,
    busyTimerRef,
    classListRef,
    contentRef,
    docsRef,
    inComponentRef,
    lastScanAtRef,
    lastSnapSigRef,
    pageDocsRef,
    pageInstancesRef,
    pendingKeysRef,
    primedRef,
    refreshingRef,
    restoredRef,
    rootRef,
    selectedElementKeyRef,
    selectedRef,
    seqRef,
    targetRef,
  };
}

// The busy flag (shown, deferred) and the last save failure.
export function useBusyState(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { busyRef, busyTimerRef } = editorRefs;

  const [busy, setBusy] = useState(false);
  // Last save failure (surfaced by the header save indicator, not as body text).
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  const setBusyBoth = useCallback(
    (value: boolean) => {
      busyRef.current = value; // gate the external-sync poll immediately (before any await)
      if (value) {
        setSaveError(undefined); // a new save starts → clear the last error
        if (busyTimerRef.current === undefined) {
          busyTimerRef.current = window.setTimeout(() => {
            busyTimerRef.current = undefined;
            setBusy(true);
          }, 300);
        }
      } else {
        if (busyTimerRef.current !== undefined) {
          window.clearTimeout(busyTimerRef.current);
          busyTimerRef.current = undefined;
        }
        setBusy(false);
      }
    },
    [busyRef, busyTimerRef],
  );
  useEffect(
    () => () => {
      if (busyTimerRef.current !== undefined) {
        window.clearTimeout(busyTimerRef.current);
      }
    },
    [busyTimerRef],
  );
  return { busy, saveError, setBusyBoth, setSaveError };
}

// The scan's phase and result, and the panel's status and notices.
export function useScanState(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { restoredRef } = editorRefs;

  const [phase, setPhase] = useState<Phase>('idle');
  const [scan, setScan] = useState<ScanState | undefined>(restoredRef.current?.scan);
  // A fast, scan-independent snapshot (tag + classes) read straight off the
  // selected element so the chips appear immediately, before the embed scan's
  // fuller rootSnapshot arrives.
  const [quickSnapshot, setQuickSnapshot] = useState<ElementSnapshot | undefined>(restoredRef.current?.quick);
  // Classes removed since the panel last resolved — hidden from the chips at once.
  const removedClasses = useRemovedClasses();
  const [, setStatus] = useState('Select an element to inspect its embed styles.');
  // When a native (Webflow class) write can't apply and we fall back to an embed,
  // the reason — surfaced inline so the fallback isn't silent.
  const [nativeFallback, setNativeFallback] = useState<string | undefined>(undefined);
  const [, setRefreshing] = useState(false);
  // True between showing page-level rules and the component embeds finishing.
  const [scanningMore, setScanningMore] = useState(false);
  // Starts closed for each panel session, then stays as the user left it while
  // element changes rebuild the card beneath this persistent editor state.
  const [cssCodeOpen, setCssCodeOpen] = useState(false);
  return {
    cssCodeOpen,
    nativeFallback,
    phase,
    quickSnapshot,
    removedClasses,
    scan,
    scanningMore,
    setCssCodeOpen,
    setNativeFallback,
    setPhase,
    setQuickSnapshot,
    setRefreshing,
    setScan,
    setScanningMore,
    setStatus,
  };
}

// The picked tokens, selector, style context, and interaction state.
export function useSelectionState() {
  // The tokens (tag / classes / attrs) chosen in the header ClassPicker, defaulted
  // to the element's classes and re-defaulted when the selected element changes.
  const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
  const tokenIdentityRef = useRef('');
  // Set when the element just changed, so once the model is ready we can upgrade the
  // raw all-classes default to the strongest selector actually STYLED in the current
  // context (cleared as soon as it's applied, or when the user picks something).
  const pendingDefaultRef = useRef(false);
  // A class typed into the selector box, on its way onto the element: when the
  // element's tokens next change to include it, that change is the user's own
  // edit landing, not a different element, so the typed pick stands.
  const typedClassRef = useRef<string | undefined>(undefined);
  // The token names the default effect just picked (its raw default) — read by the
  // smart-default effect to check if that default is styled (can't read state there:
  // it hasn't re-rendered yet in the same commit).
  const defaultTokensRef = useRef<string[]>([]);
  // The full selector currently being edited when it's picked from the matched-
  // selector chip list (or typed in) rather than composed from the token chips —
  // e.g. `.test:hover`, `.parent.is-active .test`, `:first-child`. Null → the
  // active selector is the token-composed one. `activeSelector` folds the two.
  const [selectedSelectorText, setSelectedSelectorText] = useState<string | undefined>(undefined);
  // The chosen style context (Base / a query) and interaction state (:hover, …).
  // stateKey follows the active selector's own pseudo-classes (see the selection
  // handlers) so native reads/writes target the right (breakpoint, pseudo).
  const [context, setContext] = useState<ContextKey>('');
  // The selected context's full object, remembered so the query stays selected when
  // the element changes (re-injected into the rebuilt list if the new element lacks it).
  const stickyContextRef = useRef<StyleContext | undefined>(undefined);
  const [stateKey, setStateKey] = useState<StateKey>('');
  return {
    context,
    defaultTokensRef,
    pendingDefaultRef,
    selectedSelectorText,
    selectedTokens,
    setContext,
    setSelectedSelectorText,
    setSelectedTokens,
    setStateKey,
    stateKey,
    stickyContextRef,
    tokenIdentityRef,
    typedClassRef,
  };
}

// Deferred page edits, the native class styles, and the chosen style source.
export function useNativeState(selectionState: ReturnType<typeof useSelectionState>) {
  const { stateKey } = selectionState;

  // Keys of page-level embeds with edits that couldn't be written while a
  // component is open. Mirrored into pendingKeysRef for use inside callbacks.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  // Native Webflow class styles on the selected element (read via the Style API),
  // the layer being edited (Native/Embed), and the Designer's current breakpoint
  // (which defaults the context on load).
  const [nativeModel, setNativeModel] = useState<NativeModel | undefined>(undefined);
  // Undefined = follow the smart default (Native when the class already has native
  // values, else Embed so pre-existing embed CSS stays editable); a value = the
  // user's explicit choice, kept until the selected element changes.
  // The chosen style source: 'native' (Webflow class) or a specific embed's key.
  // Undefined = follow the default (Webflow when a class Style exists, else the first
  // embed). Reset when the selected element changes.
  // Restore the last-targeted embed so a chosen source (e.g. a global-CSS embed)
  // persists across reloads; effectiveSourceSel still falls back if it's unavailable.
  const [sourceSelection, setSourceSelection] = useState<string | undefined>(() => loadEmbedSource() ?? undefined);
  // Auto-switch the "create styles in" source to the open component's embed while
  // inside a component, and restore the page pick on exit. Refs so the transition
  // effect reads live values without re-running on every source change.
  const sourceSelectionRef = useRef(sourceSelection);
  useEffect(() => {
    sourceSelectionRef.current = sourceSelection;
  }, [sourceSelection]);
  const previousInComponentRef = useRef(false);
  // The page pick, stashed while in a component.
  const pageSourceRef = useRef<string | undefined>(undefined);
  const wantCompSourceRef = useRef(false); // pending switch until the component embed loads
  const nativeModelRef = useRef<NativeModel | undefined>(undefined);
  // The element identity `nativeModel` was last read for. Native styles load via a
  // separate async effect that lags the embed model on an element switch, so this lets
  // selector-defaulting wait until nativeModel matches the current element (otherwise
  // the previous element's native selectors briefly leak into the styled list and get
  // auto-picked). See the smart-default effect.
  const nativeIdentityRef = useRef('');
  const stateKeyRef = useRef<StateKey>('');
  useEffect(() => {
    stateKeyRef.current = stateKey;
  }, [stateKey]);
  // The selector the user is editing, read at write time by the split-on-edit
  // helpers (they run inside memoized handlers that would otherwise capture a
  // stale value). Synced from `activeSelector` once it's computed below.
  const activeSelectorRef = useRef('');
  return {
    activeSelectorRef,
    nativeIdentityRef,
    nativeModel,
    nativeModelRef,
    pageSourceRef,
    pendingKeys,
    previousInComponentRef,
    setNativeModel,
    setPendingKeys,
    setSourceSelection,
    sourceSelection,
    sourceSelectionRef,
    wantCompSourceRef,
  };
}

// Page-embed edits held while a component is open, and the embeds by key.
export function usePendingWrites(
  editorRefs: ReturnType<typeof useEditorRefs>,
  busyState: ReturnType<typeof useBusyState>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const translateDescribed = useTranslateDescribed();
  const { docsRef, inComponentRef, pendingKeysRef } = editorRefs;
  const { setSaveError } = busyState;
  const { scan, setStatus } = scanState;
  const { setPendingKeys } = nativeState;

  const markPending = useCallback(
    (key: string) => {
      if (pendingKeysRef.current.has(key)) {
        return;
      }
      const next = new Set(pendingKeysRef.current).add(key);
      pendingKeysRef.current = next;
      setPendingKeys(next);
    },
    [pendingKeysRef, setPendingKeys],
  );
  const clearPending = useCallback(
    (key: string) => {
      if (!pendingKeysRef.current.has(key)) {
        return;
      }
      const next = new Set(pendingKeysRef.current);
      next.delete(key);
      pendingKeysRef.current = next;
      setPendingKeys(next);
    },
    [pendingKeysRef, setPendingKeys],
  );
  // After an embed write. A page-level embed can't be written while a component is
  // open: the in-memory edit is kept and remembered — it flushes automatically on
  // exit. Any other failure is reported. Returns whether the write landed.
  const settleEmbedWrite = useCallback(
    (embedDocument: EmbedDocument, result: EmbedWriteResult, held: 'rule' | 'query'): boolean => {
      if (result.ok) {
        clearPending(embedDocument.source.key);
        return true;
      }
      if (inComponentRef.current && !embedDocument.source.fromComponent) {
        markPending(embedDocument.source.key);
        setStatus(`Held — this ${held} lives in the page, so the canvas shows it once you ` + 'leave the component.');
        return false;
      }
      setSaveError(translateDescribed({ message: result.error, messageRef: result.errorRef }));
      return false;
    },
    [clearPending, markPending, inComponentRef, setSaveError, setStatus, translateDescribed],
  );

  const documentByKey = useMemo(() => {
    const map = new Map<string, EmbedDocument>();
    docsRef.current.forEach((embedDocument) => map.set(embedDocument.source.key, embedDocument));
    return map;
    // Rebuilt per scan: docsRef refills with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recomputed per scan, on purpose
  }, [scan, docsRef]);
  return { documentByKey, markPending, settleEmbedWrite };
}

// The expensive scan: walk the tree and read every embed.
export function useContentBuild(editorRefs: ReturnType<typeof useEditorRefs>) {
  const { pageDocsRef, pageInstancesRef } = editorRefs;

  // The expensive part — walk the tree + read every embed. Cache the result.
  // Rules/counts are (re)derived in storeContent so they can fold in the
  // remembered page embeds; buildContent just does the raw scan + read.
  //
  // Two phases so results stream in: the page tree + page embeds (enough to
  // resolve ancestor chains and show page-level rules) render first via
  // onPartial, then component embeds fill in. Reads within each phase run
  // concurrently (bounded by the read limiter in webflow.ts).
  const buildContent = useCallback(
    async (
      // Every build lists its sources afresh, so a forced rescan reads the same way.
      _rescan: RescanOptions,
      onPartial?: (content: Content) => void,
    ): Promise<Content> => {
      const page = await scanPage();
      pageInstancesRef.current = page.instances;
      const pageScan: EmbedScan = {
        parentByKey: page.parentByKey,
        childrenByKey: page.childrenByKey,
        elementByKey: page.elementByKey,
        embeds: page.pageEmbeds,
        inComponentContext: page.inComponentContext,
      };
      const onDocument = streamDocs(pageScan, onPartial);
      // Page and component embeds both re-read their CODE fresh so out-of-app edits
      // show up.
      const [pageResult, componentResult] = await Promise.all([loadEmbedDocs(page.pageEmbeds, onDocument), loadComponentDocs(onDocument)]);
      return mergedContent(pageScan, [pageResult, componentResult]);
    },
    [pageInstancesRef],
  );

  // While a component is open, the scan can only see that component's own embeds
  // — the page tree is out of scope (getAllElements/getRootElement are scoped to
  // the entered component). Fold in the page embeds remembered from the last full
  // page scan (dedup by key) so page rules still match.
  const composeDocs = useCallback(
    (content: Content): EmbedDocument[] => {
      if (!content.scan.inComponentContext) {
        return content.docs;
      }
      const seen = new Set(content.docs.map((embedDocument) => embedDocument.source.key));
      const remembered = pageDocsRef.current.filter((embedDocument) => !seen.has(embedDocument.source.key));
      return [...content.docs, ...remembered];
    },
    [pageDocsRef],
  );
  return { buildContent, composeDocs };
}

// Store a scan's content, deriving its rules from the active embeds.
export function useContentStore(editorRefs: ReturnType<typeof useEditorRefs>, contentBuild: ReturnType<typeof useContentBuild>) {
  const { contentRef, docsRef, inComponentRef, lastScanAtRef, pageDocsRef } = editorRefs;
  const { composeDocs } = contentBuild;

  // Returns the content with its rules and counts derived from the active embeds.
  const storeContent = useCallback(
    (scanned: Content): Content => {
      // Only a complete (non-partial) page scan refreshes the remembered page
      // embeds; while in a component we keep the previous ones (they hold any
      // unsaved edits), and a partial snapshot must not clobber them either.
      if (!scanned.scan.inComponentContext && !scanned.partial) {
        pageDocsRef.current = scanned.docs;
      }
      const active = composeDocs(scanned);
      const content: Content = {
        ...scanned,
        rules: rebuildRules(active),
        embedCount: active.length,
        componentEmbedCount: active.filter((embedDocument) => embedDocument.source.fromComponent).length,
      };
      contentRef.current = content;
      docsRef.current = active;
      inComponentRef.current = content.scan.inComponentContext;
      lastScanAtRef.current = Date.now();
      // Persist completed scans so a reopen restores them (see editorSession.scan). Skip
      // partials — restoring a page-only snapshot would drop the component chips.
      if (!content.partial) {
        editorSession.scan = {
          content,
          docs: active,
          pageDocs: pageDocsRef.current,
          inComponent: content.scan.inComponentContext,
          scanAt: lastScanAtRef.current,
        };
      }
      return content;
    },
    [composeDocs, contentRef, docsRef, inComponentRef, lastScanAtRef, pageDocsRef],
  );
  return { storeContent };
}

// How many times a read is redone because the panel wrote while it ran. Each
// redo is a full re-read of every stylesheet, so it is capped: a slider drag
// writes on every tick, and chasing it would read for as long as it lasts.
const REBUILD_AFTER_WRITE_ATTEMPTS_MAX = 3;

// The panel wrote while a read was in flight, so the read may hold a file from
// before the write: read again, since storing it would roll the panel back and
// the next edit would write the old CSS over the new. Undefined when writes
// kept landing past the cap.
async function rereadPastWrites(first: { readonly content: Content; readonly writes: number }, read: () => Promise<Content>): Promise<Content | undefined> {
  let { content, writes } = first;
  for (let attempt = 0; writes !== embedWritesStarted(); attempt++) {
    if (attempt >= REBUILD_AFTER_WRITE_ATTEMPTS_MAX) {
      return undefined;
    }
    writes = embedWritesStarted();
    content = await read();
  }
  assert(writes <= embedWritesStarted(), 'rereadPastWrites: the write count only grows');
  return content;
}

function useFlushPending(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
  scanState: ReturnType<typeof useScanState>,
) {
  const { pageDocsRef, pendingKeysRef } = editorRefs;
  const { setPendingKeys } = nativeState;
  const { setStatus } = scanState;
  // Write out every page embed that was edited while a component was open, now
  // that the page is writable again. Best-effort: reported, then cleared.
  return useCallback(async () => {
    const keys = [...pendingKeysRef.current];
    if (!keys.length) {
      return;
    }
    const byKey = new Map(pageDocsRef.current.map((embedDocument) => [embedDocument.source.key, embedDocument]));
    let failed = 0;
    for (const key of keys) {
      const embedDocument = byKey.get(key);
      if (!embedDocument) {
        continue;
      }
      const result = await writeEmbedDocument(embedDocument);
      if (!result.ok) {
        failed += 1;
      }
    }
    pendingKeysRef.current = new Set();
    setPendingKeys(new Set());
    setStatus(failed ? `Saved your page-embed edits — ${failed} couldn't be written.` : 'Saved the page-embed edits you made inside the component.'); // i18n-ignore: write-only status, never rendered.
  }, [pageDocsRef, pendingKeysRef, setPendingKeys, setStatus]);
}

// Rebuild and store content, flushing deferred page-embed edits first.
export function useContentRebuild(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  nativeState: ReturnType<typeof useNativeState>,
  contentBuild: ReturnType<typeof useContentBuild>,
  contentStore: ReturnType<typeof useContentStore>,
) {
  const { contentRef, inComponentRef, pendingKeysRef } = editorRefs;
  const { buildContent } = contentBuild;
  const { storeContent } = contentStore;

  const flushPending = useFlushPending(editorRefs, nativeState, scanState);

  // Rebuild content, flushing any deferred page-embed edits the moment we detect
  // the component was closed (so the fresh page read reflects them). onPartial
  // (foreground only) renders the page-level rules as soon as they're ready,
  // before component embeds finish loading.
  const rebuildAndStore = useCallback(
    async (rescan: RescanOptions = {}, onPartial?: (content: Content) => void): Promise<Content> => {
      const wasInComponent = inComponentRef.current;
      let writes = embedWritesStarted();
      // A partial is shown only while no write has landed since the read began:
      // it would put the CSS from before that write back on screen.
      const emitPartial = onPartial
        ? (partial: Content) => {
            if (writes === embedWritesStarted()) {
              onPartial(storeContent(partial));
            }
          }
        : undefined;
      let content = await buildContent(rescan, emitPartial);
      if (wasInComponent && !content.scan.inComponentContext && pendingKeysRef.current.size) {
        await flushPending();
        writes = embedWritesStarted();
        content = await buildContent(rescan);
      }
      const fresh = await rereadPastWrites({ content, writes }, () => buildContent(rescan));
      // Writes keep landing (a drag): keep what the panel holds — its docs
      // already carry every write — and let the next refresh catch up.
      if (fresh === undefined && contentRef.current !== undefined) {
        return contentRef.current;
      }
      // A browser refresh crosses the network. A failed file read is not a
      // deleted stylesheet: replacing the last complete scan with that partial
      // inventory makes its chips and values disappear until the next poll.
      // Foreground scans still show available sources and their read errors.
      return storeContent(completeRefresh(fresh ?? content, { allowPartial: !!onPartial || !contentRef.current }));
    },
    [buildContent, flushPending, storeContent, contentRef, inComponentRef, pendingKeysRef],
  );
  return { rebuildAndStore };
}

// Resolve the selected element against the cached content.
export function useApplyResolve(editorRefs: ReturnType<typeof useEditorRefs>, scanState: ReturnType<typeof useScanState>) {
  const { appliedKeyRef, classListRef, pageDocsRef, primedRef, seqRef, targetRef } = editorRefs;
  const { setPhase, setScan, setScanningMore, setStatus } = scanState;

  // The cheap part — resolve the selected element against cached content.
  const applyResolve = useCallback(
    async (element: unknown, content: Content, seq: number, options: { readonly silent?: boolean; readonly sourceOnly?: boolean } = {}) => {
      // Source-known selectors show first when a cached scan is available.
      // The rendered page then supplies component markup, runtime classes and
      // exact DOM matches in one round trip rather than two back to back.
      const asked = options.sourceOnly ? ({ kind: 'unasked' } as const) : await askCanvasAbout(serializeElementId(element), content.rules);
      const { target, rootSnapshot } = await resolveTarget(element, content.scan, asked);
      if (seq !== seqRef.current) {
        return;
      }
      targetRef.current = target;
      await primeDomMatches(target, content.rules, asked);
      if (!options.sourceOnly) {
        primedRef.current = { target, key: selectorKeyOf(content.rules) };
      }
      const model = await computeRuleModel(content.rules, target);
      if (seq !== seqRef.current) {
        return;
      }
      // Don't let a lagging partial clobber the final (partials share seq*2+0, the
      // final is seq*2+1 so it always wins; a late partial after it is dropped). A
      // background refresh reuses the same seq and re-applies (equal key ⇒ proceeds).
      const key = seq * 2 + (content.partial ? 0 : 1);
      if (key < appliedKeyRef.current) {
        return;
      }
      appliedKeyRef.current = key;
      // Scaffolds come from the current context's own (writable) embeds — the
      // component's embeds while inside one, the page's otherwise.
      classListRef.current = rootSnapshot.classList;
      // A streamed partial is a step on the way (EditorBasics.tsx). So is a
      // source-only pass that could not read the element's classes (markup a
      // component renders): its list is the page's global selectors alone, and
      // drawing it flashed them between two elements' chips. One that did read
      // them is a real answer, shown while a busy canvas is still answering.
      const sourceKnown = rootSnapshot.classList.length > 0;
      const settled = !content.partial && (options.sourceOnly !== true || sourceKnown);
      setScan(scanStateFor(content, { rootSnapshot, model, settled }, pageDocsRef.current.length));
      setPhase('ready');
      setScanningMore(!!content.partial);
      if (!options.silent) {
        setStatus(resolveStatus(content, model));
      }
    },
    [appliedKeyRef, classListRef, pageDocsRef, primedRef, seqRef, setPhase, setScan, setScanningMore, setStatus, targetRef],
  );
  return { applyResolve };
}

function completeRefresh(content: Content, options: { readonly allowPartial: boolean }): Content {
  if (!options.allowPartial && content.errors.length) {
    throw new Error('Stylesheet refresh interrupted; keeping the last complete scan.');
  }
  return content;
}
