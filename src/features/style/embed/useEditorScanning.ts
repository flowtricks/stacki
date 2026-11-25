// Keeping the scan current: the throttled background refresh, re-matching,
// polling the designer, resetting the element, scanning with and without a
// selection, the refresh the panel asks for, the subscriptions that trigger
// one, and refreshing what is derived from it (EmbedEditor.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetComputedStyles } from '../model/computedStyle';
import { forgetComputedColors } from '../model/computedColor';
import { computeRuleModel } from '../model/cascade';
import { type MatchTarget } from '../model/selectors';
import { getHost, onHostChange, type HostState } from '../model/host';
import {
  adoptReload,
  buildSnapshot,
  onDocsReloaded,
  rebuildRules,
  primeDomMatches,
  scanHasElement,
  serializeElementId,
  scanPage,
  scanPageNow,
  syncNodeDocuments,
  webflowApi,
  embedWritesStarted,
  loadEmbedDocs,
  type EmbedDocument,
} from '../model/webflow';
import { elementSelectionKey } from '../model/webflowElement';
import { assert } from '../../../../shared/core/assert';
import { onCanvasRendered } from '../../../editor/canvasQuery';
import type { ElementSnapshot } from '../model/styleTypes';
import { EMPTY_RULE_MODEL, computePlaceholders } from './EditorBasics';
import { readScanSnapshot, scanSnapshotKey, type ScanSnapshot } from './scanSnapshotCache';
import { filledDocuments, memoryContent, type MemoryContent } from './memoryContent';
import {
  placeholdersFor,
  readDesignerState,
  unselectedScanState,
  type CanvasAnswer,
  type Content,
  BG_REFRESH_THROTTLE_MS,
  sheetSignature,
  DESIGNER_SYNC_INTERVAL_MS,
  selectorKeyOf,
  snapshotSignature,
  domMatchesChanged,
  nativeSignature,
  authoredClasses,
  contentForCurrentTree,
} from './editorModel';
import { useEditorRefs, useScanState, useSelectionState, useNativeState, useContentRebuild, useApplyResolve } from './useEditorFoundation';

// How many times one background refresh reads again because what it read from moved while it
// ran. An undo moves the history tick twice (once as it starts, once when it has landed) and the
// page model once; a live write moves the model once. Past this the pass stops, stays marked
// stale, and the next poll takes it up as an urgent refresh.
const BACKGROUND_REFRESH_PASSES_MAX = 4;

// What the panel's content is read from, by identity: the history tick the app moves on undo
// and redo, and the page model, whose `<style>` blocks are read from its nodes (webflow.ts
// readSource). A content read while either moved holds the CSS from before the move.
interface SourceRevision {
  readonly historyTick: number;
  readonly nodes: HostState['nodes'];
}

function sourceRevision(): SourceRevision {
  const host = getHost();
  return { historyTick: host.historyTick, nodes: host.nodes };
}

function sameSourceRevision(left: SourceRevision, right: SourceRevision): boolean {
  if (left.historyTick !== right.historyTick) {
    return false;
  }
  return left.nodes === right.nodes;
}

