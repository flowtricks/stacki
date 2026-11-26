// Editing the page's nodes: adding, creating, moving, removing, copying and
// pasting components, the insert palette, the canvas's messages, and
// composing the history (App.tsx).

import { useTranslate } from '../../lib/i18n/useTranslate';
import { assertCanAddComponent } from '../../features/palette/componentVisibility';
import type { ComponentCreateOptions } from '../../features/palette/PaletteDialogs';
import { gatePlacement, placementNotice } from '../model/placementGate';
import { useCompileFailureNotice } from './appCompileRecovery';
import { documentOfPath, placementNodeOf, placementNodeOfItem } from '../../editor/placementCheck';
import { currentRole } from '../../lib/currentRole';
import { useCallback, useEffect, useRef, useState } from 'react';
import { tellCanvas } from '../../editor/canvasQuery';
import { WarmReads } from '../model/componentWarm';
import { showCloneOnCanvas, showInsertOnCanvas } from '../../editor/canvasInsertShow';
import { planCanvasMove } from '../../../shared/page/canvasMove';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { findWithParent, selectionAfterDelete } from '../../editor/treeSelection';
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
import { findEditorNodeById as findNodeById } from '../../editor/pageState';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { createdComponentFiles, movedStyleFiles, sequencedFiles } from '../model/componentCreation';

import { finishMovedStyles, heldMovedStyles, planMovedStyles, sheetCalls, startMoveJournal, type MovedStyles, type MoveJournal } from './componentStyleChoices';
import { windowHeld } from '../../ui/busyLock';
import { readText } from '../../ipc/bridge';
import {
  createProjectComponent,
  discardProjectComponent,
  findImportPath,
  onSoundSettingChanged,
  readComponentUsage,
  readAppSettings,
} from '../../ipc/appBridge';
import { parseShortcutMessage } from '../../features/preview/previewMessages';
import { canvasClicksIntercepted } from '../../ui/canvasClickSlot';
import { namesInSubtree, offerStyleCleanup } from '../../features/selectors/deleteCleanup';
import { newId, withNewIds, usesPageScope, slotHostOf, definitionOf, frontmatterOf } from '../model/nodeFactory';
import { extractionGesture, createdComponentMessage, movedStylesEdit, pasteNeeds, pastedImports, pastePlace } from '../model/pageGestures';
import { pastedInScope, broughtMessage } from '../model/appKeys';
import { copiedFile, pasteSourceOf } from '../model/contextPaste';
import { useContextPaste } from './appContextPaste';
import { prunedAfterRemoval } from '../model/pageQueries';
import { structuralSelection } from '../model/selectionStructure';
import { loadComponentInstance, componentInstancePlacement, resolveInstanceImports } from '../model/componentInstances';
import { sayMissingAssets } from './missingDefaultAssets';
import { appShortcutRoute } from '../../features/apps/appsRuntime';
import { runShortcutCommand } from '../../features/apps/appCommands';
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
  useCompileFailureNotice(coreState, undoRedo.undo);
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

/** The import specifiers of the components being placed, read once for a moment (componentWarm.ts). */
const importPaths = new WarmReads<Awaited<ReturnType<typeof findImportPath>>>();

