import { useErrorToasts } from '../../ui/errorNotices';
import { usePageTitles } from '../../features/pages/usePageTitles';
import { astroChangeMessages } from '../../../shared/properties/astroFileChanges';
// The app's lifecycle: picking assets, toasts, dev-server events, project
// scans, starting the preview, the savers and flushing them, opening a file,
// and composing the core state they share (App.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useToastStack, type ToastNotice } from '../../features/notifications/useToastStack';
import type { ScanResult } from '../../../shared/properties/projectScan';
import { createPreviewWatch } from '../../features/preview/previewRecovery';
import { tellCanvas } from '../../editor/canvasQuery';
import { readPage, scanProject } from '../../ipc/bridge';
import { assert } from '../../../shared/core/assert';
import { onAssetRequest, clearAssetRequest } from '../../ui/assetPick';
import { createFileSaver, createPageSaver, type PageSaver } from '../../editor/pagePersistence';
import { createEntrySender } from '../../editor/pageSender';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { EditDrafts } from '../../editor/pageEdits';
import { type RejectionReason } from '../../../shared/engine/intent';
import { cleanError, stripAnsi } from '../../lib/cleanError';
import { type AppHistory, type ProjectScans, type ToastKind } from '../appTypes';
import { toEditorPageState, type CurrentPage, type EditorPageState, type OpenFile } from '../../editor/pageState';
import {
  closeProject,
  onFilesChanged,
  diagnoseProject,
  onAppProgress,
  onDevExit,
  onPreviewFailed,
  onDevLog,
  onPageMaybeChanged,
  probeProjectPreview,
  readProjectClasses,
  startProjectPreview,
  stopProjectPreview,
  editProjectPage,
  editProjectPageBatch,
} from '../../ipc/appBridge';
import { type OpenFileOptions, openFileSelection, parseTrailingSlash } from '../model/nodeFactory';
import { savedForNavigation } from '../model/appKeys';
import { keepsAcrossPages } from '../model/pageQueries';
import {
  useProjectState,
  useCanvasReportState,
  useDevState,
  useDataState,
  usePanelState,
  useWindowState,
  useSessionRefs,
  useTypedCodeRefs,
  usePseudoPickFollowsSelection,
} from './appState';

// The app’s state.
export function useCoreState() {
  const projectState = useProjectState();
  const canvasReportState = useCanvasReportState();
  const devState = useDevState();
  const dataState = useDataState();
  const panelState = usePanelState(canvasReportState, projectState);
  const windowState = useWindowState();
  const sessionRefs = useSessionRefs(projectState);
  const typedCodeRefs = useTypedCodeRefs(sessionRefs, projectState, canvasReportState, panelState);
  usePseudoPickFollowsSelection({ ...projectState, ...canvasReportState });
  return {
    ...projectState,
    ...canvasReportState,
    ...devState,
    ...dataState,
    ...panelState,
    ...windowState,
    ...sessionRefs,
    ...typedCodeRefs,
  };
}

