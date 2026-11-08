import { componentReference } from '../model/componentReference';
// What the shell is drawn from: the scope context, an instance's props, tag
// options, the code window, a symbol's file, the canvas gate, notices,
// breadcrumbs and marks, the selection's paths, the overlay, and composing
// the page operations (App.tsx).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { readPage, readSymbol } from '../../ipc/bridge';
import { tagOptionsOf } from '../model/pageModelGestures';
import { ancestorChain, nodeAtPath } from '../../editor/editorTree';
import { resolveInstanceProps } from '../../editor/instanceProps';
import { cleanError } from '../../lib/cleanError';
import { findImportOf } from '../../editor/dataSuggest';
import type { TagOption } from '../../features/props/propNodeEditors';
import { codeWindowFor, fileWindowIndentation, FRONTMATTER_SUBJECT, type CodeSubject } from '../../features/code/codeWindowTarget';
import { toEditorPageState } from '../../editor/pageState';
import { readProjectAsset } from '../../ipc/appBridge';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useNavigation } from './appHistory';
import { useHistory } from './appNodeEdits';
import { useNodeEdits } from './appShortcuts';
import {
  useShortcuts,
  useLayoutChange,
  usePageCreation,
  usePageMoves,
  useRenamePageFolder,
  useDeletePageFolder,
  useSelectionModel,
  useCreateFrom,
  useSelectedSchema,
} from './appPageOps';
export { useCanvasGate, useCanvasNotices, useCrumbLabels, useCanvasMarks, useSelectionPaths, useOverlayInfo } from './appCanvasModel';

// The page’s layout, pages and folders, and the selection.
export function usePageOps(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  shortcuts: ReturnType<typeof useShortcuts>,
) {
  const layoutChange = useLayoutChange(coreState, nodeEdits, history);
  const pageCreation = usePageCreation(coreState, lifecycle, navigation);
  const pageMoves = usePageMoves(coreState, lifecycle, navigation);
  const renamePageFolderScope = useRenamePageFolder(coreState, lifecycle, navigation);
  const deletePageFolderScope = useDeletePageFolder(coreState, lifecycle, navigation);
  const selectionModel = useSelectionModel(shortcuts, coreState, history);
  const createFromScope = useCreateFrom(shortcuts, coreState, selectionModel, nodeEdits);
  const selectedSchemaScope = useSelectedSchema(selectionModel, layoutChange, shortcuts, coreState, createFromScope);
  return {
    ...layoutChange,
    ...pageCreation,
    ...pageMoves,
    ...renamePageFolderScope,
    ...deletePageFolderScope,
    ...selectionModel,
    ...createFromScope,
    ...selectedSchemaScope,
  };
}

// Slots, loop scope, and the instance a component was opened from.
export function useScopeContext(
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  coreState: ReturnType<typeof useCoreState>,
) {
  const { model } = shortcuts;
  const { currentLayoutName, selectedAncestors, selectedNode, tree } = pageOps;
  const { currentPage, editStack, insertables, scan, selectedId, project } = coreState;

  // Slots offered by the selected node's parent (the component or layout the
  // node is slotted into) — turns the `slot` attribute into a dropdown.
  let slotOptions: readonly string[] | undefined = undefined;
  if (model && selectedNode && selectedId !== 'layout') {
    const parent = selectedId ? tree.parent(selectedId) : undefined;
    if (parent) {
      if (parent.id === 'layout') {
        slotOptions = scan.layouts.find((layout) => layout.name === currentLayoutName)?.slots || undefined;
      } else if (parent.kind === 'component') {
        slotOptions = componentReference({
          name: parent.name,
          project: project?.path,
          file: currentPage?.path,
          imports: model.imports,
          components: insertables,
        })?.slots;
      }
    }
  }

  // In-scope data at the selection: the file's frontmatter declarations and
  // imports, plus the item/index variables of every enclosing loop. Feeds the
  // loop editor's source list and the content editor's expression chips.
  const loopContext =
    model && selectedNode
      ? {
          frontmatter: model.extraFrontmatter || '',
          imports: model.imports || [],
          ancestorHeads: selectedAncestors
            .slice(0, -1)
            .filter((node) => node.kind === 'map')
            .map((node) => node.head),
        }
      : undefined;

  // What the instance being edited is given.
  //
  // A component opened from the canvas is being looked at in one place, with
  // one set of props — and the panel knew them only by name and type, so a
  // field showing `{heading}` could not say what heading was. The instance
  // says: it is in the file this one was opened from, at the focused path, and
  // the page's own scope is what its expressions come to.
  const [instanceProps, setInstanceProps] = useState<Readonly<Record<string, unknown>> | undefined>(undefined);
  const focusOf = currentPage?.kind === 'component' ? currentPage.focusPath : undefined;
  const hostFile = editStack.length > 1 ? editStack[0] : undefined;
  return { focusOf, hostFile, instanceProps, loopContext, setInstanceProps, slotOptions };
}

