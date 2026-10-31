// What the canvas is drawn from: its gate and notices, the breadcrumbs'
// labels, the marks on rendered nodes, the selection's paths and the
// overlay's info (appViewModel.ts).

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isFragmentNode, liveClassesById as classesByNodeId } from '../../editor/liveClasses';
import { isDataBound } from '../../editor/bindings';
import { thenBranch } from '../../editor/branches';
import { canvasEventSelectsSource, type CanvasEventRequest } from '../../editor/canvasClick';
import { nodeAtPath } from '../../editor/editorTree';
import { elementLabel } from '../../editor/classNames';
import type { OverlayInfo } from '../../features/preview/PreviewOverlays';
import type { PreviewCrumb } from '../../features/preview/PreviewToolbar';
import type { SpacingHover } from '../../features/preview/PreviewOverlays';
import { projectRelativePath } from '../../lib/projectPath';
import { isOpenFile } from '../../editor/pageState';
import { type EditorNode } from '../../editor/pageView';
import { writeProjectFile, checkPreviewRender } from '../../ipc/appBridge';
import {
  judgeCanvasEvent,
  type CheckRender,
  type ShownFile,
} from '../../features/preview/previewGate';
import { describePreviewStale, type PreviewVerdict } from '../../../shared/page/previewToken';
import { PreviewOrigins, judgeRememberedClick } from '../../features/preview/previewSelection';
import type { JudgeCanvasEvent } from '../../features/preview/previewRuntime';
import {
  describePreviewReload,
  type PreviewReloadReason,
} from '../../features/preview/previewMessages';
import { trailOf } from '../model/pageGestures';
import { emptyNodeIdsOf } from '../model/pageQueries';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useShortcuts } from './appPageOps';
import type { useCodeWindow, usePageOps } from './appViewModel';
import { pageDisplayName } from '../../features/pages/pageTree';

// Asset file edits, and the preview-token gate.
export function useCanvasGate(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  codeWindow: ReturnType<typeof useCodeWindow>,
) {
  const { codeWin, pageStateRef, projectRef, setCodeWin, setFileText } = coreState;
  const { fileSaverRef } = lifecycle;
  const { codeWinValue, isFileWin } = codeWindow;
  const origins = usePreviewOrigins(coreState);

  // File edits stream to disk (debounced) — the dev server picks them up.
  const setAssetFileText = useCallback(
    (text: string) => {
      setFileText(text);
      if (!codeWin || codeWin.kind !== 'file') {
        return;
      }
      const { rel, area } = codeWin;
      if (!rel) {
        return;
      }
      // Source files live anywhere in the project; assets are rooted in public/.
      const projectPath = projectRef.current?.path;
      const saver = fileSaverRef.current;
      if (!projectPath || !saver) {
        return;
      }
      saver.schedule(`${projectPath}|${area || 'public'}|${rel}`, () =>
        writeProjectFile(area ?? 'public', projectPath, rel, text),
      );
    },
    [codeWin, fileSaverRef, projectRef, setFileText],
  );

  // Close the window if its target disappears (page switch, node deleted).
  useEffect(() => {
    if (codeWin && !isFileWin && codeWinValue === undefined) {
      setCodeWin(undefined);
    }
  }, [codeWin, isFileWin, codeWinValue, setCodeWin]);

  // The preview-token gate (plan §9, step 7): a click selects only when the
  // canvas's rendering is the bytes the editor shows and the disk still holds
  // every file it came from. Read through refs at decision time, not captured.
  const judgeEvent = useCallback<JudgeCanvasEvent>(
    (token, render, request) => {
      const shown = (): ShownFile | undefined => {
        const { currentPage: open, pageState: state } = pageStateRef.current;
        const projectPath = projectRef.current?.path;
        if (!isOpenFile(open) || !state || !projectPath) {
          return undefined;
        }
        const file = projectRelativePath(projectPath, open.path, window.avb.platform);
        if (!eventSelectsShownFile(request, open, file)) {
          return undefined;
        }
        return {
          file,
          state,
          scope: open.kind === 'component' ? `${file}|` : '',
        };
      };
      const projectPath = projectRef.current?.path;
      const check: CheckRender = (checked) =>
        projectPath
          ? checkPreviewRender(projectPath, checked)
          : Promise.resolve<PreviewVerdict>({ tag: 'stale', reason: 'no-render', file: undefined });
      return request.kind === 'click'
        ? judgeRememberedClick(token, render, request.path, origins.current, check, shown)
        : judgeCanvasEvent(token, render, check, shown);
    },
    [pageStateRef, projectRef, origins],
  );
  return { judgeEvent, setAssetFileText };
}