// Why the dev server is down, and the asset picker errand.
export function useAssetPick(coreState: ReturnType<typeof useCoreState>) {
  const { projectRef, setAssetPick, setDevDiag, setLeftTab, setRevealTick } = coreState;
  const { tabBeforePick } = coreState;

  // ----------------------------------------------------------------
  // Toasts & events
  // ----------------------------------------------------------------

  // Why the dev server isn't running (missing Node, a Node too old for the
  // project's Astro, uninstalled deps). Only asked for once it has failed —
  // the answer is what the offline pane explains instead of a raw log.
  // projectRef is declared further down, but this only reads it when called.
  const diagnose = useCallback(() => {
    const projectPath = projectRef.current?.path;
    if (!projectPath) {
      return;
    }
    diagnoseProject(projectPath)
      .then((diagnosis) => setDevDiag(diagnosis))
      .catch(() => setDevDiag(undefined));
  }, [projectRef, setDevDiag]);

  // `picked` is passed as literal true by the pick itself — the Cancel button
  // hands this its click event, which must not read as a pick.
  const endAssetPick = useCallback(
    (picked: unknown) => {
      clearAssetRequest();
      setAssetPick(undefined);
      setLeftTab((tab) => {
        if (tab !== 'assets') {
          return tab;
        }
        // Answering the field ends the errand: show the element it belongs to
        // rather than leaving the user parked in the asset browser — including
        // when the browser is where they started, which used to strand them.
        // Cancelling changed nothing, so that goes back where they came from.
        return picked === true ? 'navigator' : tabBeforePick.current || 'navigator';
      });
      tabBeforePick.current = undefined;
      // The navigator opens on the element that was just given an asset, not
      // wherever it happened to be scrolled.
      if (picked === true) {
        setRevealTick((count) => count + 1);
      }
    },
    [setAssetPick, setLeftTab, setRevealTick, tabBeforePick],
  );

  useEffect(() => {
    return onAssetRequest((request) => {
      if (!request) {
        return;
      } // cleared from this side already
      setAssetPick({
        ...request,
        // The entry rides along: which root it came from decides whether the
        // field writes a URL, an import, or a path relative to its own file.
        onPick: (rel, entry) => {
          request.onPick(rel, entry);
          endAssetPick(true);
        },
      });
      // An overlay pick leaves the panels as they are: the pop-up answers it.
      if (request.presentation === 'overlay') {
        return;
      }
      setLeftTab((tab) => {
        if (tab !== 'assets') {
          tabBeforePick.current = tab;
        }
        return 'assets';
      });
    });
  }, [endAssetPick, setAssetPick, setLeftTab, tabBeforePick]);
  return { diagnose, endAssetPick };
}

// Toasts, and failures said the way the app says any failure.
export function useToasts() {
  const { notices, push, dismiss } = useToastStack<ToastNotice>();
  useErrorToasts(push, dismiss);
  const showToast = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      push({ id: crypto.randomUUID(), message, kind });
    },
    [push],
  );
  const reportFailure = useCallback((error: unknown) => showToast(cleanError(error), 'error'), [showToast]);
  useEffect(
    () =>
      onFilesChanged(({ astroChanges }) => {
        for (const message of astroChangeMessages(astroChanges)) {
          showToast(message);
        }
      }),
    [showToast],
  );
  return { notices, dismissToast: dismiss, reportFailure, showToast };
}

// Progress, dev server output, and recovering the preview after an error.
export function useDevEvents(coreState: ReturnType<typeof useCoreState>, assetPickScope: ReturnType<typeof useAssetPick>) {
  const { devLogRef, setBusy, setDevLog, setDevStatus, setDevUrl } = coreState;
  const { diagnose } = assetPickScope;
  const recovery = usePreviewRecovery(coreState);

  useEffect(() => {
    const offProgress = onAppProgress((message) => setBusy(message));
    const offExit = onDevExit((log) => {
      setDevStatus('off');
      setDevUrl(undefined);
      if (log) {
        devLogRef.current = log;
        setDevLog(log);
      }
      diagnose();
    });
    const offLog = onDevLog((chunk) => {
      devLogRef.current = stripAnsi(devLogRef.current + chunk).slice(-4000);
      setDevLog(devLogRef.current);
    });
    return () => {
      offProgress();
      offExit();
      offLog();
    };
  }, [diagnose, devLogRef, setBusy, setDevLog, setDevStatus, setDevUrl]);
  return recovery;
}

