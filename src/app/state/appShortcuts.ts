// Inserting items, the keyboard and menu shortcuts, the interactive preview,
// escape keys, routes, collections and their sample entries, cleaning up
// queries, and composing the node edits (App.tsx).

import { useCallback, useEffect, useRef } from 'react';
import type { ImportDecl } from '../../../shared/page/pageNode';
import { insertTargetFor as placeInsert } from '../../editor/insertTarget';
import { frontmatterGesture, insertGesture } from '../../editor/editGestures';
import {
  collectionsInScope,
  type ImportedCall,
  importedCallsInScope,
  markedQueries,
  QUERY_MARK,
  referencesInScope,
  removeMarkedQuery,
} from '../../editor/dataSuggest';
import type { InsertItem } from '../../features/palette/InsertSearch';
import { toRecord } from '../../../shared/core/record';
import { type EditorModel } from '../../editor/pageView';
import {
  onCmsInventoryChanged,
  readContentCollections,
  readDynamicPaths,
  readInjectedRoutes,
  readSampleEntry,
  readSampleValue,
  runNativeEdit,
} from '../../ipc/appBridge';
import { newId, routeToPath } from '../model/nodeFactory';
import { astroAssetGesture, insertedNode } from '../model/pageGestures';
import {
  type AppKeys,
  handleAppKeyDown,
  copySelectionTrail,
  inEditable,
  type MenuEdits,
  menuCopy,
  menuPaste,
} from '../model/appKeys';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useNavigation } from './appHistory';
import { useWrapNode } from './appWrapNode';
import {
  useHistory,
  useAddComponent,
  useComponentQueries,
  useCreateComponent,
  useMoveNode,
  useRemoveNode,
  useCopyNode,
  usePasteNode,
  useInsertPalette,
  useCanvasMessages,
} from './appNodeEdits';

// Editing nodes from the navigator and the palette.
export function useNodeEdits(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const addComponentScope = useAddComponent(coreState, history);
  const componentQueries = useComponentQueries(coreState);
  const createComponent = useCreateComponent(coreState, componentQueries, lifecycle, history);
  const moveNodeScope = useMoveNode(coreState, history, lifecycle);
  const wrapNodeScope = useWrapNode(coreState, history);
  const removeNodeScope = useRemoveNode(coreState, lifecycle, history);
  const copyNodeScope = useCopyNode(coreState, removeNodeScope, lifecycle, history);
  const pasteNodeScope = usePasteNode(
    removeNodeScope,
    coreState,
    addComponentScope,
    lifecycle,
    history,
  );
  const insertPalette = useInsertPalette(coreState);
  useCanvasMessages(coreState, insertPalette);
  return {
    ...addComponentScope,
    ...componentQueries,
    ...createComponent,
    ...moveNodeScope,
    ...wrapNodeScope,
    ...removeNodeScope,
    ...copyNodeScope,
    ...pasteNodeScope,
    ...insertPalette,
  };
}

// Inserting what the palette picked.
export function useInsertItem(
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { cmsRel, contentName, insertables, leftTab, pageStateRef, selectedIdRef } = coreState;
  const { setSelectedId } = coreState;
  const { addComponent, setInsertOpen } = nodeEdits;
  const { reportFailure } = lifecycle;
  const { commitEdit } = history;

  // Where a new node goes — see insertTarget.js. The rule lives there so the
  // "why did that land next to the section instead of in it?" answer can be
  // read, and tested, without a running app.
  const insertTargetFor = useCallback(
    (model: EditorModel, selectionId: string | undefined, item: InsertItem) =>
      placeInsert(model, selectionId, item, insertables),
    [insertables],
  );

  const insertItem = useCallback(
    (item: InsertItem) => {
      setInsertOpen(false);
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const target = insertTargetFor(state.model, selectedIdRef.current, item);

      if (item.type === 'component') {
        void addComponent(item.path ?? item.name, target).catch(reportFailure);
        return;
      }

      // <Image>/<Picture> need `import { … } from 'astro:assets'` — a named
      // import of a virtual module, so there is no file path to resolve the
      // way a project component's is.
      if (item.type === 'astroAsset') {
        const assetId = newId();
        commitEdit(astroAssetGesture(state.model, { id: assetId, name: item.name }, target));
        setSelectedId(assetId);
        return;
      }

      const id = newId();
      const node = insertedNode(item, id);
      if (!node) {
        return;
      }
      // Step 6, insert: a new node needs no import, so it is one request.
      commitEdit(insertGesture(state.model, node, target, { urgency: true }));
      setSelectedId(id);
    },
    [
      insertTargetFor,
      addComponent,
      commitEdit,
      reportFailure,
      pageStateRef,
      selectedIdRef,
      setInsertOpen,
      setSelectedId,
    ],
  );

  // True while the CMS covers the canvas: the page-editing shortcuts below
  // would act on a selection the user can't see.
  const cmsOpenRef = useRef(false);
  cmsOpenRef.current = leftTab === 'cms' && (!!cmsRel || !!contentName);
  return { cmsOpenRef, insertItem };
}

