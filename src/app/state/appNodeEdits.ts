// Editing the page's nodes: adding, creating, moving, removing, copying and
// pasting components, the insert palette, the canvas's messages, and
// composing the history (App.tsx).

import { useCallback, useEffect, useRef, useState } from 'react';
import { tellCanvas } from '../../editor/canvasQuery';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { findWithParent, noteIndexAbove, selectionAfterDelete } from '../../editor/treeSelection';
import { setSoundEnabled } from '../../ui/sound';
import { LIMITS } from '../../../shared/core/limits';
import { assert } from '../../../shared/core/assert';
import { keepsSlot as keepsSlotAttribute } from '../../editor/slotAttr';
import { duplicateGesture, frontmatterGesture, insertGesture, moveGesture, removalGesture, sequence } from '../../editor/editGestures';
import { loopVarsAt, strippedBindings } from '../../editor/loopBindings';
import { propsForExtraction } from '../../editor/extractProps';
import { planExtraction, readExtraction, type ExtractionRead } from '../../editor/extractFrontmatter';
import { ancestorChain } from '../../editor/editorTree';
import { cleanError } from '../../lib/cleanError';
import { namesInScope } from '../../editor/dataSuggest';
import type { InsertTarget } from '../../editor/insertTarget';
import { type NodeClipboard } from '../appTypes';
import { findEditorNodeById as findNodeById, findEditorParentList as findParentList } from '../../editor/pageState';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { createdComponentFiles } from '../model/componentCreation';
import {
  createProjectComponent,
  discardProjectComponent,
  findImportPath,
  onSoundSettingChanged,
  readComponentUsage,
  readAppSettings,
} from '../../ipc/appBridge';
import { parseShortcutMessage } from '../../features/preview/previewMessages';
import { namesInSubtree, offerStyleCleanup } from '../../features/selectors/deleteCleanup';
import { newId, withNewIds, usesPageScope, slotHostOf, definitionOf, frontmatterOf } from '../model/nodeFactory';
import { extractionGesture, createdComponentMessage, pasteNeeds, pastedImports, pastePlace } from '../model/pageGestures';
import { pastedInScope, broughtMessage } from '../model/appKeys';
import { prunedAfterRemoval } from '../model/pageQueries';
import { loadComponentInstance, componentInstancePlacement } from '../model/componentInstances';
import { useCoreState } from './appLifecycle';
import { useLifecycle } from './appNavigation';
import {
  useNavigation,
  useHistoryPush,
  usePropertyUndo,
  useTypedParse,
  useStepEdits,
  useUndoRedo,
  useScheduleSave,
  useCommitEdit,
  useCodeSource,
  useOutsideEdit,
  useFileEvents,
} from './appHistory';

// Undo, saving and file events.
export function useHistory(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  navigation: ReturnType<typeof useNavigation>,
) {
  const historyPush = useHistoryPush(coreState, lifecycle);
  const propertyUndo = usePropertyUndo(navigation, historyPush);
  const typedParse = useTypedParse(coreState, lifecycle);
  const stepEditsScope = useStepEdits(lifecycle, coreState);
  const undoRedo = useUndoRedo(coreState, typedParse, lifecycle, stepEditsScope);
  const scheduleSaveScope = useScheduleSave(coreState, lifecycle, typedParse, historyPush);
  const commitEditScope = useCommitEdit(lifecycle, coreState, scheduleSaveScope, historyPush);
  const codeSource = useCodeSource(coreState, historyPush, lifecycle, scheduleSaveScope, typedParse);
  const outsideEdit = useOutsideEdit(lifecycle, coreState);
  useFileEvents(coreState, lifecycle, outsideEdit);
  return {
    ...historyPush,
    ...propertyUndo,
    ...typedParse,
    ...stepEditsScope,
    ...undoRedo,
    ...scheduleSaveScope,
    ...commitEditScope,
    ...codeSource,
    ...outsideEdit,
  };
}

