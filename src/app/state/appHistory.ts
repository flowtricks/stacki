// Edits and their history: pushing an entry, property undo, the typed
// code's parse, stepping, undo and redo, scheduling and committing a save,
// the code source, outside edits and file events, and composing navigation
// (App.tsx).

import { useGitIncoming } from '../../features/git/useGitIncoming';
import { revertComponentProperties } from '../../features/componentProperties/propertiesBridge';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parsePageSource as parseSourcePage, readPage } from '../../ipc/bridge';
import { LIMITS } from '../../../shared/core/limits';
import { assert } from '../../../shared/core/assert';
import { scanContainsFile } from '../../editor/pagePersistence';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { editStepPlacement } from '../model/editSteps';
import { type AppliedEdit, type EditGesture, type EditsRecord } from '../../editor/pageEdits';
import { sequence } from '../../editor/editGestures';
import { saveStateAccepted, saveStateBase, saveStateEdited, saveStateNeedsWrite, saveStateRefused } from '../../editor/saveState';
import type { Digest } from '../../../shared/core/brand';
import { cleanError } from '../../lib/cleanError';
import { sourceNodeAtOffset } from '../../features/code/codePanelModel';
import { type EditsEntry, type HistoryEntry, type StepFiles, type UndoCommand } from '../appTypes';
import { stepWithFiles, type PageStep } from '../model/componentCreation';
import { findEditorNodeById as findNodeById, toEditorPageState, carriedParse, type EditorPageState } from '../../editor/pageState';
import { type EditorModel } from '../../editor/pageView';
import { onFilesChanged } from '../../ipc/appBridge';
import { tellCanvas } from '../../editor/canvasQuery';
import { onWindowReturn } from '../../lib/windowReturn';
import { reviewedSource, nextSave } from '../model/nodeFactory';
import { effective } from '../model/pageGestures';
import { revertedSteps, reloadChangedPage } from '../model/appKeys';
import { useCoreState } from './appLifecycle';
import { useLifecycle, useSelectPage, useProjectMenu, useGoToUrl, useReload, useOpenComponent, useCommitPreview, useGitInfo } from './appNavigation';

// Opening files, pages and components.
export function useNavigation(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>) {
  const selectPageScope = useSelectPage(lifecycle, coreState);
  const projectMenu = useProjectMenu(coreState, lifecycle, selectPageScope);
  const goToUrlScope = useGoToUrl(selectPageScope, coreState, lifecycle);
  const reload = useReload(coreState, lifecycle);
  const openComponentScope = useOpenComponent(coreState, lifecycle);
  const commitPreview = useCommitPreview(coreState, lifecycle);
  const gitInfoScope = useGitInfo(coreState, lifecycle);
  const gitIncoming = useGitIncoming(coreState.project?.path, coreState.gitInfo);
  return {
    ...selectPageScope,
    ...projectMenu,
    ...goToUrlScope,
    ...reload,
    ...openComponentScope,
    ...commitPreview,
    ...gitInfoScope,
    gitIncoming,
  };
}