// Recovering the preview after a compile error. The frame load seeds a check,
// so startup and navigation errors recover even when no file watcher fires.
function usePreviewRecovery(coreState: ReturnType<typeof useCoreState>) {
  const { devUrl, livePathRef, setRefreshKey } = coreState;
  const previewWatchRef = useRef<ReturnType<typeof createPreviewWatch> | undefined>(undefined);
  const previewLoadPendingRef = useRef(false);
  const previewLoaded = useCallback((): void => {
    const watch = previewWatchRef.current;
    if (watch === undefined) {
      previewLoadPendingRef.current = true;
      return;
    }
    watch.poke();
  }, []);
  // See src/features/preview/previewRecovery.ts for what this is for and why it asks the server
  // rather than reading the error screen or the log.
  // The route is read through `livePathRef` rather than named as a dependency:
  // it is assigned far below this hook, so a dep array mentioning it reads it
  // before its declaration and the whole app throws (see test/renderer/app/appRenders.test.js,
  // which is here because that has happened before). The ref is current by the
  // time a probe actually runs, and the watch has no reason to be rebuilt just
  // because the route changed.
  useEffect(() => {
    if (!devUrl) {
      return undefined;
    }
    // Both of these arrive with the main process, which does not reload when the
    // renderer does (see VITE_DEV_SERVER_URL): a renderer newer than the bridge
    // would call undefined and take the app down with it. Absent means there is
    // nothing to ask, which is the same answer as having no dev server.
    if (typeof window.avb.probeDevPage !== 'function' || typeof window.avb.onPageMaybeChanged !== 'function') {
      return undefined;
    }
    const watch = createPreviewWatch({
      probe: () => probeProjectPreview(devUrl + (livePathRef.current || '/')),
      onRecover: () => setRefreshKey((count) => count + 1),
    });
    previewWatchRef.current = watch;
    if (previewLoadPendingRef.current) {
      previewLoadPendingRef.current = false;
      watch.poke();
    }
    const offFailure = subscribePreviewFailure(devUrl, livePathRef, watch);
    // Every write the app makes, plus every change made outside it.
    const offWrite = onPageMaybeChanged((event) => {
      watch.poke();
      // A change from outside the app — an editor, a script, a checkout. The
      // canvas normally hears about it over the dev server's HMR socket, and
      // when that socket has gone quiet (a dev server restarted under a canvas
      // that stayed open, a machine that slept) nothing says so: the page just
      // stops updating and the only way to see an edit is the refresh button.
      // The app's own watcher saw this change, so it says it directly too.
      if (event.external) {
        tellCanvas({ type: 'avb:patch-now' });
      }
    });
    return () => {
      offWrite();
      offFailure();
      watch.stop();
      if (previewWatchRef.current === watch) {
        previewWatchRef.current = undefined;
      }
    };
  }, [devUrl, livePathRef, setRefreshKey]);
  return { previewLoaded };
}

// Only the currently displayed page may trigger recovery; a late failure from
// a previous page or another iframe must not interrupt the user's navigation.
function subscribePreviewFailure(origin: string, path: { readonly current: string | undefined }, watch: ReturnType<typeof createPreviewWatch>): () => void {
  if (typeof window.avb.onPreviewFailed !== 'function') {
    return () => {};
  }
  return onPreviewFailed((failedURL) => {
    if (failedURL === new URL(path.current || '/', origin).href) {
      watch.failed();
    }
  });
}

// Project scans: one in flight, at most one waiting.
export function useScans(coreState: ReturnType<typeof useCoreState>) {
  const { setProjectClasses, setScan, setTrailingSlash } = coreState;
  usePageTitles(coreState);

  // ----------------------------------------------------------------
  // Project lifecycle
  // ----------------------------------------------------------------

  // One scan in flight per project and at most one waiting (src/lib/coalescedRun.ts):
  // mutations and watcher events that ask together share the scan after them,
  // so every caller — above all one deciding a file was deleted — sees a scan
  // that began after it asked. A scan is applied only when nothing newer waits
  // behind it, and never for a project closed since.
  const projectScansRef = useRef<ProjectScans | undefined>(undefined);
  const rescan = useCallback(
    (projectPath: string): Promise<ScanResult> => {
      let scans = projectScansRef.current;
      if (scans?.projectPath !== projectPath) {
        const opened: ProjectScans = {
          projectPath,
          // The bridge parses the payload against the scan contract before any of
          // this code sees it.
          scans: createCoalescedRun(async () => {
            const result = await scanProject(projectPath);
            if (projectScansRef.current === opened && !opened.scans.superseded()) {
              setScan(result);
              if (result.trailingSlash) {
                setTrailingSlash(parseTrailingSlash(result.trailingSlash));
              }
              readProjectClasses(projectPath)
                .then((classes) => {
                  if (projectScansRef.current === opened) {
                    setProjectClasses(classes || []);
                  }
                })
                .catch(() => {});
            }
            return result;
          }),
        };
        scans = opened;
        projectScansRef.current = opened;
      }
      assert(scans.projectPath === projectPath, 'A rescan asks its own project');
      return scans.scans.request();
    },
    [setProjectClasses, setScan, setTrailingSlash],
  );
  return { rescan };
}