// Placing a project component.
export function useAddComponent(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>) {
  const { insertables, pageStateRef, projectRef, setSelectedId } = coreState;
  const { commitEdit } = history;

  const resolveImportPath = useCallback(
    async (targetPath: string) => {
      const page = pageStateRef.current.currentPage;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !projectPath) {
        throw new Error('An open project page is required to resolve an import');
      }
      return findImportPath(projectPath, page.path, targetPath);
    },
    [pageStateRef, projectRef],
  );

  // target: {parentId: string | undefined, index: number} | undefined (append at end)
  const addComponent = useCallback(
    async (componentName: string, target: InsertTarget | undefined) => {
      const comp = insertables.find((component) => component.path === componentName) ?? insertables.find((component) => component.name === componentName);
      const page = pageStateRef.current.currentPage;
      const projectPath = projectRef.current?.path;
      if (!comp || !page || !projectPath) {
        return;
      }
      const instance = await loadComponentInstance(comp, insertables, projectPath);
      const resolved = await Promise.all(
        instance.components.map(async (component) => ({
          component,
          paths: await resolveImportPath(component.path),
        })),
      );
      // Import lookup is asynchronous; never apply a pending insertion to a
      // different page or project that was opened while those reads ran.
      if (pageStateRef.current.currentPage?.path !== page.path) {
        return;
      }
      if (projectRef.current?.path !== projectPath) {
        return;
      }
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const { node, imports } = componentInstancePlacement(state.model, instance, resolved);
      // Nested defaults and all their imports are one insertion and undo step.
      const insert = insertGesture(state.model, node, target, { urgency: true });
      if (imports.length === state.model.imports.length) {
        commitEdit(insert);
      } else {
        const imported = (model: EditorModel): EditorModel => ({
          ...model,
          imports,
        });
        const options = { coalesceKey: undefined, urgency: true };
        commitEdit(sequence(frontmatterGesture(state.model, options, imported), insert));
      }
      setSelectedId(node.id);
    },
    [insertables, commitEdit, resolveImportPath, pageStateRef, projectRef, setSelectedId],
  );
  return { addComponent, resolveImportPath };
}

// What a component would take as props, and where components are used.
export function useComponentQueries(coreState: ReturnType<typeof useCoreState>) {
  const { pageStateRef, projectRef } = coreState;

  // The page values a subtree reads — the props it would need once it's a file
  // of its own. Asked twice (once to show in the dialog, once to act on) and
  // both times of the live model, so nothing can drift between them.
  const propsNeededFor = useCallback((model: EditorModel, node: EditorNode) => {
    if (!model || !node) {
      return [];
    }
    const scope = namesInScope(model.extraFrontmatter || '', model.imports || []);
    for (const variable of loopVarsAt(model.nodes, node.id)) {
      scope.add(variable);
    }
    // An imported component is carried across as an import, not passed as a prop.
    for (const imp of model.imports || []) {
      scope.delete(imp.name);
    }
    return propsForExtraction(node, scope);
  }, []);

  // What moving those values would take, read from the bytes the page's edits
  // are stated against. An edit still on its way would make those bytes wrong
  // about what the page reads, so until it lands every value stays a prop.
  const extractionFor = useCallback(
    (model: EditorModel, node: EditorNode): ExtractionRead => {
      const { currentPage, pageState } = pageStateRef.current;
      const settled = pageState?.editable === true && pageState.save.tag === 'clean';
      const origin = settled && frontmatterOf(pageState.origin?.model ?? model) === frontmatterOf(model) ? pageState.origin : undefined;
      const chain = ancestorChain(model.nodes, node.id) ?? [];
      return readExtraction({
        origin,
        nodeId: node.id,
        names: propsNeededFor(model, node),
        loopNames: new Set(loopVarsAt(model.nodes, node.id)),
        inLoop: chain.some((ancestor) => ancestor.kind === 'map'),
        parent: /[\\/]src[\\/]pages[\\/]/.test(currentPage?.path ?? '') ? 'page' : 'component',
        shown: model,
      });
    },
    [pageStateRef, propsNeededFor],
  );

  // Where a component is used, for the palette's instance count. Asked of the
  // project (not the open file) so it covers pages and components alike; the
  // component's own file is left out — a file is not one of its own users.
  const componentUsage = useCallback(
    async (comp: ScanComponent) => {
      if (!projectRef.current?.path) {
        return { files: [] };
      }
      try {
        return await readComponentUsage(projectRef.current.path, comp.name, comp.path);
      } catch (error: unknown) {
        // Reported, never swallowed into an empty list: "we couldn't look" and
        // "it isn't used anywhere" are opposite answers, and the second one is
        // the sort of thing somebody acts on.
        return { error: cleanError(error) };
      }
    },
    [projectRef],
  );

  // The instances in the file that's already open — those a click can select
  // rather than navigate to.
  const pageInstancesOf = useCallback(
    (name: string) => {
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      if (!model) {
        return [];
      }
      const out: { readonly id: string }[] = [];
      const walk = (list: readonly EditorNode[], depth: number): void => {
        assert(depth <= LIMITS.treeDepthMax, 'pageInstancesOf: depth exceeds the tree cap');
        for (const node of list || []) {
          if (node.kind === 'component' && node.name === name) {
            out.push({ id: node.id });
          }
          if (Array.isArray(node.children)) {
            walk(node.children, depth + 1);
          }
        }
      };
      walk(model.nodes, 0);
      return out;
    },
    [pageStateRef],
  );
  return { componentUsage, extractionFor, pageInstancesOf, propsNeededFor };
}