// Placing a project component.
export function useAddComponent(
  coreState: ReturnType<typeof useCoreState>,
  history: ReturnType<typeof useHistory>,
  lifecycle: ReturnType<typeof useLifecycle>,
) {
  const translate = useTranslate();
  const { canvasPathForRef, insertables, pageStateRef, projectRef, setSelectedId } = coreState;
  const { commitEdit } = history;
  const { showToast } = lifecycle;

  const resolveImportPath = useCallback(
    async (targetPath: string) => {
      const page = pageStateRef.current.currentPage;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !projectPath) {
        throw new Error('An open project page is required to resolve an import');
      }
      return importPaths.read(`${projectPath}|${page.path}|${targetPath}`, Date.now(), () => findImportPath(projectPath, page.path, targetPath));
    },
    [pageStateRef, projectRef],
  );

  // Choosing a component finds what it reads already read: the palette says which one is highlighted.
  const warmComponent = useCallback(
    (componentName: string): void => {
      const comp = insertables.find((component) => component.path === componentName) ?? insertables.find((component) => component.name === componentName);
      const projectPath = projectRef.current?.path;
      if (comp === undefined || projectPath === undefined) {
        return;
      }
      void loadComponentInstance(comp, insertables, projectPath)
        .then((instance) => resolveInstanceImports(instance, projectPath, resolveImportPath))
        .catch(() => undefined);
    },
    [insertables, projectRef, resolveImportPath],
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
      // Lists already leave out what the role is not offered; this refuses one asked for another way (a drag, a stale list).
      // An admin's hidden component passes: adding it by hand from the Components panel is theirs to do.
      assertCanAddComponent(currentRole(), comp);
      const instance = await loadComponentInstance(comp, insertables, projectPath);
      const resolved = await resolveInstanceImports(instance, projectPath, resolveImportPath);
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
      // The one placement rule: a refusal writes nothing, and the nearest valid place is used, with a note saying so.
      const environment = { insertables, document: documentOfPath(page.path) };
      const subject = placementNodeOfItem({ type: 'component', name: comp.name }, environment);
      const gate = subject === undefined ? undefined : gatePlacement(state.model, { kind: 'new', node: subject }, target, { insertables, pagePath: page.path });
      const notice = gate === undefined ? undefined : placementNotice(gate, translate);
      if (notice !== undefined) {
        showToast(notice.text, notice.tone);
      }
      if (gate?.kind === 'stop') {
        return;
      }
      sayMissingAssets(instance.missing, translate);
      // Nested defaults and all their imports are one insertion and undo step.
      const landing = gate?.kind === 'place' && gate.moved !== undefined ? gate.target : target;
      const insert = insertGesture(state.model, node, landing, { urgency: true });
      // A labelled block stands in on the canvas until the component renders (framePendingInsert.ts).
      const showStandIn = (): void => {
        showInsertOnCanvas(state.model, landing, node, (nodeId) => canvasPathForRef.current(nodeId));
      };
      if (imports.length === state.model.imports.length) {
        if (commitEdit(insert)) {
          showStandIn();
        }
      } else {
        const imported = (model: EditorModel): EditorModel => ({
          ...model,
          imports,
        });
        const options = { coalesceKey: undefined, urgency: true };
        if (commitEdit(sequence(frontmatterGesture(state.model, options, imported), insert))) {
          showStandIn();
        }
      }
      setSelectedId(node.id);
    },
    [insertables, commitEdit, resolveImportPath, canvasPathForRef, pageStateRef, projectRef, setSelectedId, showToast, translate],
  );
  return { addComponent, resolveImportPath, warmComponent };
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
  const translate = useTranslate();
  const { pageStateRef, projectRef, pseudoPickRef, selectedIdRef, setBusy, setSelectedId } = coreState;
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
  // The page's CSS is the user's and is rewritten only on the person's own choice:
  // the rules of the classes checked under "Move styles" leave the page's `<style>`
  // tags and the unlocked stylesheets for a new tag in the component (planMovedStyles,
  // componentStyles.ts); with nothing checked, every `<style>` block and stylesheet stays
  // byte for byte as it was. And it is one undo step: ⌘Z
  // restores the page and the markup, puts the moved rules back, and takes the new file back
  // (componentCreation.ts).
  const createComponentNow = useCallback(
    async (name: string, options: ComponentCreateOptions) => {
      const page = pageStateRef.current.currentPage;
      const state = pageStateRef.current.pageState;
      const model = state?.editable ? state.model : undefined;
      const selectionId = structuralSelection(selectedIdRef.current, pseudoPickRef.current);
      const node = model && selectionId !== undefined ? findNodeById(model.nodes, selectionId) : undefined;
      const projectPath = projectRef.current?.path;
      if (!page?.path || !model || !node || !projectPath) {
        return;
      }
      const plan = planExtraction(extractionFor(model, node), new Set(options.asProp));
      const { props } = plan;
      // "Move styles": planned from the sheets as they are now, before anything is written.
      let moved: MovedStyles | undefined = undefined;
      if (options.moveStyles.length > 0) {
        try {
          moved = await planMovedStyles({ projectPath, model, node }, options.moveStyles);
        } catch (error: unknown) {
          showToast(cleanError(error), 'error');
          return;
        }
      }
      const input = {
        projectPath,
        pagePath: page.path,
        name,
        nodes: node,
        imports: model.imports || [],
        props,
        frontmatter: plan.moved,
        folder: options.folder,
        style: moved?.style,
      };
      let created;
      try {
        created = await createProjectComponent(input);
      } catch (error: unknown) {
        showToast(cleanError(error), 'error');
        return;
      }
      const createdPath = created.path;
      // The folders the file's creation made, so Undo takes them back with it once they are empty; Redo may make them again.
      let createdFolders = created.folders;
      const componentFiles = createdComponentFiles(
        {
          discard: async ({ checksum, force }) =>
            (await discardProjectComponent({ projectPath, path: createdPath, checksum, force, folders: createdFolders })).outcome,
          create: async () => {
            const again = await createProjectComponent(input);
            createdFolders = again.folders;
            return again.checksum;
          },
          confirmDelete: async () =>
            (await confirmDialog({
              title: translate('shell.component.deleteTitle', { rel: created.rel }),
              body: translate('shell.component.deleteBody'),
              confirmLabel: translate('shell.component.deleteConfirm'),
              cancelLabel: translate('shell.component.deleteKeep'),
              danger: true,
            })) === true,
          rescan: async () => {
            await rescan(projectPath);
          },
        },
        created.checksum,
      );
      // Copy first, delete last. The component now holds the moved rules; read it back before anything leaves its source.
      let journal: MoveJournal | undefined = undefined;
      if (moved?.style !== undefined) {
        const componentText = await heldMovedStyles(projectPath, created.rel, moved.plan.carried.rules);
        if (componentText === undefined) {
          await componentFiles.undo();
          showToast(translate('shell.component.movedStylesUnverified', { rel: created.rel }), 'error');
          return;
        }
        // The plan goes on disk before the page or any stylesheet is written: a crash from here on is found and resolved.
        try {
          journal = await startMoveJournal({
            projectPath,
            name,
            component: { path: created.path, rel: created.rel, text: componentText },
            page: { path: page.path, before: await readText(projectPath, page.path) },
            sheets: moved.plan.sheets,
          });
        } catch (error: unknown) {
          await componentFiles.undo(); // No journal, no move: nothing but the new file was written, and it goes.
          showToast(cleanError(error), 'error');
          return;
        }
      }
      // The sheets' half: cleaned only once the page is saved using the component (below), put back before it stops.
      const sheetFiles = moved === undefined || moved.plan.sheets.length === 0 ? undefined : movedStyleFiles(moved.plan.sheets, sheetCalls(translate));
      const files = sheetFiles === undefined ? componentFiles : sequencedFiles(componentFiles, sheetFiles);
      // Taking the move back before the page used the component: the new file goes, and so does the journal of it.
      const abandon = async (): Promise<void> => {
        await files.undo();
        await journal?.clear();
      };
      const sheetsChanged = sheetFiles === undefined ? undefined : await sheetFiles.check('redo');
      if (sheetsChanged !== undefined) {
        await abandon(); // A sheet changed since the plan read it: nothing moves, and the new file goes.
        showToast(sheetsChanged, 'error');
        return;
      }
      const paths = await findImportPath(projectPath, page.path, created.path);
      const id = newId();
      // Step 9: the instance goes in before the markup, the markup comes out,
      // and the import follows — one undo step, the markup's bytes moved to
      // the new file rather than reprinted in the page.
      const now = pageStateRef.current.pageState;
      const shown = now?.editable ? now.model : undefined;
      const found = shown ? findWithParent(shown.nodes, node.id) : undefined;
      if (!shown || !found) {
        await abandon(); // The page moved on meanwhile: nothing will import the file.
        return;
      }
      if (frontmatterOf(shown) !== frontmatterOf(model)) {
        // The plan took code out of a frontmatter that has changed since, and
        // writing it would put the old text back over the new.
        await abandon();
        showToast(translate('shell.component.codeChanged'), 'error');
        return;
      }
      // The page's `<style>` tags lose the moved rules in the same step, unless they changed since the plan read them.
      const pageStyles = movedStylesEdit(shown, moved?.plan.pageStyles ?? []);
      if (pageStyles.kind === 'changed') {
        await abandon();
        showToast(translate('shell.component.stylesChanged'), 'error');
        return;
      }
      const place = { parentId: found.parent?.id ?? undefined, index: found.index };
      const extracted = { id, name, props, place, paths, parent: plan.parent };
      const extraction = extractionGesture(shown, node.id, extracted);
      const gesture = pageStyles.kind === 'ready' ? sequence(extraction, pageStyles.gesture) : extraction;
      if (!commitEdit(gesture, { files })) {
        await abandon(); // Refused: the page won't import the file, so it doesn't stay.
        return;
      }
      setSelectedId(id);
      // The sheets give up the moved rules only once the page on disk uses the component: until then both hold them,
      // so whatever stops this (a crash, a refused save) can leave a rule twice, never nowhere. The journal stays until
      // the move is whole, so a stop here is found when the project opens again.
      if (journal !== undefined) {
        const finished = await finishMovedStyles({ projectPath, pagePath: page.path, journal, sheetFiles, read: () => pageStateRef.current });
        if (finished.kind === 'unsaved') {
          showToast(translate('shell.component.sheetsNotCleaned', { files: moved?.plan.sheets.map((sheet) => sheet.rel).join(', ') ?? '' }), 'warning');
        } else if (finished.kind === 'failed') {
          showToast(finished.message, 'error');
        }
      }
      await rescan(projectPath);
      // Anything left reading the page's scope can't be reconnected on its own:
      // an expression naming something that isn't a value the page holds. The
      // person who just moved it knows what it needs.
      const movedCount = plan.values.filter((value) => value.kind === 'move').length;
      const stranded = usesPageScope(node) && plan.values.length === 0;
      const styles = moved === undefined || moved.plan.carried.rules.length === 0 ? 0 : options.moveStyles.length;
      showToast(createdComponentMessage(created.rel, { props: props.length, moved: movedCount, styles }, { stranded }, translate));
    },
    [commitEdit, extractionFor, rescan, showToast, pageStateRef, projectRef, pseudoPickRef, selectedIdRef, setSelectedId, translate],
  );
  // A move of styles writes several files in a set order: the window waits under the busy cover (BusyOverlay) until
  // it is whole or taken back, so nothing done in Stacki meanwhile (an edit, an undo, another page) can come between.
  const createComponentFromSelection = useCallback(
    async (name: string, options: ComponentCreateOptions) => {
      if (options.moveStyles.length === 0) {
        await createComponentNow(name, options);
        return;
      }
      setBusy(translate('shell.component.movingStyles'));
      try {
        await createComponentNow(name, options);
      } finally {
        setBusy(undefined);
      }
    },
    [createComponentNow, setBusy, translate],
  );
  return { createComponentFromSelection };
}