// Starting the project’s dev server.
export function usePreviewStart(
  coreState: ReturnType<typeof useCoreState>,
  toasts: ReturnType<typeof useToasts>,
  assetPickScope: ReturnType<typeof useAssetPick>,
) {
  const { devLogRef, setBusy, setDevDiag, setDevLog, setDevStatus, setDevUrl } = coreState;
  const { setTrailingSlash } = coreState;
  const { showToast } = toasts;
  const { diagnose } = assetPickScope;

  const startPreview = useCallback(
    async (projectPath: string) => {
      setDevStatus('starting');
      setDevUrl(undefined);
      try {
        const started = await startProjectPreview(projectPath);
        const { url, trailingSlash: resolved } = started;
        setDevUrl(url);
        if (resolved) {
          setTrailingSlash(parseTrailingSlash(resolved));
        }
        setDevStatus('on');
        setDevDiag(undefined);
        if ('external' in started && started.external) {
          showToast(
            `Reusing the dev server already running for this project (${url}) — ` +
              "canvas outlines need the app's own server, so stop that one to enable them.",
            'info',
          );
        }
      } catch (error: unknown) {
        setDevStatus('off');
        setDevUrl(undefined);
        setBusy(undefined);
        const message = cleanError(error);
        showToast(`Preview failed to start: ${message}`, 'error');
        devLogRef.current = message;
        setDevLog(message);
        diagnose();
      }
    },
    [showToast, diagnose, devLogRef, setBusy, setDevDiag, setDevLog, setDevStatus, setDevUrl, setTrailingSlash],
  );
  return { startPreview };
}

// A checkout temporarily removes drafts and may replace the Astro configuration.
// Keep the iframe and dev watcher out of that intermediate filesystem state.
export function useBranchPreview(coreState: ReturnType<typeof useCoreState>, startPreview: (projectPath: string) => Promise<void>) {
  const { projectRef, setDevStatus, setDevUrl } = coreState;
  return useCallback(
    async <Value>(work: () => Promise<Value>): Promise<Value> => {
      const project = projectRef.current;
      assert(project !== undefined, 'Switching branches requires an open project');
      setDevUrl(undefined);
      setDevStatus('starting');
      try {
        await stopProjectPreview();
        return await work();
      } finally {
        // A failed checkout still needs the original branch's preview back.
        if (projectRef.current?.path === project.path) {
          await startPreview(project.path);
        }
      }
    },
    [projectRef, setDevStatus, setDevUrl, startPreview],
  );
}

// The page and file savers, and the page’s unsent edit requests.
export function useSavers(toasts: ReturnType<typeof useToasts>, coreState: ReturnType<typeof useCoreState>) {
  const { showToast } = toasts;
  const { pageStateRef, setPageState } = coreState;

  // ----------------------------------------------------------------
  // Page loading & saving
  // ----------------------------------------------------------------

  const fileSaverRef = useRef<ReturnType<typeof createFileSaver> | undefined>(undefined);
  if (!fileSaverRef.current) {
    fileSaverRef.current = createFileSaver({
      onError: (error) => showToast(`Save failed: ${cleanError(error)}`, 'error'),
    });
  }
  // The open page's unsent edit requests (step 6, pageEdits.ts).
  const editDraftsRef = useRef<EditDrafts | undefined>(undefined);
  editDraftsRef.current ??= new EditDrafts();
  const editDrafts = editDraftsRef.current;
  // Why the last edit request was refused, for the conflict notice (plan §7).
  const [conflictReason, setConflictReason] = useState<RejectionReason | undefined>(undefined);
  const pageSaverRef = useRef<PageSaver | undefined>(undefined);
  if (!pageSaverRef.current) {
    // A change to the open page's state from the saver: seen at once through
    // the ref (the next entry is stated against the origin it installs), and
    // applied to whatever React holds by then.
    const updatePage = (path: string, change: (current: EditorPageState) => EditorPageState): void => {
      const now = pageStateRef.current;
      if (now.currentPage?.path !== path || !now.pageState) {
        return; // Another page opened meanwhile: this one's outcome is not shown.
      }
      pageStateRef.current = { currentPage: now.currentPage, pageState: change(now.pageState) };
      setPageState((current) => (current ? change(current) : current));
    };
    pageSaverRef.current = createPageSaver({
      queue: editDrafts,
      currentPath: () => pageStateRef.current.currentPage?.path,
      conflicted: () => pageStateRef.current.pageState?.save.tag === 'conflicted',
      send: createEntrySender({
        queue: editDrafts,
        state: () => pageStateRef.current.pageState,
        update: updatePage,
        conflict: (reason) => setConflictReason(reason),
        notice: (message) => showToast(message, 'error'),
        onAppliedUrgentEdit: () => {
          tellCanvas({ type: 'avb:patch-now' });
        },
        edit: editProjectPage,
        editBatch: editProjectPageBatch,
        read: readPage,
      }),
    });
  }
  const fileSaver = fileSaverRef.current;
  const pageSaver = pageSaverRef.current;
  return {
    conflictReason,
    editDrafts,
    fileSaver,
    fileSaverRef,
    pageSaver,
    pageSaverRef,
    setConflictReason,
  };
}