// Recording undo steps.
export function useHistoryPush(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>) {
  const { pageStateRef } = coreState;
  const { historyRef } = lifecycle;

  // The undo step of an edit of the open page (step 9: undo is inverse
  // splices only): its record collects each applied write's inverse.
  // Consecutive edits with the same coalesceKey within 800 ms share one step
  // (typing bursts, dropdown hover-scrubs; editStepPlacement in editSteps.ts);
  // structural edits (no key) always get their own. A step that made files
  // beside its page writes carries them (StepFiles, appTypes.ts), and is never
  // folded into another.
  const pushEditHistory = useCallback(
    (coalesceKey: string | undefined, files: StepFiles | undefined = undefined): EditsRecord => {
      assert(files === undefined || coalesceKey === undefined, 'A step that made files is a step of its own');
      const record: EditsRecord = { outcome: { tag: 'applied', applied: [] } };
      if (!pageStateRef.current.pageState) {
        record.outcome = { tag: 'dropped' };
        return record;
      }
      const history = historyRef.current;
      const now = Date.now();
      const previous = history.past[history.past.length - 1];
      const placement = editStepPlacement(history, coalesceKey, files, now);
      history.future = [];
      history.lastKey = coalesceKey;
      history.lastPush = now;
      if (placement === 'continue') {
        assert(previous?.kind === 'edits', 'An edit continues a page edit step');
        return previous.record;
      }
      history.past.push(files === undefined ? { kind: 'edits', record } : { kind: 'edits', record, files });
      if (history.past.length > LIMITS.undoEntriesMax) {
        history.past.shift();
      }
      return record;
    },
    [historyRef, pageStateRef],
  );

  // Records an already-performed change from outside the page model. `undo`
  // and `redo` are async and do the work themselves (rewrite the file, restore
  // the entry, rename back). Consecutive commands sharing a coalesceKey inside
  // the same burst collapse into one step, so a slider drag or a run of live
  // CSS writes is a single ⌘Z — the first one's `undo` (the oldest state) is
  // kept and the newest `redo` replaces the previous.
  const pushCommand = useCallback(
    (cmd: Omit<UndoCommand, 'kind'>) => {
      const history = historyRef.current;
      const now = Date.now();
      const previous = history.past[history.past.length - 1];
      const coalesce =
        cmd.coalesceKey !== undefined &&
        cmd.coalesceKey === history.lastKey &&
        now - history.lastPush < 800 &&
        previous?.kind === 'cmd' &&
        previous.coalesceKey === cmd.coalesceKey;
      if (coalesce) {
        previous.redo = cmd.redo;
        if (cmd.label !== undefined) {
          previous.label = cmd.label;
        }
      } else {
        history.past.push({ kind: 'cmd', ...cmd });
        if (history.past.length > LIMITS.undoEntriesMax) {
          history.past.shift();
        }
      }
      history.future = [];
      history.lastKey = cmd.coalesceKey ?? undefined;
      history.lastPush = now;
    },
    [historyRef],
  );
  const pushCommandRef = useRef<((command: Omit<UndoCommand, 'kind'>) => void) | undefined>(undefined);
  pushCommandRef.current = pushCommand;
  return { pushCommand, pushEditHistory };
}

// Undoing a component property batch.
export function usePropertyUndo(navigation: ReturnType<typeof useNavigation>, historyPush: ReturnType<typeof useHistoryPush>) {
  const { completePropertySave } = navigation;
  const { pushCommand } = historyPush;

  // Step 6: a property batch's undo is its inverse batch, held by main under a
  // token; applying one returns the token of the batch that redoes it. A file
  // changed since refuses the whole undo, naming it (componentProperties.ts).
  const recordPropertyUndo = useCallback(
    (token: string) => {
      let next = token;
      const step = async (): Promise<void> => {
        const reverted = await revertComponentProperties(next);
        if (!reverted.ok) {
          throw new Error(reverted.error.message);
        }
        next = reverted.value.undo;
        // As after the edit itself: the panel, the page and the scan re-read.
        await completePropertySave();
      };
      pushCommand({ label: 'the property change', undo: step, redo: step });
    },
    [pushCommand, completePropertySave],
  );
  return { recordPropertyUndo };
}