// Rebuild content in the background, then re-resolve the selection.
export function useBackgroundRefresh(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
  applyResolveHook: ReturnType<typeof useApplyResolve>,
) {
  const { busyRef, lastScanAtRef, refreshingRef, selectedRef, seqRef } = editorRefs;
  const { setRefreshing } = scanState;
  const { rebuildAndStore } = contentRebuild;
  const { applyResolve } = applyResolveHook;
  // An urgent refresh asked for while another ran or an edit was saving. It used to be
  // dropped: an undo asks once as it starts (the page still holds the old CSS) and again once
  // it has landed, and the second ask arrived while the first read was still out, so the panel
  // kept the read from before the undo — one step behind the canvas and the file (SP-06).
  const staleRef = useRef(false);

  // Rebuild content in the background (coalesced + throttled) to pick up embed
  // edits, then re-resolve the current selection — without blocking the UI.
  const backgroundRefresh = useCallback(
    async ({ now = false }: { now?: boolean } = {}) => {
      if (refreshingRef.current || busyRef.current) {
        if (now) {
          staleRef.current = true;
        }
        return;
      }
      // `now` skips the throttle: something rewrote the files or the model out
      // from under the panel (an undo), and waiting out a polling interval to
      // notice is what made the panel trail the canvas. A refused urgent ask is
      // urgent still when the poll comes round.
      const urgent = now || staleRef.current;
      if (!urgent && Date.now() - lastScanAtRef.current < BG_REFRESH_THROTTLE_MS) {
        return;
      }
      refreshingRef.current = true;
      setRefreshing(true);
      try {
        let passes = 0;
        for (; passes < BACKGROUND_REFRESH_PASSES_MAX; passes++) {
          staleRef.current = false;
          const revision = sourceRevision();
          // Failed network refreshes need the same backoff as successful scans.
          lastScanAtRef.current = Date.now();
          const content = await rebuildAndStore();
          // A read overtaken while it ran is not shown: resolving it costs a canvas round
          // trip and would paint the step before for as long as the next read takes.
          if (staleRef.current) {
            continue;
          }
          if (!sameSourceRevision(revision, sourceRevision())) {
            continue;
          }
          const element = selectedRef.current;
          if (element && scanHasElement(content.scan, element)) {
            await applyResolve(element, content, seqRef.current, { silent: true });
          }
          // Settled only when nothing it read from moved meanwhile: the model the panel
          // shows is then the one for the document as it stands.
          if (staleRef.current) {
            continue;
          }
          if (sameSourceRevision(revision, sourceRevision())) {
            break;
          }
        }
        assert(passes <= BACKGROUND_REFRESH_PASSES_MAX, 'backgroundRefresh: the passes are bounded');
        if (passes === BACKGROUND_REFRESH_PASSES_MAX) {
          staleRef.current = true;
        }
      } catch {
        // Background failures are non-fatal — the cached view stays usable.
      } finally {
        refreshingRef.current = false;
        setRefreshing(false);
      }
    },
    [applyResolve, rebuildAndStore, busyRef, lastScanAtRef, refreshingRef, selectedRef, seqRef, setRefreshing],
  );
  return { backgroundRefresh };
}

// Re-match the selectors when the element's classes or attributes changed.
export function useRematch(editorRefs: ReturnType<typeof useEditorRefs>, scanState: ReturnType<typeof useScanState>) {
  const { busyRef, classListRef, primedRef, selectedRef, targetRef } = editorRefs;
  const { setScan } = scanState;

  // Poll the Designer for out-of-app edits to the SELECTED element — added/removed
  // classes or data attributes, and native class-style changes — and reflect them
  // (the API has no change events). Cheap in steady state: it reads + compares
  // signatures and only touches state when something actually differs. Embed-code
  // edits are picked up separately by the (throttled) backgroundRefresh.
  // Classes / attributes changed → selectors re-match; re-resolve against the cached
  // embeds and refresh the header identity. Reuses the answer the identity read
  // already got back.
  const rematchChanged = useCallback(
    async (element: unknown, content: Content, read: { target: MatchTarget; snap: ElementSnapshot; asked: CanvasAnswer }) => {
      const { target, snap } = read;
      await primeDomMatches(target, content.rules, read.asked);
      primedRef.current = { target, key: selectorKeyOf(content.rules) };
      const model = await computeRuleModel(content.rules, target);
      if (busyRef.current || element !== selectedRef.current) {
        return;
      }
      targetRef.current = target;
      classListRef.current = snap.classList;
      setScan((previous) =>
        previous
          ? {
              ...previous,
              rootSnapshot: snap,
              model,
              placeholders: placeholdersFor(content, snap.classList),
            }
          : previous,
      );
    },
    [busyRef, classListRef, primedRef, selectedRef, setScan, targetRef],
  );
  return { rematchChanged };
}

