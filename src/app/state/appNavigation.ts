// Moving around the project: selecting a page, the project menu, going to a
// URL, reloading, opening a component, previewing a commit, git info, and
// composing the lifecycle (App.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScanResult } from '../../../shared/properties/projectScan';
import type { WireCommitInfo, WireInjectedRoute } from '../../../shared/ipc/ipcResults';
import { readPage } from '../../ipc/bridge';
import { readGitInfo } from '../../features/git/gitChipBridge';
import { assert } from '../../../shared/core/assert';
import { scanContainsFile } from '../../editor/pagePersistence';
import { cleanError } from '../../lib/cleanError';
import { toEditorPageState, carriedParse, type OpenFile } from '../../editor/pageState';
import {
  addRecentProject,
  installProjectDependencies,
  openProject,
  pendingProject,
  previewProjectCommit,
  projectHasNodeModules,
  resolveProjectImport,
  stopProjectCommitPreview,
  watchProject,
} from '../../ipc/appBridge';
import { componentEntry } from '../model/pageGestures';
import { savedForNavigation, componentAtPath, componentNamed, stackWith } from '../model/appKeys';
import {
  useCoreState,
  useAssetPick,
  useToasts,
  useDevEvents,
  useScans,
  usePreviewStart,
  useSavers,
  useFlushing,
  useOpenFile,
} from './appLifecycle';

// Notices, the dev server and the project’s lifecycle.
export function useLifecycle(coreState: ReturnType<typeof useCoreState>) {
  const assetPickScope = useAssetPick(coreState);
  const toasts = useToasts();
  const devEvents = useDevEvents(coreState, assetPickScope);
  const scans = useScans(coreState);
  const previewStart = usePreviewStart(coreState, toasts, assetPickScope);
  const savers = useSavers(toasts, coreState);
  const flushing = useFlushing(savers, coreState, toasts);
  const openFileScope = useOpenFile(flushing, toasts, coreState);
  return {
    ...assetPickScope,
    ...toasts,
    ...devEvents,
    ...scans,
    ...previewStart,
    ...savers,
    ...flushing,
    ...openFileScope,
  };
}

// Opening a page, and opening a project.
export function useSelectPage(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { openFile, rescan, showToast, startPreview } = lifecycle;
  const { setBusy, setDevice, setLeftTab, setProject } = coreState;

  // What's typed in the URL bar while it's being edited; undefined means "show the
  // real one". Kept separate so the bar keeps tracking the canvas until you
  // actually start typing.
  const [urlDraft, setUrlDraft] = useState<string | undefined>(undefined);

  const selectPage = useCallback(
    async (page: ScanResult['pages'][number]) => {
      // Opening a page from the switcher leaves any component drill-down.
      const entry: OpenFile = { ...page, kind: 'page' };
      await openFile(entry, { nextStack: [entry], selectionPath: undefined });
    },
    [openFile],
  );

  const loadProject = useCallback(
    async (projectPath: string) => {
      const name = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
      setProject({ path: projectPath, name });
      setLeftTab('navigator');
      // Every project opens on desktop — a breakpoint left over from the
      // last project isn't a choice the user made about this one.
      setDevice('desktop');
      void addRecentProject(projectPath).catch(() => {});
      // Starting the watch records the open project in the main process, which
      // allows file access only inside it. It goes out before the first await, so
      // it reaches main before any panel that mounts with the project reads a file.
      void watchProject(projectPath)
        .then((started) => {
          if (!started) {
            showToast('Couldn’t watch project files. External edits may need a refresh.', 'error');
          }
        })
        .catch((error: unknown) => {
          showToast(`Couldn’t watch project files: ${cleanError(error)}`, 'error');
        });
      const result = await rescan(projectPath);

      const hasDeps = await projectHasNodeModules(projectPath);
      if (!hasDeps) {
        try {
          await installProjectDependencies(projectPath);
        } catch (error: unknown) {
          showToast(cleanError(error), 'error');
        }
        setBusy(undefined);
      }
      // startPreview reports its own failure in the preview area.
      void startPreview(projectPath);

      const first =
        result.pages.find((page) => page.name === 'index.astro') || result.pages[0] || undefined;
      if (first) {
        // Opening a page reports its own failures as toasts.
        void selectPage(first);
      }
    },
    [rescan, startPreview, selectPage, showToast, setBusy, setDevice, setLeftTab, setProject],
  );

  // A window can come up owing a project: one was picked from the menu and the
  // window reloaded to let go of the last one, or (in dev) the code was reloaded
  // under a project that was open. Nothing on a cold start and after a window
  // somebody closed, both of which belong on the welcome screen.
  const reopenedRef = useRef(false);
  useEffect(() => {
    if (reopenedRef.current || !window.avb.pendingProject) {
      return;
    }
    reopenedRef.current = true;
    pendingProject()
      .then((path) => {
        if (path) {
          return loadProject(path);
        }
        return undefined;
      })
      .catch(() => {});
  }, [loadProject]);
  return { loadProject, selectPage, setUrlDraft, urlDraft };
}