// Installing the parse of typed code.
export function useTypedParse(coreState: ReturnType<typeof useCoreState>, lifecycle: ReturnType<typeof useLifecycle>) {
  const { pageStateRef, setPageState, setSelectedId, typedSourceRef } = coreState;
  const { showToast } = lifecycle;

  // The typed text's parse: a model to show when it parses, the parse-error
  // panel when it does not (plan §3.6). Installed only over the same text: the
  // text orders parses, so no counter does — a parse of text typed over since
  // is dropped, and the parse of the newest text is on its way.
  const parseTypedCode = useCallback(
    async (pagePath: string, source: string, position: number): Promise<void> => {
      let parsed: Awaited<ReturnType<typeof parseSourcePage>>;
      try {
        parsed = await parseSourcePage(pagePath, source);
      } catch (error: unknown) {
        if (typedSourceRef.current === source) {
          typedSourceRef.current = undefined;
          showToast(`Couldn’t update code: ${cleanError(error)}`, 'error');
        }
        return;
      }
      if (pageStateRef.current.currentPage?.path !== pagePath) {
        return;
      }
      if (typedSourceRef.current === source) {
        typedSourceRef.current = undefined;
      }
      // The ref may not show the typed text yet (a fast parse beats the render);
      // the page it shows is what handles are carried from, and whether this
      // parse is still of the page's text is decided when it is installed.
      const local = pageStateRef.current.pageState;
      if (!local) {
        return;
      }
      // Handles carried from the page shown by the text diff, so the editors it
      // feeds keep their keys and focus per keystroke (issue #29). Typed text is
      // no bytes on disk: the origin stays the last one a save left.
      const carried = carriedParse(local, parsed);
      const installed = (current: EditorPageState): EditorPageState => {
        if (!carried.editable) {
          const { reason, bail } = carried;
          return { editable: false, reason, bail, source, save: current.save };
        }
        const origin = current.editable ? current.origin : undefined;
        const model: EditorModel = carried.model;
        return { editable: true, model, source, parsedFrom: source, save: current.save, origin };
      };
      if (carried.editable) {
        const inFrontmatter = carried.model.bodyStart !== undefined && position < carried.model.bodyStart;
        const selected = sourceNodeAtOffset(carried.model.nodes, position);
        setSelectedId(inFrontmatter ? 'frontmatter' : (selected?.id ?? undefined));
      } else {
        setSelectedId(undefined);
      }
      // The save state is whatever is current when this lands: a conflicted
      // page stays conflicted, and a save that landed meanwhile keeps its base.
      setPageState((current) => (current && current.source === source ? installed(current) : current));
    },
    [showToast, pageStateRef, setPageState, setSelectedId, typedSourceRef],
  );

  const scheduleSaveRef = useRef<((urgency?: boolean | 'live') => void) | undefined>(undefined);

  // Undo and redo rewrite files and the page model under whatever is reading
  // them; bumping this tells the style panel to re-read rather than wait for
  // its own polling to notice.
  const [historyTick, setHistoryTick] = useState(0);
  return { historyTick, parseTypedCode, scheduleSaveRef, setHistoryTick };
}

// Undoing or redoing one step of page edits.
export function useStepEdits(lifecycle: ReturnType<typeof useLifecycle>, coreState: ReturnType<typeof useCoreState>) {
  const { autosave, editDrafts, historyRef, showToast } = lifecycle;
  const { pageStateRef, setPageState, setSelectedId } = coreState;

  // Undo or redo one gesture sent as edit requests (step 6): its inverses go
  // out as reverts, newest first, each against the checksum it came back with,
  // so an outside edit since is mapped through or refused — never reverted.
  // What was undone becomes the step in the other direction; a refusal stops
  // there, keeps what is left where it was, and says why (plan §7). Files the
  // step made (a component created from the selection) step with it, after
  // the page on undo and before it on redo (componentCreation.ts).
  const stepEdits = useCallback(
    async (entry: EditsEntry, direction: 'undo' | 'redo') => {
      const history = historyRef.current;
      const back = (next: EditsEntry) => (direction === 'undo' ? history.past : history.future).push(next);
      const forth = (next: HistoryEntry) => (direction === 'undo' ? history.future : history.past).push(next);
      try {
        await autosave(); // Its own writes' answers first.
      } catch {
        /* reported by the save itself; the checks below decide */
      }
      const path = pageStateRef.current.currentPage?.path;
      const state = pageStateRef.current.pageState;
      if (!path || !state) {
        return;
      } // its page is gone — nothing to restore onto
      const outcome = entry.record.outcome;
      if (outcome.tag !== 'applied' || !editDrafts.empty(path) || state.save.tag !== 'clean') {
        // Edits that have not reached disk (refused, or failing) come first:
        // an inverse names the bytes its write left, and the page is not there.
        // Declined, not failed: the step waits until the page is saved.
        back(entry);
        showToast(`Couldn’t ${direction}: this page has edits that are not saved yet.`, 'warning');
        return;
      }
      // Both halves of a partly reverted step keep the files: their calls are
      // idempotent, so whichever half is stepped last does the file's work.
      const files = entry.files;
      const entryOf = (applied: readonly AppliedEdit[]): EditsEntry =>
        files === undefined
          ? { kind: 'edits', record: { outcome: { tag: 'applied', applied } } }
          : { kind: 'edits', record: { outcome: { tag: 'applied', applied } }, files };
      const revert = async (): Promise<PageStep> => {
        const startOrigin = state.editable ? state.origin : undefined;
        const reverted = await revertedSteps(path, outcome.applied, startOrigin);
        if (reverted.refusal !== undefined) {
          showToast(`Couldn’t ${direction}: ${reverted.refusal.message}`, reverted.refusal.kind);
        }
        const { done, written, origin } = reverted;
        const left = outcome.applied.slice(0, outcome.applied.length - done.length);
        if (left.length > 0) {
          back(entryOf(left));
        }
        if (written === undefined) {
          return 'none';
        }
        forth(entryOf(done));
        const reply = written;
        const shown =
          origin === undefined ? toEditorPageState(carriedParse(state, reply)) : toEditorPageState({ ...reply, editable: true, model: origin.model });
        // Installed only over the state the undo started from: a newer edit
        // made meanwhile keeps its model, and main rebases it past the revert.
        setPageState((current) => (current === state ? shown : current));
        if (shown.editable) {
          const model = shown.model;
          const named = (id: string) => id === 'layout' || id === 'frontmatter';
          const gone = (id: string) => !named(id) && !findNodeById(model.nodes, id);
          setSelectedId((id) => (id && gone(id) ? undefined : id));
        }
        return left.length === 0 ? 'whole' : 'part';
      };
      const stepped = await stepWithFiles(direction, files, revert);
      switch (stepped.tag) {
        case 'stepped':
          return;
        case 'refused':
          back(entry); // Nothing changed: the step waits where it was.
          showToast(`Couldn’t ${direction}: ${stepped.message}`, 'error');
          return;
        case 'files-failed':
          showToast(`The page was restored, but its component file was not: ${stepped.message}`, 'error');
          return;
        default: {
          const exhaustive: never = stepped;
          return exhaustive;
        }
      }
    },
    [autosave, editDrafts, showToast, historyRef, pageStateRef, setPageState, setSelectedId],
  );
  return { stepEdits };
}