// Turning the selection into a component.
export function useCreateComponent(
  coreState: ReturnType<typeof useCoreState>,
  componentQueries: ReturnType<typeof useComponentQueries>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, projectRef, selectedIdRef, setSelectedId } = coreState;
  const { extractionFor } = componentQueries;
  const { rescan, showToast } = lifecycle;
  const { commitEdit } = history;

  // Turn what's selected into a component of its own: write the file, then
  // replace the element in the page with an instance of it. The markup MOVES —
  // the page ends up with `<Card />` where the element was — so this is one
  // edit to two files, and the component file is written first: a page that
  // imports a file that isn't there yet is a broken page, however briefly.
  //
  // The frontmatter the piece reads moves with it unless the person chose to pass
  // a value in as a prop (extractFrontmatter.ts). Its removal from the page is the
  // same gesture's frontmatter write, so the one step below covers it.
  //
  // The page's CSS is the user's and is never rewritten here: its `<style>`
  // blocks stay byte for byte as they were. And it is one undo step: ⌘Z
  // restores the page and the markup, and takes the new file back
  // (componentCreation.ts).
  const createComponentFromSelection = useCallback(
    async (name: string, options: { readonly asProp: readonly string[] }) => {
      const page = pageStateRef.current.currentPage;
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const node = model && selectedIdRef.current ? findNodeById(model.nodes, selectedIdRef.current) : undefined;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !model || !node || !projectPath) {
        return;
      }
      const plan = planExtraction(extractionFor(model, node), new Set(options.asProp));
      const { props } = plan;
      const input = {
        projectPath,
        pagePath: page.path,
        name,
        nodes: node,
        imports: model.imports || [],
        props,
        frontmatter: plan.moved,
      };
      let created;
      try {
        created = await createProjectComponent(input);
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
        return;
      }
      const createdPath = created.path;
      const files = createdComponentFiles(
        {
          discard: async ({ checksum, force }) => (await discardProjectComponent({ projectPath, path: createdPath, checksum, force })).outcome,
          create: async () => (await createProjectComponent(input)).checksum,
          confirmDelete: async () =>
            (await confirmDialog({
              title: `Delete ${created.rel}?`,
              body: 'It has changed since it was created. Undo has restored the page either way.',
              confirmLabel: 'Delete file',
              cancelLabel: 'Keep file',
              danger: true,
            })) === true,
          rescan: async () => {
            await rescan(projectPath);
          },
        },
        created.checksum,
      );
      const paths = await findImportPath(projectPath, page.path, created.path);
      const id = newId();
      // Step 9: the instance goes in before the markup, the markup comes out,
      // and the import follows — one undo step, the markup's bytes moved to
      // the new file rather than reprinted in the page.
      const now = pageStateRef.current.pageState;
      const shown = now?.editable ? now.model : undefined;
      const found = shown ? findWithParent(shown.nodes, node.id) : undefined;
      if (!shown || !found) {
        await files.undo(); // The page moved on meanwhile: nothing will import the file.
        return;
      }
      if (frontmatterOf(shown) !== frontmatterOf(model)) {
        // The plan took code out of a frontmatter that has changed since, and
        // writing it would put the old text back over the new.
        await files.undo();
        showToast('The page’s code changed while the component was being made. Try again.', 'error');
        return;
      }
      const place = { parentId: found.parent?.id ?? undefined, index: found.index };
      const extracted = { id, name, props, place, paths, parent: plan.parent };
      const extraction = extractionGesture(shown, node.id, extracted);
      if (!commitEdit(extraction, { files })) {
        await files.undo(); // Refused: the page won't import the file, so it doesn't stay.
        return;
      }
      setSelectedId(id);
      await rescan(projectPath);
      // Anything left reading the page's scope can't be reconnected on its own:
      // an expression naming something that isn't a value the page holds. The
      // person who just moved it knows what it needs.
      const movedCount = plan.values.filter((value) => value.kind === 'move').length;
      const stranded = usesPageScope(node) && plan.values.length === 0;
      showToast(createdComponentMessage(created.rel, { props: props.length, moved: movedCount }, { stranded }));
    },
    [commitEdit, extractionFor, rescan, showToast, pageStateRef, projectRef, selectedIdRef, setSelectedId],
  );
  return { createComponentFromSelection };
}