// Poll the Designer for out-of-app edits to the selected element.
export function useDesignerSync(
  editorRefs: ReturnType<typeof useEditorRefs>,
  nativeState: ReturnType<typeof useNativeState>,
  rematch: ReturnType<typeof useRematch>,
) {
  const { busyRef, contentRef, lastSnapSigRef, refreshingRef, selectedRef, targetRef } = editorRefs;
  const { nativeModelRef, setNativeModel } = nativeState;
  const { rematchChanged } = rematch;

  const syncFromDesigner = useCallback(async () => {
    if (busyRef.current || refreshingRef.current) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    const element = selectedRef.current;
    const content = contentRef.current;
    if (!element || !content || !scanHasElement(content.scan, element)) {
      return;
    }
    const read = await readDesignerState(element, content);
    if (!read) {
      return; // transient read failure — try again next tick
    }
    const { target, snap, native, asked } = read;
    if (busyRef.current || element !== selectedRef.current) {
      return;
    } // a user edit / reselect began
    const snapSig = snapshotSignature(snap);
    // Compare against the model CURRENTLY DISPLAYED (nativeModelRef), not a separate
    // last-seen ref: every authoritative write (refreshNative) and the load effect
    // update nativeModelRef, so this stays in sync automatically. A stale ref here made
    // the poll re-apply an identical model — a redundant full-panel re-render (the
    // flicker) 0–1500ms after every value edit or reset.
    const snapChanged = snapSig !== lastSnapSigRef.current;
    const nativeChanged = nativeSignature(native) !== nativeSignature(nativeModelRef.current);
    // The element itself is the same, but the page around it may have changed what its selectors
    // match (a sibling deleted, a child inserted): the frame answers natively, so a differing
    // answer is a change. The pick, scroll and open sections are not touched by a rematch.
    const matchesChanged = domMatchesChanged(targetRef.current?.domMatched, asked);
    if (!snapChanged && !nativeChanged && !matchesChanged) {
      return;
    }
    lastSnapSigRef.current = snapSig;
    if (nativeChanged) {
      nativeModelRef.current = native;
      setNativeModel(native);
    }
    if (snapChanged || matchesChanged) {
      await rematchChanged(element, content, { target, snap, asked });
    }
  }, [rematchChanged, busyRef, contentRef, lastSnapSigRef, nativeModelRef, refreshingRef, selectedRef, setNativeModel, targetRef]);
  return { syncFromDesigner };
}

/**
 * Draw an element from its last settled answer (scanSnapshotCache.ts) when one is remembered
 * under the CSS the panel holds now, and say whether it was. Its match target goes with it, so
 * an edit made before the canvas's fresh answer lands is made against this element.
 */
function useRememberedSnapshot(editorRefs: ReturnType<typeof useEditorRefs>, setScan: ReturnType<typeof useScanState>['setScan']) {
  const { classListRef, docsRef, primedRef, settledElementKeyRef, targetRef } = editorRefs;
  // Each ref is listed, never the refs object: useEditorRefs builds that object afresh on every
  // render, and a callback that changed identity with it re-ran the selection effects on every
  // render, which asked the canvas again on every render.
  return useCallback(
    (elementKey: string): boolean => {
      const remembered = rememberedSnapshotFor(docsRef.current, elementKey);
      if (remembered === undefined) {
        return false;
      }
      settledElementKeyRef.current = elementKey;
      targetRef.current = remembered.target;
      classListRef.current = [...remembered.classList];
      primedRef.current = remembered.primed;
      setScan(remembered.scan);
      return true;
    },
    [classListRef, docsRef, primedRef, settledElementKeyRef, targetRef, setScan],
  );
}

function rememberedSnapshotFor(docs: readonly EmbedDocument[], elementKey: string): ScanSnapshot | undefined {
  if (elementKey === '') {
    return undefined;
  }
  const remembered = readScanSnapshot(scanSnapshotKey(elementKey, docs));
  assert(remembered === undefined || remembered.scan.settled, 'rememberedSnapshotFor: a remembered answer is settled');
  return remembered;
}