// Undo and redo.
export function useUndoRedo(
  coreState: ReturnType<typeof useCoreState>,
  typedParse: ReturnType<typeof useTypedParse>,
  lifecycle: ReturnType<typeof useLifecycle>,
  stepEditsScope: ReturnType<typeof useStepEdits>,
) {
  const { propertySave } = coreState;
  const { setHistoryTick } = typedParse;
  const { historyRef, showToast } = lifecycle;
  const { stepEdits } = stepEditsScope;

  const undo = useCallback(async () => {
    if (propertySave.saving.current) {
      return;
    }
    setHistoryTick((count) => count + 1);
    const history = historyRef.current;
    history.lastKey = undefined;
    history.lastPush = 0;
    const entry = effective(history.past);
    if (!entry) {
      return;
    }
    if (entry.kind === 'cmd') {
      history.future.push(entry);
      try {
        await entry.undo();
      } catch (error: unknown) {
        showToast(`Couldn’t undo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(error)}`, 'error');
      }
      setHistoryTick((count) => count + 1); // See below: the undo has landed.
      return;
    }
    await stepEdits(entry, 'undo');
    noteNamedStep(entry, 'Undid', showToast);
    // Again now that the undo has landed. The tick above is read at once by the
    // Style panel, which re-read the CSS before the undo had changed it and kept
    // showing the old value (a background's Type, its layer row) until its next
    // poll. This one is read with the restored page in hand.
    setHistoryTick((count) => count + 1);
  }, [showToast, propertySave.saving, stepEdits, historyRef, setHistoryTick]);

  const redo = useCallback(async () => {
    if (propertySave.saving.current) {
      return;
    }
    setHistoryTick((count) => count + 1);
    const history = historyRef.current;
    history.lastKey = undefined;
    history.lastPush = 0;
    const entry = effective(history.future);
    if (!entry) {
      return;
    }
    if (entry.kind === 'cmd') {
      history.past.push(entry);
      try {
        await entry.redo();
      } catch (error: unknown) {
        showToast(`Couldn’t redo${entry.label ? ` ${entry.label}` : ''}: ${cleanError(error)}`, 'error');
      }
      setHistoryTick((count) => count + 1); // See below: the redo has landed.
      return;
    }
    await stepEdits(entry, 'redo');
    noteNamedStep(entry, 'Redid', showToast);
    // Again now that the redo has landed. The tick above is read at once by the
    // Style panel, which re-read the CSS before the redo had changed it and kept
    // showing the old value (a background's Type, its layer row) until its next
    // poll. This one is read with the restored page in hand.
    setHistoryTick((count) => count + 1);
  }, [showToast, propertySave.saving, stepEdits, historyRef, setHistoryTick]);
  return { redo, undo };
}