// Saving before moving on, the page history’s owner, and leaving the project.
export function useFlushing(savers: ReturnType<typeof useSavers>, coreState: ReturnType<typeof useCoreState>, toasts: ReturnType<typeof useToasts>) {
  const { fileSaver, pageSaver } = savers;
  const { pageStateRef, saveTimer } = coreState;
  const { showToast } = toasts;

  // Autosave: a conflicted page simply stays unsaved (plan §7).
  const autosave = useCallback(() => Promise.all([pageSaver.flush(), fileSaver.flush()]), [fileSaver, pageSaver]);
  // Everything else that flushes needs the edits on disk before it goes on:
  // navigating away, committing, reading lines back off the file. A conflicted
  // page's edits are not there, so the caller must stop rather than discard or
  // ignore them — they are only ever given up by "Reload from disk".
  const flushSave = useCallback(async () => {
    clearTimeout(saveTimer.current);
    const [page] = await autosave();
    if (page === 'conflicted') {
      const name = pageStateRef.current.currentPage?.name ?? 'This page';
      throw new Error(`${name} has unsaved edits that conflict with a change on disk. ` + 'Reload it or review it in code first.');
    }
  }, [autosave, pageStateRef, saveTimer]);

  // Only the most recent navigation is allowed to install its read result.
  // The latest navigation, as an identity token: a read that finds another
  // token here was superseded, and installs nothing. No counter is kept.
  const pageLoadRef = useRef<object>({});

  const historyRef = useRef<AppHistory>({ past: [], future: [], lastPush: 0, lastKey: undefined });

  // Snapshots belong to one page, so they're dropped when that page closes;
  // commands carry their own inverse and stay, and so do applied edits: their
  // inverses name the checksums they apply to, so after an outside edit they
  // map through it or are refused — they never revert it (step 6).
  const dropPageHistory = useCallback(() => {
    const history = historyRef.current;
    history.past = history.past.filter(keepsAcrossPages);
    history.future = history.future.filter(keepsAcrossPages);
    history.lastKey = undefined;
    history.lastPush = 0;
  }, []);

  // Leaving a project. Main lets go of everything the project had running and
  // starts the window over — forty pieces of state, an undo stack, a canvas
  // holding a page, a watcher and a dev server all belong to the project that
  // was open, and a fresh renderer is the only way to be certain none of it is
  // still here when the next one opens. `next` is the project to open after,
  // which main holds for the window that comes back: a choice made before a
  // reload has to survive it. Anything unsaved goes to disk first.
  const leaveProject = useCallback(
    async (next: string | undefined = undefined) => {
      try {
        await flushSave();
      } catch (error: unknown) {
        showToast(`Couldn’t close the project: ${cleanError(error)}`, 'error');
        return;
      }
      await closeProject(next);
    },
    [flushSave, showToast],
  );
  return { autosave, dropPageHistory, flushSave, historyRef, leaveProject, pageLoadRef };
}