// The project menu, and pointing the canvas at an injected route.
export function useProjectMenu(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  selectPageScope: ReturnType<typeof useSelectPage>,
) {
  const { projectRef, setCurrentPage, setEditStack, setHoverNodeId, setPageState } = coreState;
  const { setSelectedId } = coreState;
  const { flushSave, leaveProject, pageLoadRef, reportFailure, showToast } = lifecycle;
  const { loadProject } = selectPageScope;

  useEffect(() => {
    const offClose = window.avb.onMenu('closeProject', () => {
      if (projectRef.current) {
        void leaveProject();
      }
    });
    const openFromMenu = async (): Promise<void> => {
      const picked = await openProject();
      const next = !picked.canceled && 'projectPath' in picked ? picked.projectPath : undefined;
      if (!next) {
        return;
      }
      // Nothing open yet: this IS the welcome screen's own button.
      if (!projectRef.current) {
        await loadProject(next);
        return;
      }
      await leaveProject(next);
    };
    const offOpen = window.avb.onMenu('openProject', () => {
      void openFromMenu().catch(reportFailure);
    });
    return () => {
      offClose?.();
      offOpen?.();
    };
  }, [leaveProject, loadProject, reportFailure, projectRef]);

  // An injected route has no file in this project to open — its source lives
  // in a dependency — so this points the canvas at it and leaves the editor
  // empty rather than pretending there is a model behind it.
  const selectRoute = useCallback(
    async (entry: WireInjectedRoute) => {
      const request = {};
      pageLoadRef.current = request;
      const latestRequest = () => request === pageLoadRef.current;
      if (!(await savedForNavigation(flushSave, latestRequest, showToast))) {
        return;
      }
      setEditStack([]);
      setCurrentPage({ kind: 'route', name: entry.route, route: entry.route, from: entry.from });
      setPageState(undefined);
      setSelectedId(undefined);
      setHoverNodeId(undefined);
    },
    [
      flushSave,
      showToast,
      pageLoadRef,
      setCurrentPage,
      setEditStack,
      setHoverNodeId,
      setPageState,
      setSelectedId,
    ],
  );
  return { selectRoute };
}