// A step an app named (docs/apps.md, "Undo labels") says which one went, as
// History would: the app's own words, not "an attribute edit".
function noteNamedStep(entry: EditsEntry, verb: 'Undid' | 'Redid', showToast: (message: string, kind: 'info') => void): void {
  if (entry.label === undefined) {
    return;
  }
  assert(entry.label.length > 0, 'A step label has words');
  showToast(`${verb} ${entry.label}`, 'info');
}

// Scheduling saves, and reviewing a conflict in code.
export function useScheduleSave(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  typedParse: ReturnType<typeof useTypedParse>,
  historyPush: ReturnType<typeof useHistoryPush>,
) {
  const { pageStateRef, saveTimer, setLeftTab, setPageState } = coreState;
  const { autosave, editDrafts, showToast } = lifecycle;
  const { scheduleSaveRef } = typedParse;
  const { pushEditHistory } = historyPush;

  // Discrete edits (dropdown, checkbox, drag, delete) save immediately;
  // typing batches keystrokes for 300 ms so the preview doesn't rebuild
  // per character. The timeout-0 for immediate saves lets React commit the
  // state update first so flushSave sees the new model.
  //
  // 'live' is the third case: a style-panel scrub or drag, or a mid-typing
  // write, watched on the canvas as it happens. A drag arrives once per
  // animation frame, so 'live' is a throttle, not a debounce: it never pushes
  // back a save already due (nextSave). As a debounce, each frame reset the
  // timer and a steady drag saved nothing until the pointer rested.
  const scheduleSave = useCallback(
    (immediate: boolean | 'live' = false) => {
      const nowMs = Date.now();
      const plan = nextSave({ urgency: immediate, pending: saveTimer.current, nowMs });
      if (plan.tag === 'keep') {
        return;
      }
      clearTimeout(saveTimer.current?.handle);
      const handle = setTimeout(() => {
        // Nothing is pending once this runs: the next request starts a timer
        // of its own rather than keeping one that has already fired.
        saveTimer.current = undefined;
        autosave().catch((error: unknown) => {
          if (pageStateRef.current.pageState?.save.tag !== 'failed') {
            showToast(`Save failed: ${cleanError(error)}`, 'error');
          }
        });
      }, plan.delayMs);
      saveTimer.current = { handle, dueMs: nowMs + plan.delayMs };
    },
    [autosave, showToast, saveTimer, pageStateRef],
  );
  scheduleSaveRef.current = scheduleSave;

  // The conflict notice's actions (plan §7). Reload lives in reloadFromDisk.
  // Review shows the unsaved version as text. Typed code already is text;
  // unsaved gestures are a model, printed for the review, and from then on the
  // page's edits are that text — kept, it is saved as a patch of whatever the
  // disk holds (plan §3.6), never as a whole model.
  const reviewConflictInCode = useCallback(async () => {
    const { currentPage: open, pageState: state } = pageStateRef.current;
    if (!open?.path || state?.save.tag !== 'conflicted') {
      return;
    }
    const typed = editDrafts.entries(open.path).some((entry) => entry.tag === 'code');
    if (state.editable && !typed) {
      let source: string;
      try {
        const shown = await reviewedSource(open.path, state, editDrafts.entries(open.path));
        if (shown.tag === 'failed') {
          showToast(`Couldn’t show your version: ${shown.message}`, 'error');
          return;
        }
        source = shown.source;
      } catch (error: unknown) {
        showToast(`Couldn’t show your version: ${cleanError(error)}`, 'error');
        return;
      }
      const latest = pageStateRef.current.pageState;
      if (latest?.editable && latest.model === state.model) {
        const record = pushEditHistory('code-source');
        const typed = { save: latest.save, source, origin: latest.origin };
        editDrafts.typeCode(open.path, typed, record);
        setPageState((current) => (current?.editable && current.model === state.model ? { ...current, source } : current));
      }
    }
    setLeftTab('code');
  }, [editDrafts, pushEditHistory, showToast, pageStateRef, setLeftTab, setPageState]);
  return { reviewConflictInCode, scheduleSave };
}