// The app’s keyboard shortcuts.
export function useKeyboard(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  insertItemScope: ReturnType<typeof useInsertItem>,
  history: ReturnType<typeof useHistory>,
) {
  const { historyRef, reportFailure } = lifecycle;
  const { openCodeWindowRef, pageStateRef, selectedIdRef, setClassFocus } = coreState;
  const { setCreateRequest, setLeftTab, setRightTab } = coreState;
  const { copyNode, duplicateNode, nodeClipboardRef, pasteNode, removeNode } = nodeEdits;
  const { setInsertOpen } = nodeEdits;
  const { cmsOpenRef } = insertItemScope;
  const { redo, undo } = history;

  // Keyboard: ⌘Z undoes, ⇧⌘Z / ⌘Y redoes (app-wide, even inside fields —
  // field edits live in the same history); Delete/Backspace removes, ⌘C
  // copies, ⌘D duplicates, ⌘V pastes — unless the user is typing in a field.
  useEffect(() => {
    const keys: AppKeys = {
      historyRef,
      pageStateRef,
      selectedIdRef,
      openCodeWindowRef,
      nodeClipboardRef,
      cmsOpenRef,
      undo,
      redo,
      setInsertOpen,
      setLeftTab,
      setCreateRequest,
      setRightTab,
      setClassFocus,
      removeNode,
      copyNode,
      duplicateNode,
      pasteNode,
      reportFailure,
    };
    const onKeyDown = (event: KeyboardEvent): void => handleAppKeyDown(event, keys);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [
    removeNode,
    copyNode,
    duplicateNode,
    pasteNode,
    undo,
    redo,
    reportFailure,
    cmsOpenRef,
    historyRef,
    nodeClipboardRef,
    openCodeWindowRef,
    pageStateRef,
    selectedIdRef,
    setClassFocus,
    setCreateRequest,
    setInsertOpen,
    setLeftTab,
    setRightTab,
  ]);
}

// Application-menu shortcuts.
export function useMenuShortcuts(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  insertItemScope: ReturnType<typeof useInsertItem>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { flushSave, reportFailure, showToast } = lifecycle;
  const { pageStateRef, projectRef, selectedIdRef, selectionKeysRef } = coreState;
  const { cmsOpenRef } = insertItemScope;
  const { copyNode, nodeClipboardRef, pasteNode } = nodeEdits;
  const { redo, undo } = history;

  // Application-menu shortcuts: on macOS the native menu consumes ⌘Z/⌘C/⌘V
  // before the DOM sees them, so those arrive here via IPC instead. Copy and
  // paste route to the focused text field when one is active, otherwise to
  // the selected node.
  useEffect(() => {
    const copying = { flushSave, showToast, projectRef, selectionKeysRef };
    const copySelection = (): Promise<void> => copySelectionTrail(copying);
    const menu: MenuEdits = {
      selectedIdRef,
      pageStateRef,
      cmsOpenRef,
      nodeClipboardRef,
      copyNode,
      pasteNode,
      reportFailure,
    };
    const offs = [
      // ⌘Z is a menu accelerator, so the key never reaches the page: whatever
      // this decides is the only undo there is.
      //
      // Typing has its own, and the field is the only thing that knows what was
      // typed — a rename half-finished in a text box is not an entry on the
      // app's stack. So a field gets its own undo handed back to it.
      //
      // Everything else is the app's. It used to run only while a page was open
      // and the CMS was closed, which left every view that ISN'T a page unable
      // to undo anything it had recorded: the variables panel, the assets
      // panel, the CMS itself. A command carries its own inverse and needs no
      // page — and a snapshot without one is dropped rather than applied, which
      // undo already does.
      window.avb.onMenu('undo', () => {
        if (inEditable()) {
          runNativeEdit('undo');
          return;
        }
        // Undo reports its own failures.
        void undo();
      }),
      window.avb.onMenu('redo', () => {
        if (inEditable()) {
          runNativeEdit('redo');
          return;
        }
        // Redo reports its own failures.
        void redo();
      }),
      window.avb.onMenu('copy', () => menuCopy(menu)),
      window.avb.onMenu('paste', () => menuPaste(menu)),
      // ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
      // Copies markup coordinates, not markup: ⌘C already does the node.
      window.avb.onMenu('copySelection', () => {
        void copySelection().catch(reportFailure);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [
    undo,
    redo,
    copyNode,
    pasteNode,
    flushSave,
    showToast,
    reportFailure,
    cmsOpenRef,
    nodeClipboardRef,
    pageStateRef,
    projectRef,
    selectedIdRef,
    selectionKeysRef,
  ]);
}

// The interactive preview mode.
export function useInteractivePreview(
  coreState: ReturnType<typeof useCoreState>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { devUrl, inPreviewRef, livePathRef, pageStateRef, previewIframeRef } = coreState;
  const { previewPathRef, scan, setInPreview, setPreviewSource, trailingSlash } = coreState;
  const { selectPage } = navigation;

  // ----------------------------------------------------------------
  // Interactive preview mode — browse the site inside the app; on exit,
  // the editor follows whichever page was navigated to.
  // ----------------------------------------------------------------

  const enterPreview = useCallback(() => {
    if (!devUrl) {
      return;
    }
    // Whatever the canvas is showing — which for a dynamic page is one entry's
    // URL, not its pattern. Opening /blog/[...id] asks the dev server for a
    // route no page produces, and it answers with the site's 404, while the
    // URL field (built from the same entry) went on claiming otherwise.
    const path =
      livePathRef.current ||
      routeToPath(pageStateRef.current.currentPage?.route || '/', trailingSlash);
    previewPathRef.current = path;
    setPreviewSource(devUrl + path);
    setInPreview(true);
  }, [
    devUrl,
    trailingSlash,
    livePathRef,
    pageStateRef,
    previewPathRef,
    setInPreview,
    setPreviewSource,
  ]);

  const exitPreview = useCallback(() => {
    setInPreview(false);
    const raw = previewPathRef.current;
    if (!raw) {
      return;
    }
    let path = raw.split('?')[0]?.split('#')[0] ?? '';
    if (path.length > 1 && path.endsWith('/')) {
      path = path.slice(0, -1);
    }
    const page = scan.pages.find((pg) => pg.route === (path || '/'));
    if (page && page.path !== pageStateRef.current.currentPage?.path) {
      // Opening a page reports its own failures.
      void selectPage(page);
    }
  }, [scan.pages, selectPage, pageStateRef, previewPathRef, setInPreview]);

  // Track navigation inside the preview iframe (the preload posts
  // avb:navigated from every loaded frame).
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      const message = toRecord(event.data);
      if (message?.['type'] !== 'avb:navigated' || !inPreviewRef.current) {
        return;
      }
      const ifr = previewIframeRef.current;
      if (ifr && event.source === ifr.contentWindow) {
        const path = message['path'];
        if (typeof path === 'string') {
          previewPathRef.current = path;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [inPreviewRef, previewIframeRef, previewPathRef]);
  return { enterPreview, exitPreview };
}

// Escape out of a preview or a component.
export function useEscapeKeys(
  coreState: ReturnType<typeof useCoreState>,
  navigation: ReturnType<typeof useNavigation>,
  interactivePreview: ReturnType<typeof useInteractivePreview>,
) {
  const { editStack, inPreview, previewRef } = coreState;
  const { closeComponent, exitCommitPreview } = navigation;
  const { exitPreview } = interactivePreview;

  // Escape exits preview mode.
  useEffect(() => {
    // Escape leaves either kind of looking-not-working. An older version takes
    // precedence: it is the one covering everything, so it is the one Escape
    // is about while it is up.
    if (!inPreview && !previewRef) {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (previewRef) {
          // Leaving the old version cannot fail: a server that will not stop is ignored.
          void exitCommitPreview();
        } else {
          exitPreview();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, exitPreview, previewRef, exitCommitPreview]);

  // Escape backs out of a drilled-into component, one level at a time.
  useEffect(() => {
    if (inPreview || editStack.length < 2) {
      return;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      const target = event.target;
      // Let fields, menus, and dialogs consume their own Escape first.
      if (
        target instanceof HTMLElement &&
        (target.closest('input, textarea, select, [contenteditable="true"]') ||
          target.closest('.popup-surface, .dd-popup, .insert-overlay, .code-window'))
      ) {
        return;
      }
      event.preventDefault();
      // Opening the parent file reports its own failures.
      void closeComponent();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [inPreview, editStack.length, closeComponent]);
}

// Injected routes and a dynamic page’s entries.
export function useRoutes(coreState: ReturnType<typeof useCoreState>) {
  const { currentPage, devStatus, devUrl, editStack, pageState, project, scan } = coreState;
  const { setDynamicError, setDynamicIndex, setDynamicPaths, setInjectedRoutes } = coreState;

  // The route list is written by the dev server as it resolves its routes, so
  // it is read once the server is up — and again after a rescan, since adding
  // a page of your own changes what the list holds.
  useEffect(() => {
    if (!project || devStatus !== 'on') {
      setInjectedRoutes([]);
      return;
    }
    let live = true;
    readInjectedRoutes(project.path)
      .then((routes) => live && setInjectedRoutes(routes))
      .catch(() => live && setInjectedRoutes([]));
    return () => {
      live = false;
    };
  }, [project, devStatus, scan.pages.length, setInjectedRoutes]);

  // The open page's model, when it has one, and the frontmatter it declares.
  const model = pageState?.editable ? pageState.model : undefined;
  const pageFrontmatter = model?.extraFrontmatter;

  // A dynamic page ([slug].astro) has a route pattern, not a URL. Ask the dev
  // server which concrete paths its getStaticPaths produces, so the canvas can
  // show one of them instead of a 404. Static pages never reach the fetch.
  useEffect(() => {
    const entry = editStack[0] || currentPage;
    const route = entry?.route;
    if (!project || !entry || !route?.includes('[') || devStatus !== 'on' || !devUrl) {
      setDynamicPaths([]);
      return undefined;
    }
    let live = true;
    if (!entry.path) {
      return undefined;
    }
    readDynamicPaths(project.path, entry.path, devUrl)
      .then((result) => {
        if (!live) {
          return;
        }
        setDynamicPaths(result?.entries || []);
        // Keep showing the same entry across reloads where we can — the
        // params are what identify it, not its position in the list.
        setDynamicIndex((i) => (i < (result?.entries || []).length ? i : 0));
        if (result?.error) {
          setDynamicError(result.error);
        } else {
          setDynamicError(undefined);
        }
      })
      .catch(() => live && setDynamicPaths([]));
    return () => {
      live = false;
    };
    // Frontmatter rather than the whole pageState: getStaticPaths lives there,
    // and depending on the model would re-run a collection query on every
    // keystroke in the page body.
  }, [
    project,
    editStack,
    currentPage,
    devStatus,
    devUrl,
    pageFrontmatter,
    setDynamicError,
    setDynamicIndex,
    setDynamicPaths,
  ]);
  return { model, pageFrontmatter };
}

// The project’s collections.
export function useCollections(coreState: ReturnType<typeof useCoreState>) {
  const { project, sampleAskedRef, setCollectionSamples, setCollections } = coreState;

  // What one entry of each collection this file reads actually holds — the
  // sample values the binding picker shows beside a field's name. Only the dev
  // server can run the project's loaders, so without one the picker falls back
  // to whatever the source alone says.
  useEffect(() => {
    setCollectionSamples({});
    sampleAskedRef.current = new Set();
  }, [project?.path, sampleAskedRef, setCollectionSamples]);
  useEffect(() => {
    if (!project?.path) {
      return undefined;
    }
    let live = true;
    readContentCollections(project.path)
      .then((value) => live && setCollections(value))
      .catch(() => {});
    const off = onCmsInventoryChanged(() => {
      readContentCollections(project.path)
        .then((value) => live && setCollections(value))
        .catch(() => {});
    });
    return () => {
      live = false;
      off?.();
    };
  }, [project?.path, setCollections]);
}

// Sample entries for the collections the open file reads.
export function useSampleEntries(
  coreState: ReturnType<typeof useCoreState>,
  routes: ReturnType<typeof useRoutes>,
) {
  const { collectionSamples, currentPage, devStatus, devUrl, dynamicIndex } = coreState;
  const { dynamicPaths, setCollectionSamples } = coreState;
  const { pageFrontmatter } = routes;

  useEffect(() => {
    if (!devUrl || devStatus !== 'on') {
      return undefined;
    }
    const frontmatter = pageFrontmatter ?? '';
    // The entry on the canvas, which is what a reference in this file resolves
    // AGAINST — this post's author, not the collection's first.
    const props =
      currentPage?.kind === 'component'
        ? undefined
        : dynamicPaths[dynamicIndex]?.props || undefined;
    const wanted: { readonly key: string; readonly name: string; readonly id?: string }[] = [
      ...collectionsInScope(frontmatter).map((name) => ({ key: name, name })),
      ...referencesInScope(frontmatter, props).map((reference) => ({
        key: reference.key,
        name: reference.collection,
        id: reference.id,
      })),
    ].filter((want) => !(want.key in collectionSamples));
    if (!wanted.length) {
      return undefined;
    }
    let live = true;
    Promise.all(
      wanted.map((want) =>
        readSampleEntry(devUrl, want.name, want.id).then((entry) => [want.key, entry] as const),
      ),
    )
      .then((pairs) => {
        if (live) {
          setCollectionSamples((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [
    pageFrontmatter,
    devUrl,
    devStatus,
    collectionSamples,
    dynamicPaths,
    dynamicIndex,
    currentPage,
    setCollectionSamples,
  ]);
}

// What the open file's calls to its imports return — a CMS query's entries —
// sampled once per value, by the dev server, for the binding picker.
export function useSampleValues(
  coreState: ReturnType<typeof useCoreState>,
  routes: ReturnType<typeof useRoutes>,
) {
  const { currentPage, devStatus, devUrl, project, setValueSamples, valueSamples } = coreState;
  const { model, pageFrontmatter } = routes;
  const pagePath = currentPage?.path;
  useEffect(() => {
    if (!devUrl || devStatus !== 'on' || !project || !pagePath) {
      return undefined;
    }
    const wanted = importedCallsInScope(pageFrontmatter, model?.imports ?? []).filter(
      (call) => !(`${pagePath}|${call.name}` in valueSamples),
    );
    if (!wanted.length) {
      return undefined;
    }
    let live = true;
    const ask = (call: ImportedCall) =>
      readSampleValue({
        projectPath: project.path,
        devUrl,
        pagePath,
        spec: call.spec,
        name: call.exportName,
      })
        .catch(() => undefined)
        .then((value) => [`${pagePath}|${call.name}`, value] as const);
    void Promise.all(wanted.map(ask)).then((pairs) => {
      if (live) {
        setValueSamples((previous) => ({ ...previous, ...Object.fromEntries(pairs) }));
      }
    });
    return () => {
      live = false;
    };
  }, [devUrl, devStatus, project, pagePath, pageFrontmatter, model, valueSamples, setValueSamples]);
}

// Taking back queries the page stopped using.
export function useQueryCleanup(
  routes: ReturnType<typeof useRoutes>,
  history: ReturnType<typeof useHistory>,
) {
  const { model } = routes;
  const { commitEdit } = history;

  // Takes back the queries it wrote, once the page stops using them: delete the
  // last chip reading a collection and its `const … = await getCollection(…)`
  // goes too, rather than leaving a query fetching content for nobody.
  //
  // Three things keep this safe. Only queries carrying Stacki's own marker are
  // considered, so a hand-written one is never touched. "Used" is tested
  // against the whole node tree as text, which over-detects rather than
  // under-detects — the wrong answer here is deleting something live. And it
  // waits for a pause in typing, because a half-typed name reads as unused.
  useEffect(() => {
    const current = model;
    if (!current?.extraFrontmatter?.includes(QUERY_MARK)) {
      return undefined;
    }
    const timer = setTimeout(() => {
      const focused = document.activeElement;
      if (
        focused?.closest?.('.props-field, .rich-content, .bind-input, .expr-input, .attr-editor')
      ) {
        return;
      }
      const fm = current.extraFrontmatter || '';
      const markup = JSON.stringify(current.nodes || []);
      const dead = markedQueries(fm).filter((query) => {
        const word = new RegExp(`\\b${query.name}\\b`);
        const elsewhere = fm.slice(0, query.start) + fm.slice(query.end);
        return !word.test(elsewhere) && !word.test(markup);
      });
      if (!dead.length) {
        return;
      }
      // Step 6, frontmatter: the dead queries, and the import only they needed.
      const cleaned = (pageModel: EditorModel): EditorModel => {
        let next = pageModel.extraFrontmatter || '';
        for (const query of dead) {
          next = removeMarkedQuery(next, query.name);
        }
        // The import goes with the last query that needed it — but only when
        // nothing else in the file mentions it, so an import someone else put
        // there and still uses stays put.
        const mentions = (text: string) => /\bgetCollection\b/.test(text);
        let imports = pageModel.imports;
        if (!mentions(next)) {
          if (!mentions(JSON.stringify(pageModel.nodes || []))) {
            const needed = (i: ImportDecl) =>
              !(i.name === 'getCollection' && i.path === 'astro:content');
            imports = pageModel.imports.filter(needed);
          }
        }
        return { ...pageModel, extraFrontmatter: next, imports };
      };
      commitEdit(frontmatterGesture(current, { coalesceKey: undefined, urgency: false }, cleaned));
    }, 2000);
    return () => clearTimeout(timer);
  }, [model, commitEdit]);
}
