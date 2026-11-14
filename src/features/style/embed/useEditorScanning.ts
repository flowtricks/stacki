// Keeping the scan current: the throttled background refresh, re-matching,
// polling the designer, resetting the element, scanning with and without a
// selection, the refresh the panel asks for, the subscriptions that trigger
// one, and refreshing what is derived from it (EmbedEditor.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { forgetComputedStyles } from '../model/computedStyle';
import { forgetComputedColors } from '../model/computedColor';
import { computeRuleModel } from '../model/cascade';
import { type MatchTarget } from '../model/selectors';
import { getHost, onHostChange } from '../model/host';
import { buildSnapshot, onDocsReloaded, rebuildRules, primeDomMatches, scanHasElement, serializeElementId, scanPage, webflowApi } from '../model/webflow';
import type { ElementSnapshot } from '../model/styleTypes';
import { EMPTY_RULE_MODEL, computePlaceholders } from './EditorBasics';
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
  nativeSignature,
  authoredClasses,
  contentForCurrentTree,
} from './editorModel';
import { useEditorRefs, useScanState, useSelectionState, useNativeState, useContentRebuild, useApplyResolve } from './useEditorFoundation';

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

  // Rebuild content in the background (coalesced + throttled) to pick up embed
  // edits, then re-resolve the current selection — without blocking the UI.
  const backgroundRefresh = useCallback(
    async ({ now = false }: { now?: boolean } = {}) => {
      if (refreshingRef.current || busyRef.current) {
        return;
      }
      // `now` skips the throttle: something rewrote the files or the model out
      // from under the panel (an undo), and waiting out a polling interval to
      // notice is what made the panel trail the canvas.
      if (!now && Date.now() - lastScanAtRef.current < BG_REFRESH_THROTTLE_MS) {
        return;
      }
      refreshingRef.current = true;
      // Failed network refreshes need the same backoff as successful scans.
      lastScanAtRef.current = Date.now();
      setRefreshing(true);
      try {
        const content = await rebuildAndStore();
        const element = selectedRef.current;
        if (element && scanHasElement(content.scan, element)) {
          await applyResolve(element, content, seqRef.current, { silent: true });
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
  const { busyRef, contentRef, lastSnapSigRef, refreshingRef, selectedRef } = editorRefs;
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
    if (!snapChanged && !nativeChanged) {
      return;
    }
    lastSnapSigRef.current = snapSig;
    if (nativeChanged) {
      nativeModelRef.current = native;
      setNativeModel(native);
    }
    if (snapChanged) {
      await rematchChanged(element, content, { target, snap, asked });
    }
  }, [rematchChanged, busyRef, contentRef, lastSnapSigRef, nativeModelRef, refreshingRef, selectedRef, setNativeModel]);
  return { syncFromDesigner };
}

// Forget the previous element's picks when another element is selected.
export function useElementReset(
  editorRefs: ReturnType<typeof useEditorRefs>,
  scanState: ReturnType<typeof useScanState>,
  selectionState: ReturnType<typeof useSelectionState>,
  nativeState: ReturnType<typeof useNativeState>,
) {
  const { selectedElementKeyRef } = editorRefs;
  const { setQuickSnapshot, setScan } = scanState;
  const { pendingDefaultRef, setSelectedSelectorText, setSelectedTokens, setStateKey, tokenIdentityRef } = selectionState;
  const { nativeIdentityRef, nativeModelRef, setNativeModel } = nativeState;

  // A new element must not inherit the previous one's picked selector. Reset the
  // moment the SELECTED ELEMENT changes (not when its token signature does — those
  // can collide across elements), then the tokens effect re-defaults it.
  const resetForElement = useCallback(
    (element: unknown) => {
      const elementKey = element ? serializeElementId(element) : '';
      if (elementKey === selectedElementKeyRef.current) {
        return;
      }
      selectedElementKeyRef.current = elementKey;
      setSelectedSelectorText(undefined);
      setSelectedTokens([]);
      setStateKey('');
      setQuickSnapshot(undefined); // drop the previous element's chips
      // The chips are derived from these two models, and both are refilled by
      // async reads. Left alone they keep listing the PREVIOUS element's
      // selectors as if they were this one's. Blank them now and mark the scan
      // unsettled: the well then keeps drawing its last settled list, inert,
      // until the new one has landed whole (heldSelection.ts), so neither the
      // blank nor the stages in between reach the screen.
      setScan((previous) =>
        previous ? { ...previous, rootSnapshot: undefined, model: EMPTY_RULE_MODEL, settled: false, awaitingFirstAnswer: true } : previous,
      );
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
      pendingDefaultRef,
      selectedElementKeyRef,
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
  const { contentRef, seqRef } = editorRefs;
  const { setPhase, setQuickSnapshot, setScanningMore, setStatus } = scanState;
  const { rebuildAndStore } = contentRebuild;
  const { applyResolve } = applyResolveHook;
  const { backgroundRefresh } = backgroundRefreshHook;

  const scanSelection = useCallback(
    async (element: unknown, seq: number, options: { force?: boolean }) => {
      // Read a fast snapshot (tag + classes) straight off the element so the chips
      // render right away, before the (slower) embed scan produces the full model.
      showSourceSnapshot(element, seq, seqRef, setQuickSnapshot);

      const cached = contentRef.current;
      const reusable = await reuseSelectedContent(cached, element, options);
      if (seq !== seqRef.current) {
        return;
      }
      if (reusable && reusable !== cached) {
        contentRef.current = reusable;
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
    [applyResolve, backgroundRefresh, rebuildAndStore, contentRef, seqRef, setPhase, setQuickSnapshot, setScanningMore, setStatus],
  );
  return { scanSelection };
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
  const { scanSelection } = scanSelectionHook;

  const resolveSelection = useCallback(
    async (element: unknown, options: { force?: boolean } = {}) => {
      const seq = ++seqRef.current;
      selectedRef.current = element;
      resetForElement(element);
      if (!element) {
        await scanWithoutSelection(seq, options);
        return;
      }
      await scanSelection(element, seq, options);
    },
    [resetForElement, scanWithoutSelection, scanSelection, selectedRef, seqRef],
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
  const { classListRef, contentRef, docsRef, primedRef, targetRef } = editorRefs;
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
  // so the fields show what the file now says.
  useEffect(
    () =>
      onDocsReloaded(() => {
        void refreshDerived();
      }),
    [refreshDerived],
  );
  return { refreshDerived };
}