// Committing a gesture, and keeping the local version of a conflict.
export function useCommitEdit(
  lifecycle: ReturnType<typeof useLifecycle>,
  coreState: ReturnType<typeof useCoreState>,
  scheduleSaveScope: ReturnType<typeof useScheduleSave>,
  historyPush: ReturnType<typeof useHistoryPush>,
) {
  const { editDrafts, setConflictReason, showToast } = lifecycle;
  const { pageStateRef, propertySave, setPageState, typedCodeUnparsed } = coreState;
  const { scheduleSave } = scheduleSaveScope;
  const { pushEditHistory } = historyPush;

  // Deliberate: the user saw the conflict and keeps the local text, so it now
  // saves over what is on disk (and conflicts again if the disk moves again).
  const keepLocalVersion = useCallback(() => {
    setConflictReason(undefined);
    const path = pageStateRef.current.currentPage?.path;
    if (path) {
      editDrafts.acceptDisk(path);
    } // typed code now patches the disk's text
    setPageState((current) => (current?.save.tag === 'conflicted' ? { ...current, save: saveStateAccepted(current.save) } : current));
    scheduleSave(true);
  }, [scheduleSave, editDrafts, pageStateRef, setConflictReason, setPageState]);

  // A gesture (step 9: every gesture has an intent form, editGestures.ts): its
  // effect shows at once, and it is queued to go to disk as edit requests,
  // stated when sent against the page the app's last reply left — so a node a
  // gesture just created is there to name. A request the specialized editor
  // cannot state still queues: pageEdits derives a minimal node rewrite from
  // the gesture's model effect. Past the queue's bound a gesture is refused,
  // never queued (plan §8).
  // A gesture held for the next one, so the two are one undo step: a prop
  // declared from the binding picker and the field's edit that binds it
  // (holdForNextEdit). The field's edit is made by the field itself, as any
  // pick is, so the declaration waits for it rather than knowing its shape.
  const heldRef = useRef<EditGesture | undefined>(undefined);
  const commitEdit = useCallback(
    (next: EditGesture, step: { readonly files?: StepFiles } = {}): boolean => {
      const held = heldRef.current;
      heldRef.current = undefined;
      const gesture = held === undefined ? next : sequence(held, next);
      assert(held === undefined || step.files === undefined, 'A held declaration joins a page edit, not a step that made files');
      if (propertySave.saving.current) {
        return false;
      }
      const { currentPage, pageState: state } = pageStateRef.current;
      const path = currentPage?.path;
      if (!path || !state?.editable || typedCodeUnparsed()) {
        return false;
      }
      // Every page's gestures are edit requests (step 10: Markdown and MDX
      // too). Without an origin — typed code made the page parse and is not
      // saved yet — no node can be named until that save replies.
      const origin = state.origin;
      if (editDrafts.empty(path) && origin === undefined) {
        // Typed code has not established source references for visual edits yet.
        showToast('Wait for the current code change to finish saving, then try again.', 'info');
        return false;
      }
      if (editDrafts.entries(path).length >= LIMITS.intentsPendingMax) {
        showToast('Too many edits are waiting to be saved — try again in a moment.', 'error');
        return false;
      }
      const record = pushEditHistory(gesture.coalesceKey, step.files);
      const queued = editDrafts.addGesture(path, gesture, record);
      assert(queued === 'queued', 'A gesture inside the bound is queued');
      setPageState((current) => (current?.editable ? { ...current, model: gesture.apply(current.model), save: saveStateEdited(current.save) } : current));
      scheduleSave(gesture.urgency);
      return true;
    },
    [scheduleSave, pushEditHistory, propertySave.saving, editDrafts, typedCodeUnparsed, showToast, pageStateRef, setPageState],
  );
  // The held gesture goes in with the next edit; a field that made none
  // (the pick was refused) leaves it to go in alone once the click is done,
  // so a declared prop is never lost and never joins an unrelated edit.
  const commitRef = useRef(commitEdit);
  commitRef.current = commitEdit;
  const holdForNextEdit = useCallback((gesture: EditGesture): void => {
    assert(heldRef.current === undefined, 'One gesture is held at a time');
    heldRef.current = gesture;
    window.setTimeout(() => {
      if (heldRef.current === gesture) {
        heldRef.current = undefined;
        commitRef.current(gesture);
      }
    }, 0);
  }, []);
  return { commitEdit, holdForNextEdit, keepLocalVersion };
}