// Moving a node.
export function useMoveNode(coreState: ReturnType<typeof useCoreState>, history: ReturnType<typeof useHistory>, lifecycle: ReturnType<typeof useLifecycle>) {
  const translate = useTranslate();
  const { canvasPathForRef, insertables, pageStateRef } = coreState;
  const { commitEdit } = history;
  const { showToast } = lifecycle;

  // Step 6, move: the node's own bytes are relocated, its note with it; a
  // `slot` that means nothing where it lands is dropped, and leaving a loop,
  // what read the loop's item becomes placeholder text (editGestures.ts).
  const moveNode = useCallback(
    (nodeId: string, requested: InsertTarget | undefined) => {
      const state = pageStateRef.current.pageState;
      if (!state?.editable) {
        return;
      }
      // The one placement rule, for a drop from the Navigator or the canvas and any other move: a refused place writes
      // nothing, and a valid neighbour is used with a note saying so.
      const gate = gatePlacement(state.model, { kind: 'existing', id: nodeId }, requested, {
        insertables,
        pagePath: pageStateRef.current.currentPage?.path,
      });
      const notice = placementNotice(gate, translate);
      if (notice !== undefined) {
        showToast(notice.text, notice.tone);
      }
      if (gate.kind === 'stop') {
        return;
      }
      const target = gate.moved === undefined ? requested : gate.target;
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
      // Planned against the tree the canvas shows now, before the gesture changes it.
      const canvasMove = target === undefined ? undefined : planCanvasMove(state.model.nodes, nodeId, target, (id) => canvasPathForRef.current(id));
      if (!commitEdit(gesture)) {
        return;
      }
      if (canvasMove !== undefined) {
        // The canvas moves the node's elements at once; the rebuilt page confirms it
        // (electron/preload/frameMove.ts), and a refused write takes it back.
        tellCanvas({ type: 'avb:optimistic-move', move: canvasMove });
      }
      if (removed) {
        showToast(translate('shell.paste.bindingsRemoved', { count: removed, names: lost.join(', ') }), 'info');
      }
    },
    [insertables, commitEdit, showToast, canvasPathForRef, pageStateRef, translate],
  );
  return { moveNode };
}