// Forget the previous element's picks when another element is selected.
export function useElementReset(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const { selectedElementKeyRef, settledElementKeyRef } = editorRefs;
  const { setQuickSnapshot, setScan } = scanState;
  const paintRemembered = useRememberedSnapshot(editorRefs, setScan);
  const { pendingDefaultRef, setContextStale, setSelectedSelectorText, setSelectedTokens, setStateKey, tokenIdentityRef } = selectionState;
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // A new element must not inherit the previous one's picked selector. Reset the
  // moment the SELECTED ELEMENT changes (not when its token signature does — those
  // can collide across elements), then the tokens effect re-defaults it.
  const resetForElement = useCallback(
    (element: unknown) => {
      const elementKey = elementSelectionKey(element);
      if (elementKey === selectedElementKeyRef.current) {
        return;
      }
      selectedElementKeyRef.current = elementKey;
      // The query the person was in belongs to the previous element's list until this one's is known.
      setContextStale(true);
      setSelectedSelectorText(undefined);
      setSelectedTokens([]);
      setStateKey('');
      setQuickSnapshot(undefined); // drop the previous element's chips
      // An element seen before, under the same CSS, is drawn from its last settled
      // answer at once (scanSnapshotCache.ts); the canvas's fresh answer follows and
      // replaces it only where it differs. Its match target goes with it, so an edit
      // made before that answer lands is made against this element, not the last one.
      // The panel's docs are already those of the file open now when it opened from memory
      // (resolveSelection), so an element of a file opened before is found here too.
      if (!paintRemembered(elementKey)) {
        settledElementKeyRef.current = '';
        // The chips are derived from these two models, and both are refilled by
        // async reads. Left alone they keep listing the PREVIOUS element's
        // selectors as if they were this one's. Blank them now and mark the scan
        // unsettled: the well and the sections draw placeholders in their shape
        // until the new answer has landed whole, so neither the blank, the previous
        // element's chips nor the stages in between reach the screen.
        setScan((previous) =>
          previous ? { ...previous, rootSnapshot: undefined, model: EMPTY_RULE_MODEL, settled: false, awaitingFirstAnswer: true } : previous,
        );
      }
      setNativeModel(undefined);
      nativeModelRef.current = undefined;
      nativeIdentityRef.current = '';
      // Force the tokens effect to re-default even if the new element shares the old
      // one's token signature (both classless divs, unreadable classes, …).
      tokenIdentityRef.current = '';
      pendingDefaultRef.current = true;
    },
    [
      nativeIdentityRef,
      nativeModelRef,
      paintRemembered,
      pendingDefaultRef,
      selectedElementKeyRef,
      settledElementKeyRef,
      setContextStale,
      setNativeModel,
      setQuickSnapshot,
      setScan,
      setSelectedSelectorText,
      setSelectedTokens,
      setStateKey,
      tokenIdentityRef,
    ],
  );
  return { resetForElement };
}