// Typed code.
export function useCodeSource(
  coreState: ReturnType<typeof useCoreState>,
  historyPush: ReturnType<typeof useHistoryPush>,
  lifecycle: ReturnType<typeof useLifecycle>,
  scheduleSaveScope: ReturnType<typeof useScheduleSave>,
  typedParse: ReturnType<typeof useTypedParse>,
) {
  const { pageStateRef, setPageState, typedSourceRef } = coreState;
  const { pushEditHistory } = historyPush;
  const { editDrafts } = lifecycle;
  const { scheduleSave } = scheduleSaveScope;
  const { parseTypedCode } = typedParse;

  // Typed code (step 8). The text is the page's edit: it is set at once, so a
  // save sends exactly what the editor holds and a save's reply can never be
  // installed over a newer keystroke. The model follows when main has parsed
  // the text; until then a gesture would edit a model the text has left, so
  // gestures wait (typedCodeUnparsed) — a window of one IPC round trip.
  // Returns the parse, for a caller that needs the model to have followed.
  const changeCodeSource = useCallback(
    (source: string, position: number): Promise<void> => {
      // No property-save guard, as before: the editor already shows the text,
      // so refusing it here would leave typing on screen that never saves.
      const { currentPage: open, pageState: shown } = pageStateRef.current;
      if (!open || open.kind === 'route' || !shown) {
        return Promise.resolve();
      }
      const record = pushEditHistory('code-source');
      const origin = shown.editable ? shown.origin : undefined;
      editDrafts.typeCode(open.path, { save: shown.save, source: shown.source, origin }, record);
      typedSourceRef.current = source;
      // The origin stays: typed text is no bytes on disk, and the code save's
      // reply moves the origin on.
      setPageState((current) => (current ? { ...current, source, save: saveStateEdited(current.save) } : current));
      scheduleSave('live');
      return parseTypedCode(open.path, source, position);
    },
    [pushEditHistory, scheduleSave, editDrafts, parseTypedCode, pageStateRef, setPageState, typedSourceRef],
  );
  return { changeCodeSource };
}

// An edit made outside the app to a page with unsaved edits.
export function useOutsideEdit(lifecycle: ReturnType<typeof useLifecycle>, coreState: ReturnType<typeof useCoreState>) {
  const { editDrafts, pageSaverRef, setConflictReason } = lifecycle;
  const { pageStateRef, setPageState } = coreState;

  // ----------------------------------------------------------------
  // External file changes → refresh panels
  // ----------------------------------------------------------------

  // An outside edit to a page with unsaved edits. Dropping it (the old
  // behaviour) let the pending save overwrite it; reloading would discard the
  // user's input. Neither is ours to decide, so it becomes a conflict and the
  // notice asks (plan §7). A write in flight is left to main's own guard.
  const surfaceOutsideEdit = useCallback(
    async (pagePath: string): Promise<void> => {
      const saver = pageSaverRef.current;
      const before = pageStateRef.current.pageState;
      assert(saver !== undefined, 'The page saver exists before any file event');
      if (!before || !saveStateNeedsWrite(before.save) || saver.writing()) {
        return;
      }
      // Unsaved edits that are all requests map through an outside change or
      // are refused one by one, each with its reason (step 6): no page-wide
      // conflict for them.
      // Typed code is a patch too (step 8): it merges with the outside change
      // or comes back `merge-conflict` — also not a page-wide conflict here.
      if (!editDrafts.empty(pagePath)) {
        return;
      }
      const baseBefore = saveStateBase(before.save);
      let diskChecksum: Digest;
      try {
        diskChecksum = (await readPage(pagePath)).checksum;
      } catch {
        return; // gone or unreadable: the next save reports it
      }
      const latest = pageStateRef.current;
      if (latest.currentPage?.path !== pagePath || !latest.pageState || !saveStateNeedsWrite(latest.pageState.save)) {
        return;
      }
      // A save that started or finished during the read moved the base, and its
      // own guard in main compares against the disk authoritatively.
      const base = saveStateBase(latest.pageState.save);
      if (saver.writing() || base !== baseBefore || diskChecksum === base) {
        return;
      }
      setConflictReason(undefined);
      setPageState((current) =>
        current && saveStateNeedsWrite(current.save) ? { ...current, save: saveStateRefused(current.save, base, diskChecksum) } : current,
      );
    },
    [editDrafts, pageSaverRef, pageStateRef, setConflictReason, setPageState],
  );
  return { surfaceOutsideEdit };
}