// Removing a node.
export function useRemoveNode(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>, history: ReturnType<typeof useHistory>) {
  const translate = useTranslate();
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
        showToast(translate('shell.remove.fromFrontmatter'), 'error');
        return;
      }
      // Worked out against the tree as it stands, before the node is gone.
      const nextId = selectionAfterDelete(state.model, nodeId) ?? undefined;
      // The node's note goes with it, or it would re-attach to whatever now
      // follows and read as that element's description: main takes the label
      // with the node's removal and the gesture's effect drops it too.
      const removal = removalGesture([nodeId], { urgency: true });
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
        void offerStyleCleanup(host, namesInSubtree(target), translate);
      }
      if (removed.dropped.length) {
        const names = removed.dropped;
        showToast(translate('shell.remove.alsoRemoved', { count: names.length, names: names.map((name) => `\`${name}\``).join(', ') }), 'info');
      }
      // Only the selection that just vanished moves — deleting some other row
      // (navigator menu, canvas) leaves what you were working on alone.
      setSelectedId((id) => (id === nodeId ? nextId : id));
    },
    [commitEdit, pushCommand, showToast, canvasPathForRef, pageStateRef, projectRef, setSelectedId, translate],
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
  const translate = useTranslate();
  const { canvasPathForRef, pageStateRef, setSelectedId } = coreState;
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
        // The whole file, for a paste into another one: its props, styles and code (appContextPaste.ts).
        source: pasteSourceOf(state.model, copiedFile(pageStateRef.current.currentPage), node),
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
        showToast(translate('shell.duplicate.chunkSections'), 'error');
        return;
      }
      const clone = withNewIds(sourceNode);
      // The copy stands right after the original; where that is not allowed (a second doctype) nothing is written.
      const found = findWithParent(state.model.nodes, nodeId);
      if (found) {
        const gate = gatePlacement(
          state.model,
          {
            kind: 'new',
            node: placementNodeOf(clone, { insertables: coreState.insertables, document: documentOfPath(pageStateRef.current.currentPage?.path) }, 'deep'),
          },
          { parentId: found.parent?.id, index: found.index + 1 },
          { insertables: coreState.insertables, pagePath: pageStateRef.current.currentPage?.path },
        );
        if (gate.kind === 'stop' || gate.moved !== undefined) {
          const reason = gate.kind === 'stop' ? gate.refusal : gate.moved;
          if (reason !== undefined) {
            showToast(translate(reason.messageKey, reason.params), 'error');
          }
          return;
        }
      }
      // Step 6, insert: the copy is the node's own bytes, its note's with them,
      // spliced after it (electron/documents/editRequests.ts, labelledSpan).
      if (commitEdit(duplicateGesture(nodeId, clone, { urgency: true }))) {
        // The copy is on the canvas at once, cloned from what the original rendered (framePendingInsert.ts).
        showCloneOnCanvas(state.model, nodeId, (id) => canvasPathForRef.current(id));
      }
      setSelectedId(clone.id);
    },
    [commitEdit, showToast, canvasPathForRef, pageStateRef, setSelectedId, translate, coreState.insertables],
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
  const translate = useTranslate();
  const { nodeClipboardRef } = removeNodeScope;
  const { insertables, pageStateRef, selectedIdRef, setSelectedId } = coreState;
  const { resolveImportPath } = addComponentScope;
  const { showToast } = lifecycle;
  const { commitEdit } = history;
  const { contextPaste } = useContextPaste(coreState, addComponentScope, lifecycle, history);

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
    const aimed = pastePlace(withImports, selectionId, insertables);
    // The one placement rule: a pasted doctype or list item goes only where it may, or nowhere, and says so.
    const pagePath = pageStateRef.current.currentPage?.path;
    const gate = gatePlacement(withImports, { kind: 'new', node: placementNodeOf(clone, { insertables, document: documentOfPath(pagePath) }, 'deep') }, aimed, {
      insertables,
      pagePath,
    });
    const notice = placementNotice(gate, translate);
    if (notice !== undefined) {
      showToast(notice.text, notice.tone);
    }
    if (gate.kind === 'stop') {
      return;
    }
    const place = gate.target;
    const { pasted, removed, lost } = pastedInScope(withImports, clone, place, clip.vars || []);
    if (removed) {
      showToast(translate('shell.paste.bindingsRemoved', { count: removed, names: lost.join(', ') }), 'info');
    }
    // Into another file: what the markup needs comes with it, or the person chooses how to paste it.
    if ((await contextPaste(clip, pasted, place)) === 'handled') {
      return;
    }
    const insert = insertGesture(withImports, pasted, place, { urgency: true });
    const options = { coalesceKey: undefined, urgency: true };
    commitEdit(frontmatterOf(withImports) === frontmatterOf(shown) ? insert : sequence(frontmatterGesture(shown, options, imported), insert));
    setSelectedId(clone.id);
    const brought = broughtMessage(needs, translate);
    if (brought !== undefined) {
      showToast(brought, 'info');
    }
  }, [commitEdit, contextPaste, insertables, resolveImportPath, showToast, nodeClipboardRef, pageStateRef, selectedIdRef, setSelectedId, translate]);
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
    // ⌘E from the menu while an app that keeps the palette shortcut has focus is the app's.
    // Nothing is inserted while a cover holds the window (src/ui/busyLock.ts).
    const offMenu = window.avb.onMenu('insert', () => {
      if (windowHeld()) {
        return;
      }
      if (appShortcutRoute('Mod+E', document.activeElement ?? undefined) !== 'app') {
        openIfEditable();
      }
    });
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
      // Comment mode takes the canvas: a forwarded edit key (Delete, an arrow, the insert palette) would act on the
      // page's selection while the person is writing a pin. Escape still reaches the editor, which ends the mode.
      if (canvasClicksIntercepted() && !(message.name === 'key' && message.key === 'Escape') && message.name !== 'preview') {
        return;
      }
      switch (message.name) {
        case 'insert':
          openIfEditable();
          return;
        // ⌥⇧P from the canvas or the live preview, replayed as the physical
        // key so the one handler (usePreviewKey) decides what it does.
        case 'preview':
          // i18n-ignore: a physical key code in a replayed keyboard event.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          return;
        // ⌥⇧G, replayed for the one handler of it (useGitPullKey).
        case 'pull':
          // i18n-ignore: a physical key code in a replayed keyboard event.
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', code: 'KeyG', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
          return;
        // A panel chord from the canvas, replayed as its physical key for the rail's own listener (LeftRail.tsx).
        case 'panel':
          document.dispatchEvent(new KeyboardEvent('keydown', { code: message.code, altKey: true, bubbles: true, cancelable: true }));
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
        // An app command's key from the canvas runs it, as it does from the editor (appCommands.ts).
        case 'appCommand':
          runShortcutCommand(message.shortcut);
          return;
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