// Keep the embeds scanned while no element is selected.
export function useScanWithoutSelection(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
) {
  const { contentRef, pageDocsRef, selectedRef, seqRef } = editorRefs;
  const { setPhase, setScan, setScanningMore, setStatus } = scanState;
  const { rebuildAndStore } = contentRebuild;

  // The style panel does not depend on a canvas selection. Keep scanning embeds so
  // its source picker and custom-selector writes remain available, but project them
  // through an empty match model until the user types a selector.
  const scanWithoutSelection = useCallback(
    async (seq: number, options: { force?: boolean }) => {
      setPhase('no-selection');
      setScan(undefined);
      setStatus('No element selected — type a selector to style it directly.'); // i18n-ignore: write-only status, never rendered.
      const showContent = (content: Content) => {
        if (seq !== seqRef.current || selectedRef.current) {
          return;
        }
        setScan(unselectedScanState(content, pageDocsRef.current.length));
        setScanningMore(!!content.partial);
      };
      const cached = contentRef.current;
      if (cached) {
        showContent(cached);
      }
      setScanningMore(true);
      try {
        const content = await rebuildAndStore({ rescanComponents: options.force }, (partial) => showContent(partial));
        showContent(content);
      } catch (error: unknown) {
        if (seq !== seqRef.current || selectedRef.current) {
          return;
        }
        setScanningMore(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [rebuildAndStore, contentRef, pageDocsRef, selectedRef, seqRef, setPhase, setScan, setScanningMore, setStatus],
  );
  return { scanWithoutSelection };
}

// Scan and resolve a selected element.
export function useScanSelection(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  contentRebuild: ReturnType<typeof useContentRebuild>,
  applyResolveHook: ReturnType<typeof useApplyResolve>,
  backgroundRefreshHook: ReturnType<typeof useBackgroundRefresh>,
) {
  const { contentRef, seqRef, settledElementKeyRef } = editorRefs;
  const { setPhase, setQuickSnapshot, setScan, setScanningMore, setStatus } = scanState;
  const { rebuildAndStore, storeContent } = contentRebuild;
  const { applyResolve } = applyResolveHook;
  const { backgroundRefresh } = backgroundRefreshHook;
  const paintRemembered = useRememberedSnapshot(editorRefs, setScan);

  // The content for the file open now, from memory, synchronously, when every source is in
  // memory (memoryContent.ts): called before the selection resets, so the reset finds an
  // element seen before in this file and draws it in the same render. Undefined when the
  // cached content already serves the element, or a source needs a read.
  const prepareSelection = useCallback(
    (element: unknown, options: { readonly force?: boolean }): Content | undefined => {
      const cached = contentRef.current;
      if (cached !== undefined && options.force !== true) {
        if (cached.scan.elementByKey.get(serializeElementId(element)) === element) {
          return undefined;
        }
        const sameFile = contentForCurrentTree(cached, scanPageNow(), element);
        if (sameFile !== undefined) {
          contentRef.current = sameFile;
          return sameFile;
        }
      }
      const fromMemory = memoryContent();
      if (fromMemory.missing.length > 0 || !scanHasElement(fromMemory.scan, element)) {
        return undefined;
      }
      return storeContent(memoryContentOf(fromMemory, []), { fromMemory: true });
    },
    [contentRef, storeContent],
  );

  // The same with the few sources memory lacks read first (the page a component was opened
  // from, a stylesheet new to the list). Undefined when too many are missing (the first scan)
  // or a read failed or raced a write: the full rebuild then reads, streams and reports.
  const contentWithReads = useCallback(
    async (element: unknown): Promise<Content | undefined> => {
      const fromMemory = memoryContent();
      if (fromMemory.missing.length > MEMORY_MISSING_READS_MAX || !scanHasElement(fromMemory.scan, element)) {
        return undefined;
      }
      const writes = embedWritesStarted();
      const read = await loadEmbedDocs([...fromMemory.missing]);
      if (read.errors.length > 0 || writes !== embedWritesStarted()) {
        return undefined;
      }
      assert(read.docs.length === fromMemory.missing.length, 'contentWithReads: every missing source was read');
      return storeContent(memoryContentOf(fromMemory, read.docs), { fromMemory: true });
    },
    [storeContent],
  );

  const scanSelection = useCallback(
    async (element: unknown, seq: number, options: { force?: boolean }, prepared: Content | undefined) => {
      // Read a fast snapshot (tag + classes) straight off the element so the chips
      // render right away, before the (slower) embed scan produces the full model.
      showSourceSnapshot(element, seq, seqRef, setQuickSnapshot);

      const cached = contentRef.current;
      let reusable = prepared ?? (await reuseSelectedContent(cached, element, options));
      if (seq !== seqRef.current) {
        return;
      }
      if (reusable && reusable !== cached) {
        contentRef.current = reusable;
      }
      // Another file opened, or the list of stylesheets changed: build from memory, reading
      // only what memory lacks, rather than reading every stylesheet again before the chips.
      if (reusable === undefined) {
        reusable = await contentWithReads(element);
        if (seq !== seqRef.current) {
          return;
        }
        // The docs changed under the reset's look-up: an element seen before is drawn now.
        const elementKey = elementSelectionKey(element);
        if (reusable !== undefined && settledElementKeyRef.current !== elementKey) {
          paintRemembered(elementKey);
        }
      }

      if (reusable) {
        // Source-known selectors can show before the new node exists in the
        // canvas. The later DOM answer corrects dynamic classes and selectors.
        await applyResolve(element, reusable, seq, { sourceOnly: true });
        if (seq !== seqRef.current) {
          return;
        }
        await applyResolve(element, reusable, seq);
        void backgroundRefresh();
        return;
      }

      // First load, a context switch, or a forced rescan → rebuild content.
      // Stream: render page-level rules as soon as the page scan finishes.
      setPhase('scanning');
      setStatus(cached ? 'Loading this view…' : 'Scanning embeds…'); // i18n-ignore: write-only status, never rendered.
      try {
        const content = await rebuildAndStore({ rescanComponents: options.force }, (partial) => {
          if (seq === seqRef.current) {
            void applyResolve(element, partial, seq);
          }
        });
        if (seq !== seqRef.current) {
          return;
        }
        await applyResolve(element, content, seq);
      } catch (error: unknown) {
        if (seq !== seqRef.current) {
          return;
        }
        setPhase('ready');
        setScanningMore(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    },
    [
      applyResolve,
      backgroundRefresh,
      contentWithReads,
      paintRemembered,
      rebuildAndStore,
      contentRef,
      seqRef,
      settledElementKeyRef,
      setPhase,
      setQuickSnapshot,
      setScanningMore,
      setStatus,
    ],
  );
  return { prepareSelection, scanSelection };
}

// The most sources a switch reads before drawing (contentWithReads). A switch from memory misses
// one or two (the page a component is open on); past this it is a first scan, which streams.
const MEMORY_MISSING_READS_MAX = 8;

// Memory's content as the panel's Content, once its missing documents are read.
function memoryContentOf(fromMemory: MemoryContent, read: readonly EmbedDocument[]): Content {
  const docs = filledDocuments(fromMemory, read);
  assert(docs.length === fromMemory.scan.embeds.length, 'memoryContentOf: every source has its document');
  return { scan: fromMemory.scan, docs, rules: [], errors: [], embedCount: 0, componentEmbedCount: 0, partial: false };
}

function showSourceSnapshot(element: unknown, seq: number, seqRef: { readonly current: number }, publish: (snapshot: ElementSnapshot) => void): void {
  void buildSnapshot(element)
    .then((snapshot) => {
      if (seq === seqRef.current) {
        publish(snapshot);
      }
    })
    .catch(() => {});
}

async function reuseSelectedContent(cached: Content | undefined, element: unknown, options: { readonly force?: boolean }): Promise<Content | undefined> {
  if (!cached || options.force) {
    return undefined;
  }
  if (cached.scan.elementByKey.get(serializeElementId(element)) === element) {
    return cached;
  }
  // A new sibling does not change the CSS, but it does need fresh ancestry
  // before the source matcher can find the rules that already style it.
  return contentForCurrentTree(cached, await scanPage(), element);
}

// Resolve a selection, counting the passes still in flight.
export function useRefresh(
  editorRefs: ReturnType<typeof useEditorRefs>,
  elementReset: ReturnType<typeof useElementReset>,
  scanWithoutSelectionHook: ReturnType<typeof useScanWithoutSelection>,
  scanSelectionHook: ReturnType<typeof useScanSelection>,
) {
  const { selectedRef, seqRef } = editorRefs;
  const { resetForElement } = elementReset;
  const { scanWithoutSelection } = scanWithoutSelectionHook;
  const { prepareSelection, scanSelection } = scanSelectionHook;

  const resolveSelection = useCallback(
    async (element: unknown, options: { force?: boolean } = {}) => {
      const seq = ++seqRef.current;
      selectedRef.current = element;
      // Before the reset: the reset looks the element up under the docs of the file open now.
      const prepared = element ? prepareSelection(element, options) : undefined;
      resetForElement(element);
      if (!element) {
        await scanWithoutSelection(seq, options);
        return;
      }
      await scanSelection(element, seq, options, prepared);
    },
    [prepareSelection, resetForElement, scanWithoutSelection, scanSelection, selectedRef, seqRef],
  );

  // Whether the panel is still working out what styles the selected element.
  //
  // The chips are blanked the moment the selection changes (another element's
  // selectors are worse than none) and refilled from canvas round trips, so in
  // between, the selector well is empty — and an empty well otherwise says "nothing
  // styles this". The wait needs to be able to say it is a wait. Counted rather than
  // flagged: reselecting starts a second pass before the first has unwound, and the
  // first one finishing does not mean the panel is settled.
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(0);

  const refresh = useCallback(
    async (element: unknown, options: { force?: boolean } = {}) => {
      resolvingRef.current += 1;
      setResolving(true);
      try {
        await resolveSelection(element, options);
      } finally {
        resolvingRef.current -= 1;
        if (resolvingRef.current === 0) {
          setResolving(false);
        }
      }
    },
    [resolveSelection],
  );
  return { refresh, resolving };
}

// Rescan when the stylesheets change, and follow the Designer's selection.
export function useSelectionSubscriptions(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  refreshHook: ReturnType<typeof useRefresh>,
) {
  const { selectedRef, seqRef } = editorRefs;
  const { setPhase, setStatus } = scanState;
  const { refresh } = refreshHook;

  // The project's stylesheets are listed asynchronously (style:listFiles and the
  // Astro global-block scan), and the panel is usually mounted and finished
  // scanning before that list lands: it reads no files, matches nothing, and
  // calls itself ready with an empty well. It used to stay that way until the
  // next background refresh came round — throttled to 4s, which is exactly how
  // long the well sat empty on a layout. Rescan as soon as the list changes
  // instead.
  const sheetSigRef = useRef(sheetSignature());
  useEffect(
    () =>
      onHostChange(() => {
        const sig = sheetSignature();
        if (sig === sheetSigRef.current) {
          return;
        }
        sheetSigRef.current = sig;
        void refresh(selectedRef.current, { force: true });
      }),
    [refresh, selectedRef],
  );

  useEffect(() => {
    const api = webflowApi();
    if (!api?.getSelectedElement) {
      setPhase('unsupported');
      setStatus('The Webflow selection API is unavailable. Open this inside the Designer.'); // i18n-ignore: write-only status, never rendered.
      return;
    }
    void api.getSelectedElement().then((element) => refresh(element));
    // The canvas device is not followed here. It once picked a breakpoint that
    // the context list then offered whether or not any stylesheet held it; the
    // list now names only queries that are written somewhere.
    const unsubscribe = api.subscribe?.('selectedelement', (element) => void refresh(element));
    return () => {
      seqRef.current += 1;
      unsubscribe?.();
    };
  }, [refresh, seqRef, setPhase, setStatus]);
}

// Re-read after undo/redo and class changes, and poll while an element is shown.
export function useChangeSubscriptions(
  scanState: ReturnType<typeof useScanState>,
  backgroundRefreshHook: ReturnType<typeof useBackgroundRefresh>,
  designerSync: ReturnType<typeof useDesignerSync>,
) {
  const { phase } = scanState;
  const { backgroundRefresh } = backgroundRefreshHook;
  const { syncFromDesigner } = designerSync;

  // Undo and redo rewrite the stylesheets and the page model directly, so the
  // panel's cached docs are stale the moment they run. The app bumps a counter;
  // re-read as soon as it moves rather than on the next poll.
  const historyRef = useRef(getHost().historyTick);
  useEffect(
    () =>
      onHostChange(() => {
        const tick = getHost().historyTick;
        if (tick === historyRef.current) {
          return;
        }
        historyRef.current = tick;
        void backgroundRefresh({ now: true });
      }),
    [backgroundRefresh],
  );

  // A class added to (or taken off) the selected element changes which selectors
  // target it — and nothing tells the panel. It used to find out on its next poll,
  // up to 1.5s later, which is the whole of that wait: the stylesheets are already
  // parsed in memory, so re-resolving is one canvas round trip and a re-match, no
  // disk. Nudge it the moment the model changes. The background rebuild that re-reads
  // the files still runs on its own throttle, for edits made outside the app.
  const classSigRef = useRef('');
  useEffect(() => {
    const onClasses = () => {
      const host = getHost();
      const sig = `${authoredClasses().join(' ')}|${(host.renderedClasses || []).join(' ')}`;
      if (sig === classSigRef.current) {
        return;
      }
      const first = classSigRef.current === '';
      classSigRef.current = sig;
      if (!first) {
        void syncFromDesigner();
      }
    };
    onClasses();
    return onHostChange(onClasses);
  }, [syncFromDesigner]);

  // The page around the element changed (a structural edit to its siblings, parent or
  // children, its own attribute or text, an undo, or the rendering that confirms any of them):
  // what its selectors match may have changed with it. One re-ask per frame however many signals
  // arrive, and nothing is cleared meanwhile: the chips stay until the new answer replaces them.
  const nodesRef = useRef(getHost().nodes);
  useEffect(() => {
    let frame: number | undefined;
    const ask = () => {
      if (frame !== undefined) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        void syncFromDesigner();
      });
    };
    const offHost = onHostChange(() => {
      const nodes = getHost().nodes;
      if (nodes !== nodesRef.current) {
        nodesRef.current = nodes;
        ask();
      }
    });
    const offRender = onCanvasRendered(ask);
    return () => {
      offHost();
      offRender();
      if (frame !== undefined) {
        window.cancelAnimationFrame(frame);
      }
    };
  }, [syncFromDesigner]);

  // While an element is shown, poll for out-of-app edits and keep the panel in sync.
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }
    const id = window.setInterval(() => {
      void syncFromDesigner(); // classes / attributes / native styles
      void backgroundRefresh(); // embed-code edits (self-throttled)
    }, DESIGNER_SYNC_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [phase, syncFromDesigner, backgroundRefresh]);
}

// Rebuild the panel's model after an edit.
export function useRefreshDerived(editorRefs: ReturnType<typeof useEditorRefs>, scanState: ReturnType<typeof useScanState>) {
  const { busyRef, classListRef, contentRef, docsRef, pageDocsRef, primedRef, targetRef } = editorRefs;
  const { setScan } = scanState;

  const refreshDerived = useCallback(async () => {
    // The page's computed values were measured against the CSS as it was a
    // moment ago, and an edit is exactly what changes them. They used to be
    // forgotten only when the canvas re-walked its markers — which a CSS-only
    // edit never makes it do, because the dev server delivers CSS by swapping a
    // <style> in <head> rather than re-rendering the page.
    //
    // A control that shows a COMPUTED value while nothing declares its property
    // therefore went on showing the value from before the edit: clear
    // `text-align` and the segment for the old alignment stayed lit, while the
    // canvas behind it had already gone back to the inherited one.
    forgetComputedStyles();
    forgetComputedColors();
    const rules = rebuildRules(docsRef.current);
    if (contentRef.current) {
      contentRef.current.rules = rules;
    }
    const target = targetRef.current;
    if (!target) {
      return;
    }
    // Only re-ask the page when the question changed. domMatched is keyed by
    // selector text, so as long as the same element is selected and the same
    // selectors exist, the answers it holds are still the answers — and an
    // edit that only changed a VALUE (most of them) changes neither. Asking
    // anyway put a round trip, and its 1.5s ceiling, after every click.
    const key = selectorKeyOf(rules);
    if (!(primedRef.current?.target === target && primedRef.current.key === key)) {
      await primeDomMatches(target, rules);
      primedRef.current = { target, key };
    }
    const model = await computeRuleModel(rules, target);
    const placeholders = contentRef.current?.scan.inComponentContext ? computePlaceholders(contentRef.current.docs, classListRef.current) : [];
    setScan((previous) => (previous ? { ...previous, model, placeholders } : previous));
  }, [classListRef, contentRef, docsRef, primedRef, setScan, targetRef]);

  // An undo/redo rewrote a stylesheet and re-parsed its doc in place — re-resolve
  // so the fields show what the file now says. The step's doc may no longer be the
  // one the panel holds (a background read replaced it), so the panel's own docs for
  // that source take the text too.
  useEffect(
    () =>
      onDocsReloaded((reloaded) => {
        adoptReload([...docsRef.current, ...pageDocsRef.current], reloaded);
        void refreshDerived();
      }),
    [docsRef, pageDocsRef, refreshDerived],
  );

  // The page model moved (an undo or redo, a save's reply, a code edit): its `<style>` blocks
  // are read again from the nodes in memory, at once, rather than waiting on a rescan of
  // every stylesheet. While an edit saves, the edit refreshes from its own documents, and
  // the background refresh's revision check catches anything that moved meanwhile.
  const nodesRef = useRef(getHost().nodes);
  useEffect(
    () =>
      onHostChange(() => {
        const nodes = getHost().nodes;
        if (nodes === nodesRef.current) {
          return;
        }
        nodesRef.current = nodes;
        if (busyRef.current) {
          return;
        }
        if (syncNodeDocuments(docsRef.current) > 0) {
          void refreshDerived();
        }
      }),
    [busyRef, docsRef, refreshDerived],
  );
  return { refreshDerived };
}