// What the instance being edited is given.
export function useInstanceProps(scopeContext: ReturnType<typeof useScopeContext>, coreState: ReturnType<typeof useCoreState>) {
  const { focusOf, hostFile, setInstanceProps } = scopeContext;
  const { collectionSamples, collections, scan } = coreState;

  useEffect(() => {
    if (!focusOf || !hostFile?.path) {
      setInstanceProps(undefined);
      return undefined;
    }
    let dropped = false;
    void (async () => {
      try {
        const disk = await readPage(hostFile.path);
        const read = toEditorPageState(disk);
        if (dropped || !read.editable) {
          return;
        }
        const hostModel = read.model;
        const trail = (String(focusOf).split('|').pop() ?? '').split('.').map(Number);
        const instance = nodeAtPath(hostModel.nodes, trail);
        if (!instance) {
          setInstanceProps(undefined);
          return;
        }
        // The scope at the instance: the file's frontmatter, and the loops
        // around it — `project` inside `projects.map(…)` is what its props are
        // written against.
        const chain = ancestorChain(hostModel.nodes, instance.id) || [];
        setInstanceProps(
          resolveInstanceProps(instance, {
            frontmatter: hostModel.extraFrontmatter || '',
            imports: hostModel.imports || [],
            ancestorHeads: chain
              .slice(0, -1)
              .filter((node) => node.kind === 'map')
              .map((node) => node.head),
            collectionSamples,
            collections,
          }),
        );
      } catch {
        if (!dropped) {
          setInstanceProps(undefined);
        }
      }
    })();
    return () => {
      dropped = true;
    };
  }, [focusOf, hostFile?.path, collectionSamples, collections, scan, setInstanceProps]);
}

// Link targets and the Tag field’s options.
export function useTagOptions(coreState: ReturnType<typeof useCoreState>, pageOps: ReturnType<typeof usePageOps>, shortcuts: ReturnType<typeof useShortcuts>) {
  const { insertables, project, scan } = coreState;
  const { tree } = pageOps;
  const { model } = shortcuts;

  // Link settings (href fields): pages to link to and the ids on this page
  // that anchor links can target.
  const linkContext = useMemo(
    () => ({
      pages: scan.pages,
      sectionIds: tree.sectionIds,
      projectPath: project?.path ?? '',
    }),
    [scan.pages, tree, project?.path],
  );

  // What the Tag field offers: every HTML tag, the project's components,
  // Astro's own, and anything this page's frontmatter already imports — which
  // is how `<AstroLogo />` from an imported .svg becomes reachable.
  // Each option carries what it is, so the list can wear the same icons the
  // insert palette does — a tag, a component, a layout, one of Astro's.
  const tagOptions = React.useMemo<readonly TagOption[]>(() => tagOptionsOf(insertables, model?.imports || []), [insertables, model]);
  return { linkContext, tagOptions };
}