// Retain only this file session's saved models while its canvas catches up.
function usePreviewOrigins({
  currentPage,
  pageState,
}: Pick<ReturnType<typeof useCoreState>, 'currentPage' | 'pageState'>) {
  const origins = useRef(new PreviewOrigins());
  origins.current.remember(currentPage?.path, pageState?.editable ? pageState.origin : undefined);
  return origins;
}

function eventSelectsShownFile(
  request: CanvasEventRequest,
  open: { readonly kind: 'page' | 'component'; readonly focusPath?: string | undefined },
  file: string,
): boolean {
  const component = open.kind === 'component';
  return canvasEventSelectsSource(request, {
    focusPath: component ? (open.focusPath ?? undefined) : undefined,
    scope: component ? `${file}|` : '',
  });
}

// Canvas notices, and the classes the page rendered with.
export function useCanvasNotices(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const { showToast } = lifecycle;
  const { editStack, nodeClasses, project } = coreState;
  const { model } = shortcuts;

  const onStaleEvent = useCallback(
    (verdict: Extract<PreviewVerdict, { readonly tag: 'stale' }>) => {
      // Visible, never silent — and never a claim that anything was lost: the
      // click simply did not select. The canvas catches up on its own.
      const where = verdict.file ? ` (${verdict.file})` : '';
      showToast(`Click not applied: ${describePreviewStale(verdict.reason)}${where}`);
    },
    [showToast],
  );

  // Past the patcher's caps the canvas reloads instead of patching (step 7):
  // honest about it, so a scroll position or an open menu lost to a reload is
  // explained. The reloads a patch could never avoid — a script that changed —
  // are what the canvas always did, and stay quiet.
  const onPreviewReload = useCallback(
    (reason: PreviewReloadReason) => {
      const why = describePreviewReload(reason);
      if (why !== undefined) {
        showToast(why);
      }
    },
    [showToast],
  );

  const editedRel =
    editStack.length > 1 && project?.path
      ? projectRelativePath(
          project.path,
          editStack[editStack.length - 1]?.path ?? '',
          window.avb.platform,
        )
      : undefined;

  // The reported classes, keyed by node id — same walk as the render report,
  // so a path only has to be resolved once.
  const liveClassesById = React.useMemo(
    () =>
      nodeClasses && model
        ? classesByNodeId(nodeClasses, model.nodes, editedRel ? `${editedRel}|` : '')
        : undefined,
    [nodeClasses, model, editedRel],
  );

  // A class the source can't resolve — `class:list={["button_wrap", …]}` —
  // leaves a node named after its tag, or after a variable in the case of a
  // dynamic `<Tag>`. The page reports what each node rendered with, so the
  // breadcrumb and the canvas chip can say the same thing the navigator does.
  const liveLabel = (node: EditorNode, fromSource: string): string => {
    if (fromSource && fromSource !== node.name) {
      return fromSource;
    }
    const live = liveClassesById?.get(node.id);
    return live?.[0] ?? fromSource;
  };
  return { editedRel, liveClassesById, liveLabel, onPreviewReload, onStaleEvent };
}