// Moving a node.
export function useMoveNode(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>, lifecycle: ReturnType<typeof useLifecycle>) {
  const { insertables, pageStateRef } = coreState;
  const { commitEdit } = history;
  const { showToast } = lifecycle;

  // Step 6, move: the node's own bytes are relocated, its note with it; a
  // `slot` that means nothing where it lands is dropped, and leaving a loop,
  // what read the loop's item becomes placeholder text (editGestures.ts).
  const moveNode = useCallback(
    (nodeId: string, target: InsertTarget | undefined) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // `slot` is a word addressed to the component the node sat inside, and
      // means nothing anywhere else (src/editor/slotAttr.ts).
      const rules = {
        keepsSlot: (model: EditorModel, id: string): boolean => {
          const slot = findNodeById(model.nodes, id)?.props?.['slot'];
          const slotName = slot?.type === 'string' ? slot.value : undefined;
          const host = slotHostOf(model, id);
          const definition = host ? definitionOf(model, host, insertables) : undefined;
          return keepsSlotAttribute({ slotName, host, definition });
        },
      };
      const gesture = moveGesture(state.model, nodeId, target, rules, { urgency: true });
      if (!gesture) {
        return;
      }
      // Left a loop? Anything still reading its item would throw; say what
      // the move replaced.
      const before = loopVarsAt(state.model.nodes, nodeId);
      const after = loopVarsAt(gesture.apply(state.model).nodes, nodeId);
      const lost = before.filter((variable) => !after.includes(variable));
      const node = findNodeById(state.model.nodes, nodeId);
      const removed = node && lost.length ? strippedBindings(node, lost).removed : 0;
      commitEdit(gesture);
      if (removed) {
        showToast(`Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`, 'info');
      }
    },
    [insertables, commitEdit, showToast, pageStateRef],
  );
  return { moveNode };
}