// Opening a page or a component file for editing.
export function useOpenFile(
  flushing: ReturnType<typeof useFlushing>,
  toasts: ReturnType<typeof useToasts>,
  coreState: ReturnType<typeof useCoreState>,
  scans: ReturnType<typeof useScans>,
) {
  const { dropPageHistory, flushSave, pageLoadRef } = flushing;
  const { showToast } = toasts;
  const { pageStateRef, projectRef, setCurrentPage, setEditStack, setHoverNodeId, setPageState } = coreState;
  const { setSelectedId } = coreState;
  const { rescan } = scans;

  // Opens any .astro file for editing — a page, or a component drilled into.
  // `currentPage` is simply whatever is being edited, so saving, undo, the
  // navigator, and the props panel all follow without special cases.
  const openFile = useCallback(
    async (entry: OpenFile, options: OpenFileOptions) => {
      const request = {};
      pageLoadRef.current = request;
      const latestRequest = () => request === pageLoadRef.current;
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      const beforeRead = pageStateRef.current;
      let result: EditorPageState;
      try {
        const read = await readPage(entry.path);
        result = toEditorPageState(read);
      } catch (error: unknown) {
        if (request === pageLoadRef.current) {
          showToast(`Couldn’t open ${entry.name}: ${cleanError(error)}`, 'error');
        }
        return;
      }
      if (request !== pageLoadRef.current) {
        return;
      }
      // The existing editor stays mounted while reading. Save anything typed
      // in that interval before handing the editor to the destination file.
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      // The scan is what every instance of a component reads its props and
      // slots from, and the app's own saves never reach it: the watcher drops
      // a write it hears coming back (projectWatcher.ts). A component file
      // edited while open — a <slot> typed in code — would leave the page's
      // instances offering the old settings until some unrelated event
      // rescanned. Leaving the file is when those instances come back into
      // view, so the scan is brought up to date, after the last save, first.
      if (leavesComponentFile(beforeRead.currentPage, entry)) {
        const project = projectRef.current;
        assert(project !== undefined, 'A component is open only inside a project');
        await rescanBeforeOpen(project.path, rescan);
        if (!latestRequest()) {
          return;
        }
      }
      const latest = pageStateRef.current;
      // Reopening the same file must not replace an edit made during the read
      // with the older snapshot that read returned.
      if (latest.currentPage?.path === entry.path && latest.pageState && latest.pageState !== beforeRead.pageState) {
        result = latest.pageState;
      }
      const nextState = result;
      // Publish path, model and stack together. Clearing the model first would
      // unmount the inspector and resize the whole preview during every drill.
      pageStateRef.current = { currentPage: entry, pageState: nextState };
      setEditStack(options.nextStack);
      setCurrentPage(entry);
      setPageState(nextState);
      setHoverNodeId(undefined);
      const start = openFileSelection(entry, result, options.selectionPath);
      setSelectedId(start?.id ?? undefined);
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    },
    [
      flushSave,
      showToast,
      dropPageHistory,
      pageLoadRef,
      pageStateRef,
      projectRef,
      rescan,
      setCurrentPage,
      setEditStack,
      setHoverNodeId,
      setPageState,
      setSelectedId,
    ],
  );
  return { openFile };
}

// Whether a navigation leaves a component (or layout) file for another file:
// the one case whose own saves can change what the scan says about it.
export function leavesComponentFile(from: CurrentPage | undefined, to: OpenFile): boolean {
  assert(to.path.length > 0, 'A navigation names the file it opens');
  if (from === undefined) {
    return false;
  }
  switch (from.kind) {
    case 'component':
      assert(from.path.length > 0, 'An open component has a path');
      return from.path !== to.path;
    case 'page':
    case 'route':
      return false;
    default: {
      const exhaustive: never = from;
      return exhaustive;
    }
  }
}

// A failed scan must not trap the user inside the component: the file is
// saved, and the next scan (any watcher event, the window regaining focus)
// brings the settings up to date. The navigation goes on without it.
async function rescanBeforeOpen(projectPath: string, rescan: (projectPath: string) => Promise<ScanResult>): Promise<void> {
  assert(projectPath.length > 0, 'A rescan names its project');
  try {
    await rescan(projectPath);
  } catch (error: unknown) {
    console.warn(`Scan after leaving a component failed: ${String(error)}`);
  }
}