// Reconciling the open page with file changes.
export function useFileEvents(
  coreState: ReturnType<typeof useCoreState>,
  lifecycle: ReturnType<typeof useLifecycle>,
  outsideEdit: ReturnType<typeof useOutsideEdit>,
) {
  const { pageStateRef, projectRef, setCurrentPage, setPageState, setSelectedId } = coreState;
  const { dropPageHistory, pageLoadRef, rescan } = lifecycle;
  const { surfaceOutsideEdit } = outsideEdit;

  useEffect(() => {
    // Every file an event named since the last reconcile read them. A burst
    // of events shares one reconcile after it (src/lib/coalescedRun.ts): one scan
    // and one read per tick, and a reconcile begun after the last event sees
    // every file — no counter decides which answer wins.
    const pendingFiles = new Set<string>();
    let closed = false;
    const reconcile = createCoalescedRun(async (): Promise<void> => {
      const proj = projectRef.current;
      if (closed || !proj) {
        return;
      }
      let scanResult;
      try {
        scanResult = await rescan(proj.path);
      } catch {
        return;
      }
      // A newer event waits behind this run: its reconcile scans again, and
      // decides on every file named so far — a superseded scan never decides
      // that a page was deleted.
      if (reconcile.superseded()) {
        return;
      }
      const files = new Set(pendingFiles);
      pendingFiles.clear();
      const { currentPage: page, pageState: state } = pageStateRef.current;
      if (closed || !page || page.kind === 'route') {
        return;
      }
      // Current page deleted externally.
      if (!scanContainsFile(scanResult, page.path)) {
        clearDeletedOpenPage({ pageLoadRef, setCurrentPage, setPageState, setSelectedId });
        return;
      }
      // Chunk .html files feed the open page's Fragment subtrees — treat a
      // change to any of them like a change to the page itself.
      const chunk = [...files].some((file) => file.toLowerCase().endsWith('.html'));
      if (!files.has(page.path) && !chunk && files.size > 0) {
        return;
      }
      if (!state || (files.size === 0 && state.save.tag !== 'clean')) {
        return;
      }
      const reload = { pageStateRef, surfaceOutsideEdit, setPageState, dropPageHistory };
      await reloadChangedPage(reload, { path: page.path, state, chunk }, () => closed);
    });
    const off = onFilesChanged(({ files }) => queueExternalFiles(files, pendingFiles, reconcile.request));
    const offFocus = watchExternalFilesOnReturn({ projectRef, pageStateRef }, pendingFiles, reconcile.request);
    return () => {
      closed = true;
      off();
      offFocus();
    };
  }, [rescan, surfaceOutsideEdit, dropPageHistory, pageLoadRef, pageStateRef, projectRef, setCurrentPage, setPageState, setSelectedId]);
}

function watchExternalFilesOnReturn(
  state: Pick<ReturnType<typeof useCoreState>, 'projectRef' | 'pageStateRef'>,
  pendingFiles: Set<string>,
  request: () => Promise<void>,
): () => void {
  return onWindowReturn(() => {
    if (!state.projectRef.current) {
      return;
    }
    // A missed filesystem event must not leave the app stale after returning
    // from an editor. The checksum check keeps unchanged pages intact.
    const snapshot = state.pageStateRef.current;
    if (snapshot.pageState?.save.tag === 'clean' && snapshot.currentPage?.path) {
      pendingFiles.add(snapshot.currentPage.path);
    }
    // Listings must reconcile even when no page is open or the current page has unsaved edits.
    void request();
    tellCanvas({ type: 'avb:patch-now' });
  });
}

function queueExternalFiles(files: readonly string[], pendingFiles: Set<string>, request: () => Promise<void>): void {
  for (const file of files) {
    pendingFiles.add(file);
  }
  // A reconcile gives up quietly on a failed read; the next event retries it.
  void request();
}

function clearDeletedOpenPage(
  context: Pick<ReturnType<typeof useLifecycle>, 'pageLoadRef'> & Pick<ReturnType<typeof useCoreState>, 'setCurrentPage' | 'setPageState' | 'setSelectedId'>,
): void {
  context.pageLoadRef.current = {};
  context.setCurrentPage(undefined);
  context.setPageState(undefined);
  context.setSelectedId(undefined);
}