// Removing a node.
export function useRemoveNode(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>, history: ReturnType<typeof useHistory>) {
  const { canvasPathForRef, pageStateRef, projectRef, setSelectedId } = coreState;
  const { showToast } = lifecycle;
  const { commitEdit, pushCommand } = history;

  const removeNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const target = findNodeById(state.model.nodes, nodeId);
      if (target?.kind === 'chunk-group') {
        showToast('This section comes from the page frontmatter — remove it from the code instead.', 'error');
        return;
      }
      // Worked out against the tree as it stands, before the node is gone.
      const nextId = selectionAfterDelete(state.model, nodeId) ?? undefined;
      // Delete the node's note with it, or it would re-attach to whatever now
      // follows and read as that element's description. The note goes first.
      const found = findParentList(state.model, nodeId);
      const noteAt = found ? noteIndexAbove(found.list, found.index) : -1;
      const note = found && noteAt !== -1 ? found.list[noteAt] : undefined;
      const ids = note ? [note.id, nodeId] : [nodeId];
      const removal = removalGesture(ids, { urgency: true });
      const afterRemoval = removal.apply(state.model);
      const removed = prunedAfterRemoval(afterRemoval);
      // Step 6: the nodes go as requests, and what they leave unused in the
      // frontmatter as a frontmatter request after them (one undo step).
      const changed = frontmatterOf(removed.model) !== frontmatterOf(state.model);
      const prune = (model: EditorModel): EditorModel => prunedAfterRemoval(model).model;
      const options = { coalesceKey: undefined, urgency: true };
      const pruning = frontmatterGesture(afterRemoval, options, prune);
      // Read before the edit: once the node is gone it has no path.
      const canvasPath = canvasPathForRef.current(nodeId);
      const committed = commitEdit(changed ? sequence(removal, pruning) : removal);
      if (committed && canvasPath) {
        // Gone from the canvas at once; the rebuilt page confirms it.
        tellCanvas({ type: 'avb:hide-pending', path: canvasPath });
      }
      const projectPath = projectRef.current?.path;
      if (committed && target && projectPath) {
        // Styles only this element used are offered for removal once it is saved.
        const host = { projectPath, showToast, pushCommand, saved: () => pageStateRef.current.pageState?.save.tag === 'clean' };
        void offerStyleCleanup(host, namesInSubtree(target));
      }
      if (removed.dropped.length) {
        const names = removed.dropped;
        showToast(
          `Also removed ${names.map((name) => `\`${name}\``).join(', ')} from the frontmatter — ` +
            `nothing was reading ${names.length === 1 ? 'it' : 'them'} any more.`,
          'info',
        );
      }
      // Only the selection that just vanished moves — deleting some other row
      // (navigator menu, canvas) leaves what you were working on alone.
      setSelectedId((id) => (id === nodeId ? nextId : id));
    },
    [commitEdit, pushCommand, showToast, canvasPathForRef, pageStateRef, projectRef, setSelectedId],
  );

  // ----------------------------------------------------------------
  // Clipboard: copy / paste / duplicate nodes
  // ----------------------------------------------------------------

  const nodeClipboardRef = useRef<NodeClipboard | undefined>(undefined);
  return { nodeClipboardRef, removeNode };
}

// Copying and duplicating nodes.
export function useCopyNode(
  coreState: ReturnType<typeof useCoreState>,
  removeNodeScope: ReturnType<typeof useRemoveNode>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { pageStateRef, setSelectedId } = coreState;
  const { nodeClipboardRef } = removeNodeScope;
  const { showToast } = lifecycle;
  const { commitEdit } = history;

  const copyNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const node = findNodeById(state.model.nodes, nodeId);
      if (!node) {
        return;
      }
      nodeClipboardRef.current = {
        node, // Readonly: later edits build new nodes and leave this one as copied.
        // The loop variables this subtree may reference; pasting somewhere
        // they don't exist has to drop those bindings.
        vars: loopVarsAt(state.model.nodes, nodeId),
        // And the code behind it. A `<Card options={jobs}/>` is not just its
        // markup: `jobs` is a const on the page it was copied from, and pasted
        // into another page it names nothing at all. Taken now rather than at
        // paste time, because by then this page may not even be open.
        frontmatter: state.model.extraFrontmatter || '',
        imports: (state.model.imports || []).map((i) => ({
          name: i.name,
          path: i.path,
        })),
        pagePath: pageStateRef.current.currentPage?.path || undefined,
      };
      // Copying is silent, as it is everywhere else: a notice for it only gets in the way.
    },
    [nodeClipboardRef, pageStateRef],
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      const sourceNode = findNodeById(state.model.nodes, nodeId);
      if (!sourceNode) {
        return;
      }
      if (sourceNode.kind === 'chunk-group' || sourceNode.chunkFile) {
        showToast('Chunk sections are defined in the page frontmatter and cannot be duplicated here.', 'error');
        return;
      }
      const clone = withNewIds(sourceNode);
      // Step 6, insert: the copy is the node's own bytes, spliced after it.
      commitEdit(duplicateGesture(nodeId, clone, { urgency: true }));
      setSelectedId(clone.id);
    },
    [commitEdit, showToast, pageStateRef, setSelectedId],
  );
  return { copyNode, duplicateNode };
}

// Pasting a node.
export function usePasteNode(
  removeNodeScope: ReturnType<typeof useRemoveNode>,
  coreState: ReturnType<typeof useCoreState>,
  addComponentScope: ReturnType<typeof useAddComponent>,
  lifecycle: ReturnType<typeof useLifecycle>,
  history: ReturnType<typeof useHistory>,
) {
  const { nodeClipboardRef } = removeNodeScope;
  const { insertables, pageStateRef, selectedIdRef, setSelectedId } = coreState;
  const { resolveImportPath } = addComponentScope;
  const { showToast } = lifecycle;
  const { commitEdit } = history;

  // Pastes into the current selection when it can host children (a non-void
  // element, or a component with a default slot), otherwise after it (same
  // parent), or at the end of the page. Imports for components in the pasted
  // subtree are added if the target page is missing them (cross-page paste).
  const pasteNode = useCallback(async () => {
    const clip = nodeClipboardRef.current;
    const state = pageStateRef.current.pageState;
    if (!clip || !state?.editable) {
      return;
    }

    const needs = await pasteNeeds(clip, state.model, {
      insertables,
      resolveImportPath,
      currentPath: () => pageStateRef.current.currentPage?.path,
    });
    const clone = withNewIds(clip.node);
    const selectionId = selectedIdRef.current;
    // Step 9: the imports and declarations it needs, then the node itself —
    // one undo step. The model is the one shown now: the lookups above
    // awaited, and edits made meanwhile are part of it.
    const now = pageStateRef.current.pageState;
    if (!now?.editable) {
      return;
    }
    const shown = now.model;
    const imported = pastedImports(needs);
    const withImports = imported(shown);
    const place = pastePlace(withImports, selectionId, insertables);
    const { pasted, removed, lost } = pastedInScope(withImports, clone, place, clip.vars || []);
    if (removed) {
      showToast(`Removed ${removed} binding${removed === 1 ? '' : 's'} that referenced ${lost.join(', ')}.`, 'info');
    }
    const insert = insertGesture(withImports, pasted, place, { urgency: true });
    const options = { coalesceKey: undefined, urgency: true };
    commitEdit(frontmatterOf(withImports) === frontmatterOf(shown) ? insert : sequence(frontmatterGesture(shown, options, imported), insert));
    setSelectedId(clone.id);
    const brought = broughtMessage(needs);
    if (brought !== undefined) {
      showToast(brought, 'info');
    }
  }, [commitEdit, insertables, resolveImportPath, showToast, nodeClipboardRef, pageStateRef, selectedIdRef, setSelectedId]);
  return { pasteNode };
}

// The terminal key, interface sound and the insert palette.
export function useInsertPalette(coreState: ReturnType<typeof useCoreState>) {
  const { setTermOpen } = coreState;

  // ----------------------------------------------------------------
  // Insert palette (⌘F / ⌘E / ⌘K) — quick-add components, tags, loops, …
  // ----------------------------------------------------------------

  // ⌘J / ⌃` toggle the terminal dock, the two bindings people already have in
  // their fingers. Both carry a modifier, so they still work while a text field
  // or the terminal itself has focus — unlike the rail's bare-letter shortcuts.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      const isToggle =
        (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j') || (event.ctrlKey && !event.metaKey && !event.altKey && event.key === '`');
      if (!isToggle) {
        return;
      }
      event.preventDefault();
      setTermOpen((open) => !open);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setTermOpen]);

  const [insertOpen, setInsertOpen] = useState(false);

  // Interface sound. The menu owns the setting, so the app reads it once on
  // load and takes the menu's word for it afterwards; nothing in here decides
  // to make a noise on its own.
  useEffect(() => {
    let live = true;
    readAppSettings()
      .then((settings) => {
        if (live) {
          setSoundEnabled(settings.sound);
        }
      })
      .catch(() => {});
    const off = onSoundSettingChanged((enabled) => setSoundEnabled(enabled));
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return { insertOpen, setInsertOpen };
}

// Shortcuts forwarded from the canvas.
export function useCanvasMessages(coreState: ReturnType<typeof useCoreState>, insertPalette: ReturnType<typeof useInsertPalette>) {
  const { inPreviewRef, pageStateRef } = coreState;
  const { setInsertOpen } = insertPalette;

  // Open requests from the app menu (⌘E accelerator) and from canvas iframes
  // (which forward ⌘F/⌘E/⌘K when they hold keyboard focus).
  useEffect(() => {
    const openIfEditable = () => {
      if (pageStateRef.current.pageState?.editable && !inPreviewRef.current) {
        setInsertOpen(true);
      }
    };
    const offMenu = window.avb.onMenu('insert', openIfEditable);
    const onMessage = (event: MessageEvent<unknown>): void => {
      // Retained pages are only a visual placeholder during navigation; their
      // queued shortcuts must not act on the newly opened editor document.
      const fromOwnFrame = Array.from(document.querySelectorAll('iframe'))
        .filter((frame) => frame.getAttribute('aria-hidden') !== 'true')
        .some((frame) => frame.contentWindow === event.source);
      if (!fromOwnFrame) {
        return;
      }
      const message = parseShortcutMessage(event.data);
      if (message === undefined) {
        return;
      }
      switch (message.name) {
        case 'insert':
          openIfEditable();
          return;
        // ⌥P from the canvas or the live preview, replayed as the physical
        // key so the one handler (usePreviewKey) decides what it does.
        case 'preview':
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', code: 'KeyP', altKey: true, bubbles: true, cancelable: true }));
          return;
        // Arrow keys pressed while the canvas iframe holds focus: replay them
        // on the app window so tree navigation behaves the same whether the
        // selection was made on the canvas or in the navigator.
        case 'arrow':
          window.dispatchEvent(new KeyboardEvent('keydown', { key: message.key, bubbles: true, cancelable: true }));
          return;
        // Delete / ⌘D from the canvas. Replayed on the document rather than
        // handled here so they go through the same guards as a keypress in the
        // app — one definition of what those keys do, and the handler's own
        // "am I typing in a field" check still sees a non-field target.
        case 'key':
          document.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: message.key,
              metaKey: message.meta,
              ctrlKey: message.meta,
              bubbles: true,
              cancelable: true,
            }),
          );
          return;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => {
      offMenu();
      window.removeEventListener('message', onMessage);
    };
  }, [inPreviewRef, pageStateRef, setInsertOpen]);
}
