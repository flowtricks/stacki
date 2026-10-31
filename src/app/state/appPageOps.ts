import { componentReference } from '../model/componentReference';
// Page operations: changing the layout, creating, moving and deleting pages
// and folders, the selection's model, creating from a selection, the
// selected schema, and composing the shortcuts (App.tsx).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ScanPage, ScanComponent } from '../../../shared/properties/projectScan';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { astroAsset as astroAssetDef } from '../../features/palette/astroAssets';
import { getElementSchema } from '../../editor/elementSchemas';
import { frontmatterGesture, unwrapGesture } from '../../editor/editGestures';
import { createTreeIndex } from '../../editor/editorTree';
import { writeFrontmatter } from '../../../shared/page/frontmatterSource';
import { namesIn } from '../../editor/classAttr';
import { toComponentName } from '../../features/palette/componentName';
import { cleanError } from '../../lib/cleanError';
import { autoQueryName, namesInScope, queriesInScope, QUERY_MARK } from '../../editor/dataSuggest';
import type { FieldDefinition } from '../../features/props/propRules';
import type { ComponentCreationSource } from '../../features/palette/PaletteDialogs';
import { type FrontmatterSubject } from '../../features/code/codeWindowTarget';
import { findEditorNodeById as findNodeById } from '../../editor/pageState';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import {
  createProjectPage,
  createProjectPageFolder,
  deleteProjectPage,
  deleteProjectPageFolder,
  moveProjectPage,
  readSampleEntry,
  renameProjectPageFolder,
} from '../../ipc/appBridge';
import { withPrunedImports, schemaFor, withClassField } from '../model/pageGestures';
import { markdownLayoutGesture, withImportsGesture, layoutWrapperGesture } from '../model/appKeys';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import { useNavigation } from './appHistory';
import { useHistory } from './appNodeEdits';
import {
  useNodeEdits,
  useInsertItem,
  useKeyboard,
  useMenuShortcuts,
  useInteractivePreview,
  useEscapeKeys,
  useRoutes,
  useCollections,
  useSampleEntries,
  useSampleValues,
  useQueryCleanup,
} from './appShortcuts';

// Shortcuts, previews and the data the page reads.
export function useShortcuts(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
  history: ReturnType<typeof useHistory>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const insertItemScope = useInsertItem(coreState, nodeEdits, lifecycle, history);
  useKeyboard(lifecycle, coreState, nodeEdits, insertItemScope, history);
  useMenuShortcuts(lifecycle, coreState, insertItemScope, nodeEdits, history);
  const interactivePreview = useInteractivePreview(coreState, navigation);
  useEscapeKeys(coreState, navigation, interactivePreview);
  const routes = useRoutes(coreState);
  useCollections(coreState);
  useSampleEntries(coreState, routes);
  useSampleValues(coreState, routes);
  useQueryCleanup(routes, history);
  return { ...insertItemScope, ...interactivePreview, ...routes };
}