// Enter in the URL bar.
export function useGoToUrl(
  selectPageScope: ReturnType<typeof useSelectPage>,
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { selectPage, setUrlDraft } = selectPageScope;
  const { scan } = coreState;
  const { showToast } = lifecycle;

  // Enter in the URL bar. A route names a page file, so this switches the
  // editor to it rather than pointing the canvas somewhere the panels know
  // nothing about — the model and the canvas showing different pages is the
  // one state the app can't represent.
  const goToUrl = useCallback(
    (typed: string) => {
      setUrlDraft(undefined);
      const raw = String(typed || '').trim();
      if (!raw) {
        return;
      }
      // Accept a full URL or a bare path.
      let route = raw;
      const match = raw.match(/^https?:\/\/[^/]+(\/.*)?$/i);
      if (match) {
        route = match[1] || '/';
      }
      if (!route.startsWith('/')) {
        route = '/' + route;
      }
      route = route.replace(/\?.*$|#.*$/, '');
      const norm = (value: string): string => (value !== '/' ? value.replace(/\/$/, '') : value);
      const page = (scan.pages || []).find((candidate) => norm(candidate.route) === norm(route));
      if (page) {
        // Opening a page reports its own failures.
        void selectPage(page);
        return;
      }
      showToast(`No page matches ${route}`, 'error');
    },
    [scan.pages, showToast, selectPage, setUrlDraft],
  );
  return { goToUrl };
}

// Reading the open file again from disk.
export function useReload(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { pageStateRef, projectRef, setCodeWin, setCurrentPage, setEditStack } = coreState;
  const { setPageState, setRefreshKey, setSelectedId } = coreState;
  const { dropPageHistory, editDrafts, openFile, pageLoadRef, rescan } = lifecycle;
  const { setConflictReason } = lifecycle;

  // Re-reads whatever is open straight from disk. A git checkout rewrites the
  // working tree wholesale, and the file watcher can't be relied on for it:
  // events for files the app itself wrote moments earlier are suppressed (so
  // its own save isn't echoed back), which is exactly the case when you edit,
  // switch branch, and expect to see the other branch's content.
  const reloadFromDisk = useCallback(async () => {
    const proj = projectRef.current;
    const { currentPage: open, pageState: state } = pageStateRef.current;
    const request = pageLoadRef.current;
    const stillCurrent = () =>
      request === pageLoadRef.current &&
      pageStateRef.current.currentPage === open &&
      pageStateRef.current.pageState === state;
    if (!proj) {
      return;
    }
    const result = await rescan(proj.path);
    if (!open || open.kind === 'route' || !stillCurrent()) {
      return;
    }
    // The open file may not exist on the branch just switched to.
    const stillThere = scanContainsFile(result, open.path);
    if (stillThere) {
      const read = await readPage(open.path);
      if (!stillCurrent()) {
        return;
      }
      // Deliberate: this discards local edits, including a conflicted page's.
      // Handles still carry where the bytes allow, so the selection stays.
      editDrafts.discard(open.path);
      setConflictReason(undefined);
      setPageState((current) => toEditorPageState(carriedParse(current, read)));
      dropPageHistory(); // page snapshots don't apply to another page; commands stay
    } else {
      const next = result.pages[0] || undefined;
      if (next) {
        const entry: OpenFile = { ...next, kind: 'page' };
        await openFile(entry, { nextStack: [entry], selectionPath: undefined });
      } else {
        setEditStack([]);
        setCurrentPage(undefined);
        setPageState(undefined);
        setSelectedId(undefined);
      }
    }
    setRefreshKey((count) => count + 1); // the preview is showing the old branch too
  }, [
    rescan,
    openFile,
    editDrafts,
    dropPageHistory,
    pageLoadRef,
    pageStateRef,
    projectRef,
    setConflictReason,
    setCurrentPage,
    setEditStack,
    setPageState,
    setRefreshKey,
    setSelectedId,
  ]);

  const completePropertySave = useCallback(async () => {
    // A floating source window may hold a pre-rename consumer. It was flushed
    // before the transaction; close it so later typing cannot restore stale source.
    setCodeWin(undefined);
    await reloadFromDisk();
  }, [reloadFromDisk, setCodeWin]);
  return { completePropertySave, reloadFromDisk };
}

// Drilling into a component.
export function useOpenComponent(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { editStackRef, pageStateRef, projectRef, scan } = coreState;
  const { openFile, pageLoadRef, showToast } = lifecycle;

  // Drill into a component: its own file becomes the edited document, and the
  // stack remembers what to come back to (pages and components alike, so
  // nesting works to any depth).
  const openComponent = useCallback(
    async (
      name: string,
      hostPath: string | undefined,
      hostOcc = 0,
      filePath: string | undefined = undefined,
    ) => {
      // A tag is only a local binding — `import Layout from
      // '@/layouts/BaseLayout.astro'` renders as <Layout> — so follow the
      // page's own import first, and fall back to matching by filename.
      const { currentPage: host, pageState: state } = pageStateRef.current;
      if (host?.path?.includes('/.stacki/canvas/')) {
        showToast('Edit this instance’s props and children, then save its defaults.', 'info');
        return;
      }
      const request = pageLoadRef.current;
      const spec = (state?.editable ? state.model.imports : []).find(
        (item) => item.name === name,
      )?.path;
      let comp = undefined;
      // A caller that already knows the file means THAT file — the instances
      // popup names a component by where it lives, and two folders can hold
      // the same basename.
      if (filePath) {
        comp = componentAtPath(scan, name, filePath);
      }
      if (!comp && spec && host?.path) {
        const projectPath = projectRef.current?.path;
        if (!projectPath) {
          return;
        }
        const file = await resolveProjectImport(projectPath, host.path, spec);
        if (request !== pageLoadRef.current || pageStateRef.current.currentPage !== host) {
          return;
        }
        if (file && /\.astro$/i.test(file)) {
          const fileName = file.split('/').pop();
          assert(fileName !== undefined, 'Resolved component path has a filename');
          comp = { name: fileName.replace(/\.astro$/i, ''), path: file };
        } else if (file) {
          // A framework island (.jsx/.svelte/…) has no Astro tree to show.
          showToast(
            `<${name}> is a ${file.split('.').pop()} component — edit it in code.`,
            'error',
          );
          return;
        }
      }
      comp = comp || componentNamed(scan, name);
      if (!comp) {
        showToast(`Can't find a file for <${name}>.`, 'error');
        return;
      }
      const nodes = state?.editable ? state.model.nodes : [];
      const instance = { path: hostPath, occurrence: hostOcc };
      const entry = componentEntry(editStackRef.current, nodes, comp, instance);
      await openFile(entry, { nextStack: stackWith(entry), selectionPath: undefined });
    },
    [scan, openFile, showToast, editStackRef, pageLoadRef, pageStateRef, projectRef],
  );
  return { openComponent };
}

// Backing out of a component, and previewing an earlier version.
export function useCommitPreview(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { editStackRef, project, setBusy, setPreviewInfo, setPreviewRef } = coreState;
  const { openFile, showToast } = lifecycle;

  // Back out one level: to the parent component if nested, else to the page.
  const closeComponent = useCallback(async () => {
    const stack = editStackRef.current;
    if (stack.length < 2) {
      return;
    }
    const closing = stack.at(-1);
    assert(closing, 'Component stack must contain the component being closed');
    const next = stack.slice(0, -1);
    const parent = next.at(-1);
    assert(parent, 'Component stack must retain its parent');
    await openFile(parent, {
      nextStack: next,
      selectionPath: closing.hostKey ?? undefined,
    });
  }, [openFile, editStackRef]);

  // ----------------------------------------------------------------
  // Undo / redo
  //
  // One stack for the whole app, so ⌘Z means "undo the last thing I did"
  // wherever focus happens to be. Two kinds of entry live in it:
  //
  //   snapshot — the page model (or raw source) before an edit. Cheap to take
  //              and restores structure exactly, but only meaningful for the
  //              page it came from, so these are dropped when a page closes.
  //   command  — an {undo, redo} pair for anything outside the page model:
  //              a CSS file, a CMS entry, an asset rename. Each records how to
  //              put things back, so these survive page switches.
  // ----------------------------------------------------------------

  // Previewing an old version points the canvas at a second dev server running
  // against a checkout of that commit, and makes the editor read-only. The
  // read-only part is not decoration: the files behind that server are a
  // disposable checkout, so anything typed into them would be thrown away the
  // moment the preview ends, with nothing to say it had happened.
  const previewCommit = useCallback(
    async (commit: WireCommitInfo) => {
      if (!project) {
        return;
      }
      assert(commit.hash, 'Previewed commit must have a hash');
      setBusy('Getting that version ready…');
      try {
        const preview = await previewProjectCommit(project.path, commit.hash);
        setPreviewRef(commit.hash);
        setPreviewInfo({ url: preview.url, subject: commit.subject, when: commit.when });
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      } finally {
        setBusy(undefined);
      }
    },
    [project, showToast, setBusy, setPreviewInfo, setPreviewRef],
  );

  // Named apart from exitPreview below, which is the app's own interactive
  // preview mode — a different thing entirely.
  const exitCommitPreview = useCallback(async () => {
    setPreviewRef(undefined);
    setPreviewInfo(undefined);
    if (project) {
      await stopProjectCommitPreview(project.path).catch(() => {});
    }
  }, [project, setPreviewInfo, setPreviewRef]);

  // Leaving the project (or closing it) must not leave a second server and a
  // checkout behind inside it.
  const openProjectPath = project?.path;
  useEffect(() => {
    if (openProjectPath === undefined) {
      return undefined;
    }
    return () => {
      void stopProjectCommitPreview(openProjectPath).catch(() => {});
    };
  }, [openProjectPath]);
  return { closeComponent, exitCommitPreview, previewCommit };
}

// The git state the History panel and the branch chip share.
export function useGitInfo(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { project, refreshKey, setGitInfo } = coreState;
  const { showToast } = lifecycle;

  const refreshGit = useCallback(async () => {
    if (!project) {
      return undefined;
    }
    const result = await readGitInfo(project.path);
    if (!result.ok) {
      showToast(result.error, 'error');
      return undefined;
    }
    setGitInfo(result.value);
    return result.value;
  }, [project, showToast, setGitInfo]);

  useEffect(() => {
    // A failed read is reported by refreshGit itself.
    void refreshGit();
  }, [refreshGit, refreshKey]);
  return { refreshGit };
}