// The floating code window.
export function useCodeWindow(
  coreState: ReturnType<typeof useCoreState>,
  shortcuts: ReturnType<typeof useShortcuts>,
  pageOps: ReturnType<typeof usePageOps>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const { codeWin, fileText, openCodeWindowRef, projectRef, setCodeWin, setFileText } = coreState;
  const { model } = shortcuts;
  const { frontmatterCode, selectedNode, tree } = pageOps;
  const { showToast } = lifecycle;

  // Floating code window target value: page frontmatter, a raw node's inner
  // content, or a text file from public/ (loaded into fileText).
  const isFileWin = codeWin?.kind === 'file';
  const codeWinNode = codeWin && !isFileWin && codeWin.targetId && codeWin.targetId !== 'frontmatter' && model ? tree.node(codeWin.targetId) : undefined;
  const codeWinValue = !codeWin
    ? undefined
    : isFileWin
      ? fileText
      : codeWin.targetId === 'frontmatter'
        ? model
          ? frontmatterCode
          : undefined
        : codeWinNode?.kind === 'raw'
          ? codeWinNode.inner
          : undefined;

  // Returns whether the subject actually has a code editor, so the Enter
  // shortcut below knows whether it handled the key.
  const openCodeWindowFor = (subject: CodeSubject | undefined): boolean => {
    const codeWindow = subject === undefined ? undefined : codeWindowFor(subject);
    if (codeWindow === undefined) {
      return false;
    }
    setCodeWin(codeWindow);
    return true;
  };
  const openCodeWindow = (): boolean => openCodeWindowFor(selectedNode);
  // A navigator double-click names its row instead of reading `selectedNode`
  // (see `openCode` in StructureTree). An id the tree no longer holds, a row
  // removed between the click and the render, opens nothing.
  const openCodeWindowById = (id: string): void => {
    openCodeWindowFor(id === 'frontmatter' ? FRONTMATTER_SUBJECT : tree.node(id));
  };
  // Read by the keydown effect, which is set up long before this exists.
  openCodeWindowRef.current = openCodeWindow;

  // Opens a public/ text file in the floating editor.
  const openAssetFile = useCallback(
    async ({ rel, name }: { readonly rel: string; readonly name: string }) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        const text = await readProjectAsset(projectPath, rel);
        setFileText(text);
        setCodeWin({
          kind: 'file',
          rel,
          title: name,
          language: /\.css$/i.test(name) ? 'css' : 'javascript',
          ...fileWindowIndentation(rel),
        });
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [showToast, projectRef, setCodeWin, setFileText],
  );
  return { codeWinValue, isFileWin, openAssetFile, openCodeWindow, openCodeWindowById };
}

// Opening the file an imported symbol comes from.
export function useSymbolFile(coreState: ReturnType<typeof useCoreState>, pageOps: ReturnType<typeof usePageOps>, lifecycle: ReturnType<typeof useLifecycle>) {
  const { currentPage, editStackRef, projectRef, setCodeWin, setFileText } = coreState;
  const { frontmatterCode } = pageOps;
  const { showToast } = lifecycle;

  // Opens the file an imported symbol is defined in, on its declaration —
  // `{FOOTER_LINKS}` on the page, the array itself in src/consts.ts. Values
  // declared in this file's own frontmatter never come here: those are edited
  // in place, in the panel (see the props panel's source popup).
  const openSymbolFile = useCallback(
    async (name: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return false;
      }
      const imp = findImportOf(frontmatterCode, name);
      if (!imp) {
        return false;
      }
      const stack = editStackRef.current;
      const fromFile = stack[stack.length - 1]?.path || currentPage?.path;
      if (!fromFile) {
        return false;
      }
      try {
        const symbol = await readSymbol(projectPath, fromFile, imp.spec, name);
        if (!symbol?.ok) {
          showToast(
            symbol?.reason === 'too-large' ? 'That file is too large to edit in the app.' : `Couldn't find where ${name} is defined (${imp.spec}).`,
            'error',
          );
          return false;
        }
        setFileText(symbol.text);
        setCodeWin({
          kind: 'file',
          area: 'src',
          rel: symbol.rel,
          title: symbol.rel,
          language: /\.css$/i.test(symbol.rel) ? 'css' : 'javascript',
          ...fileWindowIndentation(symbol.rel),
          revealLine: symbol.line,
        });
        return true;
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
        return false;
      }
    },
    [frontmatterCode, currentPage, showToast, editStackRef, projectRef, setCodeWin, setFileText],
  );
  return { openSymbolFile };
}