// Breadcrumb labels and the file being edited.
export function useCrumbLabels(
  pageOps: ReturnType<typeof usePageOps>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const { currentLayoutName } = pageOps;
  const { liveLabel } = canvasNotices;
  const { currentPage, editStack, project, setNodeClasses, setNodeStates } = coreState;
  const { setRenderedPaths } = coreState;
  const { model } = shortcuts;

  // Breadcrumb trail for the canvas toolbar: page → ancestors → selection.
  const crumbLabel = (node: EditorNode): string => {
    if (node.id === 'layout') {
      return currentLayoutName || node.name || 'layout';
    }
    switch (node.kind) {
      case 'text':
        return 'text';
      case 'comment':
        return 'comment';
      case 'expr':
        return 'code';
      case 'map': {
        const at = node.head.indexOf('.map');
        return at > 0 ? node.head.slice(0, at + 4) : 'loop';
      }
      case 'cond':
        return `if ${node.test}`;
      case 'branch':
        return node.name === 'else' ? 'else' : 'then';
      case 'element':
      case 'raw':
        // First class wins; fall back to the bare tag when the element has
        // none. Reads `class:list` too, so a component's inner elements are
        // named the same way the navigator names them.
        return liveLabel(node, elementLabel(node));
      case 'component':
      case 'raw-line':
      case 'chunk-group':
        // `<Tag>` from `const Tag = tag` renders a real element and its name
        // is a variable, so the class it rendered with names it better.
        if (node.dynamicTag) {
          return liveLabel(node, elementLabel(node));
        }
        return node.name || node.kind;
    }
  };

  // The file being edited, relative to src/ — how the CMS addresses a page's
  // own data (`pages/index.astro#rotatingWords`).
  const openEditableFile =
    editStack[editStack.length - 1] ?? (currentPage?.kind === 'route' ? undefined : currentPage);
  const openFileSourceRel = (() => {
    const path = openEditableFile?.path;
    if (!path || !project?.path) {
      return undefined;
    }
    const rel = projectRelativePath(project.path, path, window.avb.platform);
    return rel.startsWith('src/') ? rel.slice(4) : rel;
  })();
  // An edit renumbers paths, so a report from before it describes nodes that
  // have since moved. Drop it and show nothing until the page has re-rendered
  // and said so again — a marker on the wrong row is worse than none.
  useEffect(() => {
    setRenderedPaths(undefined);
    setNodeStates(undefined);
    setNodeClasses(undefined);
  }, [model, setNodeClasses, setNodeStates, setRenderedPaths]);

  // What the spacing box is pointing at, drawn over the selected element on the
  // canvas — see spacingBands.js.
  const [spacingHover, setSpacingHover] = useState<SpacingHover | undefined>(undefined);
  return { crumbLabel, openEditableFile, openFileSourceRel, setSpacingHover, spacingHover };
}

// The breadcrumb trail, and what the navigator marks.
export function useCanvasMarks(
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  crumbLabels: ReturnType<typeof useCrumbLabels>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
) {
  const { currentPage, nodeStates, renderedPaths, selectedId } = coreState;
  const { model } = shortcuts;
  const { selectedAncestors, tree } = pageOps;
  const { crumbLabel } = crumbLabels;
  const { editedRel } = canvasNotices;

  const crumbs: PreviewCrumb[] = [];
  if (currentPage) {
    const page = coreState.scan.pages.find((entry) => entry.path === currentPage.path);
    crumbs.push({
      id: undefined,
      label: page ? pageDisplayName(page) : currentPage.name.replace(/\.(astro|mdx?)$/i, ''),
    });
  }
  if (model && selectedId === 'frontmatter') {
    crumbs.push({ id: 'frontmatter', label: 'Frontmatter' });
  } else if (model && selectedId) {
    const chain = selectedAncestors;
    // A then has no row in the navigator, so the trail doesn't name it either —
    // "if command › then › hero-command" said "then" to no one (see
    // branches.js).
    crumbs.push(
      ...chain
        .filter((node, i) => node !== thenBranch(chain[i - 1]))
        .map((node) => ({ id: node.id, label: crumbLabel(node) })),
    );
  }

  // Canvas outlines: nodes are addressed by their index path in the tree
  // (matching the marker paths the dev server's plugin injects).
  // While a component is open the tree is that component's file, not the
  // page, so ask in that file's namespace — the plugin marks every .astro
  // under src with one. The canvas still shows the page, where those markers
  // appear once per instance, so every instance outlines.
  // Which nodes put nothing on the page, as ids. A node counts as rendering if
  // it rendered something itself OR anything under it did: a layout wraps
  // <html>, so its own markers are split across <head> and <body> and never
  // pair up, but its children measure fine — without the ancestor closure it
  // would read as empty. Everything left over really did produce nothing,
  // including nodes inside a component that never evaluated its slot, whose
  // markers were never emitted at all.
  const emptyNodeIds = React.useMemo(
    () =>
      renderedPaths && model ? emptyNodeIdsOf(renderedPaths, model.nodes, editedRel) : undefined,
    [renderedPaths, model, editedRel],
  );

  // The reported paths as node ids, so the navigator can mark rows without
  // knowing anything about index paths.
  const stateIds = React.useMemo(() => {
    const empty = { hidden: new Set<string>(), inert: new Set<string>() };
    if (!nodeStates || !model) {
      return empty;
    }
    const prefix = editedRel ? `${editedRel}|` : '';
    const local = (path: string): string =>
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const ids = (paths: readonly string[]): ReadonlySet<string> => {
      const set = new Set<string>();
      for (const path of paths || []) {
        const id = tree.byPath.get(local(path))?.id;
        if (id) {
          set.add(id);
        }
      }
      return set;
    };
    return { hidden: ids(nodeStates.hidden), inert: ids(nodeStates.inert) };
  }, [nodeStates, model, editedRel, tree]);
  return { crumbs, emptyNodeIds, stateIds };
}