// Changing the page’s layout.
export function useLayoutChange(
  coreState: ReturnType<typeof useCoreState>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageState, pageStateRef, scan, setSelectedId } = coreState;
  const { resolveImportPath } = nodeEdits;
  const { commitEdit } = history;

  const isMarkdownFormatRef = useRef(false);
  isMarkdownFormatRef.current =
    pageState?.editable === true &&
    (pageState.model.format === 'md' || pageState.model.format === 'mdx');

  // The latest layout change, as an identity token (see pageLoadRef).
  const layoutSeq = useRef<object>({});
  const changeLayout = useCallback(
    async (layoutName: string) => {
      const seq = {};
      layoutSeq.current = seq;
      // A markdown page has no wrapper node to swap — Astro reads its layout
      // from the `layout:` frontmatter key, as a path relative to the file.
      // Same picker, different place to write the answer.
      if (isMarkdownFormatRef.current) {
        const layout = layoutName
          ? scan.layouts.find((candidate) => candidate.name === layoutName)
          : undefined;
        if (layoutName && !layout) {
          return;
        }
        // A file-relative path, not an alias: `layout:` is resolved by Astro
        // against the page, and every project has that whether or not it has
        // configured `@/…`.
        const rel = layout ? (await resolveImportPath(layout.path)).relative : undefined;
        if (seq !== layoutSeq.current) {
          return;
        }
        const shown = pageStateRef.current.pageState;
        if (!shown?.editable) {
          return;
        }
        // The YAML block the model now holds, written as the slot that
        // differs — or, on a post without one, a new block at its top.
        commitEdit(markdownLayoutGesture(shown.model, rel));
        return;
      }
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      if (!model) {
        return;
      }
      const wrapper = findNodeById(model.nodes, 'layout');
      if (!layoutName) {
        // Unwrap: the wrapper's tags go, its children stay where they are.
        if (wrapper) {
          commitEdit(withImportsGesture(model, unwrapGesture('layout'), withPrunedImports));
        }
        setSelectedId((id) => (id === 'layout' ? undefined : id));
        return;
      }
      const layout = scan.layouts.find((candidate) => candidate.name === layoutName);
      if (!layout) {
        return;
      }
      const paths = await resolveImportPath(layout.path);
      if (seq !== layoutSeq.current) {
        return;
      } // superseded by a newer change
      const gesture = layoutWrapperGesture(model, wrapper, { name: layout.name, paths });
      if (gesture) {
        commitEdit(gesture);
      }
    },
    [scan.layouts, commitEdit, resolveImportPath, pageStateRef, setSelectedId],
  );
  return { changeLayout, isMarkdownFormatRef };
}