// Marker paths, the selection trail, and the tab highlight.
export function useSelectionPaths(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  canvasNotices: ReturnType<typeof useCanvasNotices>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { model } = shortcuts;
  const { tree } = pageOps;
  const { editedRel } = canvasNotices;
  const { currentPage, editStack, pageState, project, rightTab, rightTabRefs } = coreState;
  const { selectedId, selectionKeysRef, setRightTabInd, canvasPathForRef } = coreState;

  const pathFor = (id: string | undefined): string | undefined => {
    if (!model || !id) {
      return undefined;
    }
    const path = tree.path(id);
    if (path === undefined) {
      return undefined;
    }
    return editedRel ? `${editedRel}|${path}` : path;
  };
  // Read by edits bound before this tree existed (appState.ts).
  canvasPathForRef.current = pathFor;
  // The right panel stays on whichever tab the user picked, whatever gets
  // selected next. (S / D switch it by hand.)

  // What ⇧⌘C copies: the route an editor would take to reach the selection —
  // the page, the instance of each component drilled into on the way down,
  // then the node itself — so an agent reading it lands on the markup the user
  // is looking at, not on some other use of the same component. With nothing
  // selected the open file alone still says where the user is.
  //
  // Deliberately "<file>#<index path>" rather than a marker path: a marker is
  // namespaced only when it names a component, and every entry here needs to
  // say which file it belongs to. The file is the one open at that level of the
  // stack, so it's read from the stack rather than parsed out of the key.
  // Through a ref because the menu handler is bound long before this is in scope.
  const relOf = (abs: string | undefined): string | undefined =>
    abs && project?.path ? projectRelativePath(project.path, abs, window.avb.platform) : undefined;
  const openRel = relOf(currentPage?.path);
  const leafPath = selectedId ? tree.path(selectedId) : undefined;
  selectionKeysRef.current = !openRel
    ? []
    : [
        ...editStack
          .slice(1)
          .map((entry, i) => {
            const host = relOf(editStack[i]?.path);
            return entry.hostKey && host
              ? `${host}#${trailOf(entry.hostKey).join('.')}`
              : undefined;
          })
          .filter((key): key is string => key !== undefined),
        selectedId === 'frontmatter'
          ? `${openRel}#frontmatter`
          : leafPath !== undefined
            ? `${openRel}#${leafPath}`
            : `${openRel}#`,
      ];

  // Position the Style/Settings highlight: on tab change, when the panel first
  // appears, and whenever the tab strip's width changes.
  useLayoutEffect(() => {
    const measure = () => {
      const tabButton = rightTabRefs.current[rightTab];
      setRightTabInd(
        tabButton ? { left: tabButton.offsetLeft, width: tabButton.offsetWidth } : undefined,
      );
    };
    measure();
    const strip = rightTabRefs.current[rightTab]?.parentElement;
    if (!strip || typeof ResizeObserver === 'undefined') {
      return;
    }
    const ro = new ResizeObserver(measure);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [rightTab, pageState?.editable, rightTabRefs, setRightTabInd]);
  return { openRel, pathFor };
}

// What a canvas outline says about its node.
export function useOverlayInfo(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  crumbLabels: ReturnType<typeof useCrumbLabels>,
) {
  const { model } = shortcuts;
  const { currentLayoutName } = pageOps;
  const { crumbLabel } = crumbLabels;

  const overlayInfo = (path: string): OverlayInfo | undefined => {
    if (!model || !path) {
      return undefined;
    }
    const node = nodeAtPath(model.nodes, trailOf(path));
    if (!node) {
      return undefined;
    }
    const label =
      node.id === 'layout' ? currentLayoutName || node.name || 'layout' : crumbLabel(node);
    // Fragments group inline content rather than referring to another component.
    // Their outlines use ordinary element styling, as dynamic tags already do.
    const kind = isFragmentNode(node)
      ? 'element'
      : node.kind === 'component' && !node.dynamicTag
        ? 'component'
        : node.kind === 'map' || node.kind === 'cond' || node.kind === 'branch'
          ? 'map'
          : 'element';
    // The tag drives the overlay's icon, so it matches the Navigator row.
    const tag = node.kind === 'element' || node.kind === 'raw' ? node.name : undefined;
    return {
      label,
      kind,
      tag,
      astroAsset: !!node.astroAsset,
      dynamicTag: !!node.dynamicTag,
      nodeKind: node.kind,
      isLayout: node.id === 'layout',
      bound: kind === 'element' && isDataBound(node),
    };
  };
  return { overlayInfo };
}