// Creating and deleting pages.
export function usePageCreation(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { currentPage, projectRef, scan, setCurrentPage, setPageState } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  // ----------------------------------------------------------------
  // Page management
  // ----------------------------------------------------------------

  const createPage = useCallback(
    async (name: string, layoutName: string | undefined) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      const layout = scan.layouts.find((candidate) => candidate.name === layoutName) || undefined;
      try {
        const pagePath = await createProjectPage(projectPath, name, layout);
        const result = await rescan(projectPath);
        const page = result.pages.find((candidate) => candidate.path === pagePath);
        if (page) {
          // Opening a page reports its own failures.
          void selectPage(page);
        }
        showToast(`Created ${name}.astro`, 'success');
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [scan.layouts, rescan, selectPage, showToast, projectRef],
  );

  const deletePage = useCallback(
    async (page: ScanPage) => {
      if (
        !(await confirmDialog({
          title: `Delete ${page.name}?`,
          body:
            'This removes the file from disk. ' +
            'It can be brought back from History if it was saved in a version.',
          confirmLabel: 'Delete page',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      await deleteProjectPage(page.path);
      const result = await rescan(projectPath);
      if (currentPage?.path === page.path) {
        const next = result.pages[0] || undefined;
        if (next) {
          // Opening a page reports its own failures.
          void selectPage(next);
        } else {
          setCurrentPage(undefined);
          setPageState(undefined);
        }
      }
      showToast(`Deleted ${page.name}`, 'success');
    },
    [currentPage, rescan, selectPage, showToast, projectRef, setCurrentPage, setPageState],
  );
  return { createPage, deletePage };
}

// Moving pages and creating folders.
export function usePageMoves(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef, scan } = coreState;
  const { rescan, showToast, flushSave } = lifecycle;
  const { selectPage } = navigation;

  // Moves/renames a page (drag between folders, rename dialog). `to` is the
  // new path relative to src/pages including the extension.
  const movePageTo = useCallback(
    async (page: ScanPage, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        throw new Error('Open a project before renaming.');
      }
      await flushSave();
      const newPath = await moveProjectPage(projectPath, page.path, to);
      window.dispatchEvent(new Event('stacki:pages-renamed'));
      const result = await rescan(projectPath);
      if (pageStateRef.current.currentPage?.path === page.path) {
        const np = result.pages.find((candidate) => candidate.path === newPath);
        if (np) {
          // Opening a page reports its own failures.
          void selectPage(np);
        }
      }
    },
    [rescan, selectPage, pageStateRef, projectRef, flushSave],
  );

  // Creates an (empty) folder with a placeholder name; the panel opens a
  // rename dialog right after. Returns the created folder's name.
  const createPageFolder = useCallback(async () => {
    const existing = new Set(scan.pageFolders || []);
    let name = 'new-folder';
    for (let i = 2; existing.has(name); i++) {
      name = `new-folder-${i}`;
    }
    const projectPath = projectRef.current?.path;
    if (!projectPath) {
      return undefined;
    }
    try {
      await createProjectPageFolder(projectPath, name);
      await rescan(projectPath);
      return name;
    } catch (error: unknown) {
      showToast(cleanError(error), 'error');
      return undefined;
    }
  }, [scan, rescan, showToast, projectRef]);
  return { createPageFolder, movePageTo };
}

// Renaming a page folder.
export function useRenamePageFolder(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef } = coreState;
  const { rescan, flushSave } = lifecycle;
  const { selectPage } = navigation;

  const renamePageFolder = useCallback(
    async (from: string, to: string) => {
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        throw new Error('Open a project before renaming.');
      }
      await flushSave();
      await renameProjectPageFolder(projectPath, from, to);
      window.dispatchEvent(new Event('stacki:pages-renamed'));
      const result = await rescan(projectPath);
      // Re-select the current page if it lived inside the renamed folder.
      const open = pageStateRef.current.currentPage;
      if (open && !result.pages.some((candidate) => candidate.path === open.path)) {
        const newName = open.name.startsWith(from + '/')
          ? to + open.name.slice(from.length)
          : undefined;
        const np = newName && result.pages.find((candidate) => candidate.name === newName);
        if (np) {
          // Opening a page reports its own failures.
          void selectPage(np);
        }
      }
    },
    [rescan, selectPage, pageStateRef, projectRef, flushSave],
  );
  return { renamePageFolder };
}

// Deleting a page folder.
export function useDeletePageFolder(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const { pageStateRef, projectRef, setCurrentPage, setPageState } = coreState;
  const { rescan, showToast } = lifecycle;
  const { selectPage } = navigation;

  const deletePageFolder = useCallback(
    async (directory: string, pageCount: number) => {
      const inside = pageCount
        ? `the ${pageCount} page${pageCount === 1 ? '' : 's'} inside it and `
        : '';
      if (
        !(await confirmDialog({
          title: `Delete the folder “${directory}”?`,
          body: `This removes ${inside}the folder from disk.`,
          confirmLabel: 'Delete folder',
          danger: true,
        }))
      ) {
        return;
      }
      const projectPath = projectRef.current?.path;
      if (!projectPath) {
        return;
      }
      try {
        await deleteProjectPageFolder(projectPath, directory);
        const result = await rescan(projectPath);
        const open = pageStateRef.current.currentPage;
        if (open && !result.pages.some((candidate) => candidate.path === open.path)) {
          const next = result.pages[0] || undefined;
          if (next) {
            // Opening a page reports its own failures.
            void selectPage(next);
          } else {
            setCurrentPage(undefined);
            setPageState(undefined);
          }
        }
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
      }
    },
    [rescan, selectPage, showToast, pageStateRef, projectRef, setCurrentPage, setPageState],
  );
  return { deletePageFolder };
}

// The page tree, and binding to a collection.
export function useSelectionModel(
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
) {
  const { model } = shortcuts;
  const { devStatus, devUrl, sampleAskedRef, selectedId, setCollectionSamples } = coreState;
  const { commitEdit } = history;

  // ----------------------------------------------------------------
  // Selection helpers
  // ----------------------------------------------------------------

  const tree = useMemo(() => createTreeIndex(model?.nodes), [model?.nodes]);
  const selectedAncestors = useMemo(
    () => (selectedId ? tree.ancestors(selectedId) || [] : []),
    [tree, selectedId],
  );

  // The frontmatter as one editable code block (imports + everything else,
  // matching how the file is serialized).
  const frontmatterCode = useMemo(() => (model ? writeFrontmatter(model) : ''), [model]);

  // One entry of a collection, asked for when someone opens it in the picker.
  // The ref is what stops a row that has no answer from asking again forever.
  const requestCollectionSample = (name: string): void => {
    if (!name || !devUrl || devStatus !== 'on') {
      return;
    }
    if (sampleAskedRef.current.has(name)) {
      return;
    }
    sampleAskedRef.current.add(name);
    readSampleEntry(devUrl, name)
      .then((entry) => setCollectionSamples((previous) => ({ ...previous, [name]: entry })))
      .catch(() => {});
  };

  // Binding to a collection this page doesn't read yet: the query that fetches
  // it is written here, and the binding then names it like any other value.
  // A query already targeting that collection is reused — one page asking the
  // same content twice is a page doing the same work twice.
  const ensureCollectionQuery = (collection: string): string => {
    const fm = model?.extraFrontmatter || '';
    const existing = queriesInScope(fm).get(collection);
    if (existing) {
      return existing;
    }
    const name = autoQueryName(collection, namesInScope(fm, model?.imports));
    if (!model) {
      return name;
    }
    // Step 9: the frontmatter gesture — the import and the query line, as the
    // slot of the block that differs.
    const queried = (pageModel: EditorModel): EditorModel => {
      const reads = pageModel.imports.some(
        (i) => i.name === 'getCollection' && i.path === 'astro:content',
      );
      const entry = {
        name: 'getCollection',
        imported: 'getCollection',
        path: 'astro:content',
        quote: "'",
        named: true,
      };
      const existing = pageModel.extraFrontmatter || '';
      const gap = existing && !existing.endsWith('\n') ? '\n' : '';
      // No trailing newline: the printer ends the line, and one added here
      // would be left behind as a blank line when the query is taken back.
      const query = `const ${name} = await getCollection('${collection}'); // ${QUERY_MARK}`;
      const imports = reads ? pageModel.imports : [...pageModel.imports, entry];
      return { ...pageModel, imports, extraFrontmatter: `${existing}${gap}${query}` };
    };
    commitEdit(frontmatterGesture(model, { coalesceKey: undefined, urgency: false }, queried));
    return name;
  };
  return {
    ensureCollectionQuery,
    frontmatterCode,
    requestCollectionSample,
    selectedAncestors,
    tree,
  };
}

// What the Components panel would make a component from.
export function useCreateFrom(
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  selectionModel: ReturnType<typeof useSelectionModel>,
  nodeEdits: ReturnType<typeof useNodeEdits>,
) {
  const { model } = shortcuts;
  const { classesForRef, classesTick, selectedId, setSelectedClasses } = coreState;
  const { frontmatterCode, tree } = selectionModel;
  const { propsNeededFor } = nodeEdits;

  const selectedNode: EditorNode | (FrontmatterSubject & { readonly value: string }) | undefined =
    model && selectedId
      ? selectedId === 'frontmatter'
        ? { id: 'frontmatter', kind: 'frontmatter', value: frontmatterCode }
        : tree.node(selectedId)
      : undefined;
  // What the Components panel's create button would act on: the name to suggest
  // for the selected element, or why there's nothing to make a component from.
  const createFrom = useMemo<ComponentCreationSource>(() => {
    if (!model) {
      return { kind: 'unavailable', reason: 'Open a page to make components from it.' };
    }
    // The frontmatter row is no element to make a component from.
    const node = selectedId && selectedId !== 'frontmatter' ? tree.node(selectedId) : undefined;
    if (!node) {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    if (node.kind === 'text' || node.kind === 'expr') {
      return {
        kind: 'unavailable',
        reason: 'Select the element around this, not the text itself.',
      };
    }
    if (node.id === 'layout') {
      return { kind: 'unavailable', reason: 'A layout is already a component of its own.' };
    }
    if (node.kind !== 'element' && node.kind !== 'component') {
      return { kind: 'unavailable', reason: 'Select an element on the canvas first.' };
    }
    // Its first class is the name it already goes by — `.project-card` is a
    // better guess at a component name than `Div`. The tag is the fallback.
    const first = namesIn(node.props?.['class'])[0] || namesIn(node.props?.['class:list'])[0] || '';
    return {
      kind: 'ready',
      name: toComponentName(first) || toComponentName(node.name) || 'Component',
      label: `<${node.name}>`,
      // The page values it reads, which the new component can take as props.
      props: propsNeededFor(model, node),
    };
  }, [selectedId, tree, model, propsNeededFor]);

  // Rendered classes describe one element, and the canvas can only say what the
  // NEW selection's are a frame or two later. Two ways to spend that gap, and
  // both used to be wrong in one direction:
  //
  //   clear at once   the selector field empties and then refills, so every
  //                   click on the canvas flickers through a blank panel.
  //   keep the old    the field is briefly wrong rather than briefly empty,
  //                   which is steadier to look at — but if the report never
  //                   comes (an element the page doesn't render has no classes
  //                   to report) the wrong ones would sit there for good.
  //
  // So: keep the old ones, and only fall back to empty if nothing has arrived
  // by the time the gap stops being a gap. In practice the report lands first
  // and the timer never fires.
  useEffect(() => {
    if (classesForRef.current === selectedId) {
      return undefined;
    }
    const timer = setTimeout(
      () => setSelectedClasses((previous) => (previous.length ? [] : previous)),
      600,
    );
    return () => clearTimeout(timer);
  }, [selectedId, classesTick, classesForRef, setSelectedClasses]);
  return { createFrom, selectedNode };
}

// The layout, and the fields the selection takes.
export function useSelectedSchema(
  selectionModel: ReturnType<typeof useSelectionModel>,
  layoutChange: ReturnType<typeof useLayoutChange>,
  shortcuts: ReturnType<typeof useShortcuts>,
  coreState: ReturnType<typeof useCoreState>,
  createFromScope: ReturnType<typeof useCreateFrom>,
) {
  const { tree } = selectionModel;
  const { isMarkdownFormatRef } = layoutChange;
  const { model } = shortcuts;
  const { insertables, scan, selectedId, project, currentPage } = coreState;
  const { selectedNode } = createFromScope;

  const layoutNode = tree.node('layout');
  // The page may import its layout under any local name (e.g. `import Layout
  // from '../layouts/BaseLayout.astro'`) — resolve the wrapper back to a
  // scanned layout file name for display, pickers, and schema lookup.
  const currentLayoutName = (() => {
    // Markdown names its layout by path in frontmatter rather than wrapping
    // the page in a node, so the picker reads it from there.
    if (isMarkdownFormatRef.current) {
      // Read back out of the frontmatter text, not a cached field: editing
      // that text by hand has to move the picker too.
      const match = (model?.extraFrontmatter || '').match(
        /^[ \t]*layout[ \t]*:[ \t]*(.+?)[ \t]*$/m,
      );
      const base = match?.[1]
        ?.replace(/^['"]|['"]$/g, '')
        .split('/')
        .pop()
        ?.replace(/\.astro$/i, '');
      return base && scan.layouts.some((layout) => layout.name === base) ? base : '';
    }
    if (!layoutNode) {
      return '';
    }
    if (!model) {
      return '';
    }
    const imp = (model.imports || []).find((i) => i.name === layoutNode.name);
    const base = imp?.path
      .split('/')
      .pop()
      ?.replace(/\.astro$/i, '');
    if (base && scan.layouts.some((layout) => layout.name === base)) {
      return base;
    }
    return layoutNode.name ?? '';
  })();

  const selectedComponent =
    selectedNode?.kind === 'component'
      ? componentReference({
          name: selectedNode.name,
          project: project?.path,
          file: currentPage?.path,
          imports: model?.imports ?? [],
          components: insertables,
        })
      : undefined;
  const selectedSchema =
    selectedId === 'layout' && isMarkdownFormatRef.current
      ? schemaFor(scan.layouts.find((layout) => layout.name === currentLayoutName))
      : selectedFields(selectedNode, selectedComponent);
  return { currentLayoutName, layoutNode, selectedSchema, selectedComponent };
}

function selectedFields(
  node: ReturnType<typeof useCreateFrom>['selectedNode'],
  component: ScanComponent | undefined,
): readonly FieldDefinition[] {
  if (!node) {
    return [];
  }
  if (node.kind === 'element') {
    return withClassField(getElementSchema(node.name));
  }
  if (node.kind !== 'component') {
    return [];
  }
  if (node.dynamicTag) {
    return withClassField([]);
  }
  return schemaFor(node.astroAsset ? astroAssetDef(node.name) : component);
}
