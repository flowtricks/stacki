// The app's keyboard and menu handling, and the gestures it triggers:
// history, command and selection keys, reverting steps, reloading a changed
// page, copying the selection as a trail, layout and import gestures, and
// whether focus is in an editable field (App.tsx).

import { canvasTextHasFocus } from '../../editor/canvasTextFocus';
import React from 'react';
import type { ScanComponent, ScanResult } from '../../../shared/properties/projectScan';
import { readPage } from '../../ipc/bridge';
import { type AppliedEdit, type PageOrigin, type EditGesture } from '../../editor/pageEdits';
import { describeRejection, type RejectionReason } from '../../../shared/engine/intent';
import { assert } from '../../../shared/core/assert';
import { type InsertPlace, frontmatterGesture, insertGesture, sequence, tagRenameGesture, wrapGesture } from '../../editor/editGestures';
import type { PageEditError, PageEdited } from '../../../shared/ipc/pageSave';
import { loopVarsAt, strippedBindings } from '../../editor/loopBindings';
import { cleanError } from '../../lib/cleanError';
import { menuPasteClaimed } from '../../ui/menuPasteClaim';
import { type AppHistory, type LeftTab, type NodeClipboard, type ProjectIdentity, type PseudoPick, type RightTab, type ToastKind } from '../appTypes';
import { toEditorPageState, carriedParse, type EditorPageState, type OpenFile, type PageStateSnapshot } from '../../editor/pageState';
import { nodeId, type EditorModel, type EditorNode } from '../../editor/pageView';
import { copyEditorSelection, runNativeEdit, editProjectPage, type ImportPaths } from '../../ipc/appBridge';
import { revertedOrigin, frontmatterOf } from './nodeFactory';
import { deletableSelection } from './selectionDeletion';
import { withPrunedImports, chooseImportPath, withLayoutField, type PasteNeeds } from './pageGestures';

// The app's own keys, read through refs at keypress time: see the keydown effect in App.
export interface AppKeys {
  readonly historyRef: React.MutableRefObject<AppHistory>;
  readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
  readonly selectedIdRef: React.MutableRefObject<string | undefined>;
  readonly pseudoPickRef: React.MutableRefObject<PseudoPick | undefined>;
  readonly openCodeWindowRef: React.MutableRefObject<(() => boolean) | undefined>;
  readonly nodeClipboardRef: React.MutableRefObject<NodeClipboard | undefined>;
  readonly cmsOpenRef: React.MutableRefObject<boolean>;
  readonly undo: () => Promise<void>;
  readonly redo: () => Promise<void>;
  readonly setInsertOpen: (open: boolean) => void;
  readonly setLeftTab: (tab: LeftTab) => void;
  readonly setCreateRequest: React.Dispatch<React.SetStateAction<number>>;
  readonly setRightTab: (tab: RightTab) => void;
  readonly setClassFocus: React.Dispatch<React.SetStateAction<number>>;
  readonly removeNode: (nodeId: string) => void;
  readonly copyNode: (nodeId: string) => void;
  readonly duplicateNode: (nodeId: string) => void;
  readonly pasteNode: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

export function handleAppKeyDown(event: KeyboardEvent, keys: AppKeys): void {
  if (handleHistoryKey(event, keys)) {
    return;
  }
  if (keys.cmsOpenRef.current) {
    return;
  }
  if (handleCommandKey(event, keys)) {
    return;
  }
  handleSelectionKey(event, keys);
}

// ⌘Z undoes, ⇧⌘Z / ⌘Y redoes. True when the key was one of those.
export function handleHistoryKey(event: KeyboardEvent, keys: AppKeys): boolean {
  const mod = event.metaKey || event.ctrlKey;
  // Handled before the CMS check below and without requiring an open page:
  // the stack also holds CSS, CMS and asset changes, which are undoable from
  // anywhere.
  if (mod && (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y')) {
    // A field that answered the key itself (the token field, a code editor)
    // has undone its own typing; undoing a page step as well would take two.
    if (event.defaultPrevented) {
      return true;
    }
    // Typing is the field's to undo, the same rule the menu's Undo follows: a
    // value half-typed in a box is not a step on the page's stack, and taking
    // the key for the page threw the typing's undo away whenever the page had
    // anything to undo.
    if (inEditable()) {
      return true;
    }
    const history = keys.historyRef.current;
    const wantsRedo = event.key.toLowerCase() === 'y' || event.shiftKey;
    if (!(wantsRedo ? history.future : history.past).length) {
      return true;
    } // let the field's own undo have it
    event.preventDefault();
    // Undo and redo report their own failures.
    if (wantsRedo) {
      void keys.redo();
    } else {
      void keys.undo();
    }
    return true;
  }
  return false;
}

// The letters that open the insert palette with ⌘: F, E and K all do, so the
// palette answers whichever a person's other tools taught them.
export const INSERT_PALETTE_KEYS: ReadonlySet<string> = new Set(['f', 'e', 'k']);

// ⌘F / ⌘E / ⌘K, ⌘⇧A and ⌘Enter, which work from inside fields too. True when the key was one.
export function handleCommandKey(event: KeyboardEvent, keys: AppKeys): boolean {
  const mod = event.metaKey || event.ctrlKey;
  // ⌘F / ⌘E / ⌘K open the insert palette (works from anywhere except the
  // code editor, which keeps its own find).
  if (mod && INSERT_PALETTE_KEYS.has(event.key.toLowerCase())) {
    // A rich text field claims ⌘K (link) and ⌘E (code) for itself first.
    if (event.defaultPrevented) {
      return true;
    }
    if (!keys.pageStateRef.current.pageState?.editable) {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setInsertOpen(true);
    return true;
  }

  // ⌘⇧A makes a component out of the selection: the Components panel opens
  // with the naming dialog up, the same thing its create button does.
  // Before the "am I typing" guard, so it works wherever focus happens to
  // be — it acts on the selected element, not on the field.
  if (mod && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a') {
    if (!keys.pageStateRef.current.pageState?.editable) {
      return true;
    }
    if (!keys.selectedIdRef.current || keys.selectedIdRef.current === 'frontmatter') {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setLeftTab('components');
    keys.setCreateRequest((count) => count + 1);
    return true;
  }

  // ⌘Enter goes straight to the selector field: Style tab, caret in its
  // "Add a selector" input. Before the "am I typing" guard below, so it also
  // works from another field in the panel.
  if (mod && !event.altKey && !event.shiftKey && event.key === 'Enter') {
    if (!keys.selectedIdRef.current) {
      return true;
    }
    const element = event.target;
    if (element instanceof HTMLElement && element.closest('.cm-editor')) {
      return true;
    }
    event.preventDefault();
    keys.setRightTab('style');
    keys.setClassFocus((count) => count + 1);
    return true;
  }
  return false;
}

// The keys that act on the selection, outside fields: Enter, S / D, Delete, ⌘C, ⌘D, ⌘V.
export function handleSelectionKey(event: KeyboardEvent, keys: AppKeys): void {
  const mod = event.metaKey || event.ctrlKey;
  const target = event.target;
  if (target instanceof HTMLElement && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) {
    return;
  }
  const state = keys.pageStateRef.current.pageState;
  if (!state?.editable) {
    return;
  }
  const selectionId = keys.selectedIdRef.current;
  const hasNodeSelection = !!selectionId && selectionId !== 'frontmatter';

  // Enter opens the floating editor for a selection that has one
  // (frontmatter, <style>, <script>) — same as its "Edit code" button.
  // Not gated on hasNodeSel: frontmatter is exactly one of these.
  if (!mod && !event.altKey && !event.shiftKey && event.key === 'Enter') {
    // On a focused control Enter means "activate this", not "open the
    // selection" — leave those alone (including the Edit code button
    // itself, which would otherwise fire twice).
    if (target instanceof HTMLElement && target.closest('button, a, [role="button"]')) {
      return;
    }
    if (keys.openCodeWindowRef.current?.()) {
      event.preventDefault();
    }
    return;
  }

  // S / D swap the right panel — plain keys, so they only fire outside
  // fields (the check above) and never collide with ⌘D (duplicate).
  if (!mod && !event.altKey && (event.key === 's' || event.key === 'S')) {
    event.preventDefault();
    keys.setRightTab('style');
    return;
  }
  if (!mod && !event.altKey && (event.key === 'd' || event.key === 'D')) {
    event.preventDefault();
    keys.setRightTab('settings');
    return;
  }

  if (!mod && (event.key === 'Delete' || event.key === 'Backspace')) {
    const deletable = deletableSelection(selectionId, keys.pseudoPickRef.current);
    if (deletable === undefined) {
      return;
    }
    event.preventDefault();
    keys.removeNode(deletable);
  } else if (mod && event.key.toLowerCase() === 'c') {
    // Let native copy win when actual text is selected.
    if (!hasNodeSelection || String(window.getSelection() || '')) {
      return;
    }
    event.preventDefault();
    keys.copyNode(selectionId);
  } else if (mod && event.key.toLowerCase() === 'd') {
    if (!hasNodeSelection) {
      return;
    }
    event.preventDefault();
    keys.duplicateNode(selectionId);
  } else if (mod && event.key.toLowerCase() === 'v') {
    // An open tool that reads the clipboard (the clip-path editor) takes ⌘V: the
    // key is left alone so the browser's paste reaches it (menuPasteClaim.ts).
    if (menuPasteClaimed()) {
      return;
    }
    if (!keys.nodeClipboardRef.current) {
      return;
    }
    event.preventDefault();
    void keys.pasteNode().catch(keys.reportFailure);
  }
}

// Why an undo or redo step did not land, and how loudly to say it. A step
// that was declined (its element moved, the file changed outside Stacki, the
// actor was busy) broke nothing: the file is as it was and the step waits, so
// it is a warning. Only a write that failed, or may have, is an error.
export interface UndoRefusal {
  readonly message: string;
  readonly kind: Extract<ToastKind, 'warning' | 'error'>;
}

// The refusal for a revert main did not apply (revertedSteps).
export function undoRefusal(error: PageEditError): UndoRefusal {
  const refusal: UndoRefusal =
    error.code === 'rejected'
      ? { message: describeRejection(error.reason), kind: rejectionToastKind(error.reason) }
      : { message: error.message, kind: writeFailureToastKind(error.code) };
  assert(refusal.message.length > 0, 'An undo refusal says why');
  return refusal;
}

// A rejection refuses the step's content against the bytes on disk now; it
// writes nothing. Only an editor error is a fault worth the red notice.
function rejectionToastKind(reason: RejectionReason): UndoRefusal['kind'] {
  switch (reason) {
    case 'anchor-moved':
    case 'anchor-ambiguous':
    case 'region-externally-modified':
    case 'source-invalid':
    case 'resource-limit':
    case 'write-race':
    case 'merge-conflict':
      return 'warning';
    case 'unsupported-operation':
    case 'write-failed':
      return 'error';
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// A write failure: a race or a full queue means the write never started, so
// the step only waits; a missing file, a filesystem error or an unverified
// write is a genuine failure.
function writeFailureToastKind(code: Exclude<PageEditError['code'], 'rejected'>): UndoRefusal['kind'] {
  switch (code) {
    case 'write-race':
    case 'backpressured':
      return 'warning';
    case 'missing':
    case 'filesystem':
    case 'uncertain':
      return 'error';
    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

// Sends one undo step's inverses as reverts, newest first, each against the
// checksum it came back with; stops at the first refusal and says why.
export async function revertedSteps(
  path: string,
  applied: readonly AppliedEdit[],
  startOrigin: PageOrigin | undefined,
): Promise<{
  readonly done: readonly AppliedEdit[];
  readonly written: PageEdited | undefined;
  readonly origin: PageOrigin | undefined;
  readonly refusal: UndoRefusal | undefined;
}> {
  const done: AppliedEdit[] = [];
  let origin = startOrigin;
  let written: PageEdited | undefined;
  for (const step of [...applied].reverse()) {
    const hunks = step.inverse;
    if (hunks.length === 0) {
      continue; // A write that changed nothing has nothing to revert.
    }
    const answer = await editProjectPage({
      pagePath: path,
      authoredChecksum: step.checksum,
      edit: { tag: 'revert', hunks },
    });
    if (!answer.ok) {
      return { done, written, origin, refusal: undoRefusal(answer.error) };
    }
    done.push({ checksum: answer.value.checksum, inverse: answer.value.inverse });
    written = answer.value;
    origin = revertedOrigin(origin, answer.value);
  }
  return { done, written, origin, refusal: undefined };
}

// A clean open page whose file changed outside the app, read again and shown
// with its handles carried; a page with unsaved edits surfaces the conflict instead.
export async function reloadChangedPage(
  context: {
    readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
    readonly surfaceOutsideEdit: (pagePath: string) => Promise<void>;
    readonly setPageState: (state: EditorPageState) => void;
    readonly dropPageHistory: () => void;
  },
  changed: { readonly path: string; readonly state: EditorPageState; readonly chunk: boolean },
  closed: () => boolean,
): Promise<void> {
  // Hot-reload only a clean page. Unsaved edits are never overwritten by
  // the disk, nor the disk by them: a dirty page surfaces a conflict, and
  // a saving or conflicted one already has main's verdict coming or shown.
  if (changed.state.save.tag !== 'clean') {
    void context.surfaceOutsideEdit(changed.path);
    return;
  }
  let parsed;
  try {
    parsed = await readPage(changed.path);
  } catch {
    return;
  }
  // Only the page itself changed and the read holds the bytes this clean
  // page already shows: the app's own write heard late (its actor was
  // dropped past LIMITS.documentActorsMax), or an outside save of the same
  // bytes. Nothing changed, so nothing reloads and Undo keeps its entries.
  if (!changed.chunk && parsed.checksum === changed.state.save.checksum) {
    return;
  }
  // The read may finish after another page opened or a fresh edit. Neither
  // may be overwritten by the disk read requested before it: only the same
  // page, still clean, takes it.
  const latest = context.pageStateRef.current;
  const shownPage = latest.pageState;
  if (closed() || latest.currentPage?.path !== changed.path || shownPage?.save.tag !== 'clean') {
    return;
  }
  // The nodes the outside edit left alone keep their handles — the
  // selection with them — by the byte diff (plan §4, src/editor/nodeHandles.ts).
  context.setPageState(toEditorPageState(carriedParse(shownPage, parsed)));
  // Undo steps keep their inverses: after an outside edit they map
  // through it or are refused — they never revert it (plan §11).
  context.dropPageHistory();
}

// ⇧⌘C — the selection's file:line trail, for pasting into an AI chat.
export async function copySelectionTrail(context: {
  readonly flushSave: () => Promise<void>;
  readonly showToast: (message: string, kind?: ToastKind) => void;
  readonly projectRef: React.MutableRefObject<ProjectIdentity | undefined>;
  readonly selectionKeysRef: React.MutableRefObject<readonly string[]>;
}): Promise<void> {
  // The lines are read off the file on disk, and typing is saved on a
  // 300 ms debounce — land the pending edit first or they're one edit old.
  try {
    await context.flushSave();
  } catch (error: unknown) {
    context.showToast(`Couldn’t copy the selection: ${cleanError(error)}`, 'error');
    return;
  }
  const projectPath = context.projectRef.current?.path;
  if (!projectPath) {
    return;
  }
  const copied = await copyEditorSelection(projectPath, [...context.selectionKeysRef.current]);
  if (copied) {
    context.showToast('Selection copied — paste it into your AI chat.');
  } else {
    context.showToast('Nothing selected to copy.', 'error');
  }
}

// A markdown page's layout, written into its `layout:` frontmatter key.
export function markdownLayoutGesture(model: EditorModel, rel: string | undefined): EditGesture {
  const framed = (pageModel: EditorModel): EditorModel => ({
    ...pageModel,
    extraFrontmatter: withLayoutField(pageModel.extraFrontmatter, rel),
    layoutPath: rel,
  });
  return frontmatterGesture(model, { coalesceKey: undefined, urgency: true }, framed);
}

// The imports a wrapper change needs, and those it leaves unused, as the same
// undo step (step 9: a frontmatter slot).
export function withImportsGesture(model: EditorModel, gesture: EditGesture, imports: (pageModel: EditorModel) => EditorModel): EditGesture {
  const after = gesture.apply(model);
  const options = { coalesceKey: undefined, urgency: true };
  return frontmatterOf(imports(after)) === frontmatterOf(after) ? gesture : sequence(gesture, frontmatterGesture(after, options, imports));
}

// The page's layout wrapper renamed to `layout`, or the page wrapped in it when it has
// none; undefined when the wrapper already is that layout or is not a tag.
export function layoutWrapperGesture(
  model: EditorModel,
  wrapper: EditorNode | undefined,
  layout: { readonly name: string; readonly paths: ImportPaths },
): EditGesture | undefined {
  const { name, paths } = layout;
  const imports = (pageModel: EditorModel): EditorModel =>
    withPrunedImports(
      pageModel.imports.some((i) => i.name === name)
        ? pageModel
        : {
            ...pageModel,
            imports: [...pageModel.imports, { name, path: chooseImportPath(pageModel, paths), quote: "'" }],
          },
    );
  if (wrapper) {
    if (wrapper.kind !== 'component' && wrapper.kind !== 'element') {
      return undefined;
    }
    if (wrapper.name === name) {
      return undefined;
    }
    const renamed: EditorNode = { ...wrapper, name };
    const options = { coalesceKey: undefined, urgency: true };
    return withImportsGesture(model, tagRenameGesture(wrapper, renamed, options), imports);
  }
  // No wrapper yet — wrap the whole page in the new layout.
  const created: EditorNode = {
    id: nodeId('layout'),
    kind: 'component',
    name,
    props: {},
    children: [],
  };
  return withImportsGesture(model, wrapGesture(model, created), imports);
}

// Saves what is pending before a navigation goes on. False when the save failed —
// said only while this navigation is still the latest — or a newer one took over.
export async function savedForNavigation(
  flushSave: () => Promise<void>,
  latestRequest: () => boolean,
  showToast: (message: string, kind?: ToastKind) => void,
): Promise<boolean> {
  try {
    await flushSave();
  } catch (error: unknown) {
    if (latestRequest()) {
      showToast(`Save failed: ${cleanError(error)}`, 'error');
    }
    return false;
  }
  return latestRequest();
}

// Whether a text field, a box or anything a caret is in has focus.
export function inEditable(): boolean {
  const active = document.activeElement;
  // Canvas text being edited is a field too: the menu's Copy, Cut and Paste go to it.
  if (canvasTextHasFocus()) {
    return true;
  }
  return active instanceof HTMLElement && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
}

// The component file a caller already named: the instances popup names a component by
// where it lives, and two folders can hold the same basename.
export function componentAtPath(scan: ScanResult, name: string, filePath: string): { readonly name: string; readonly path: string } {
  return (
    scan.components.find((component) => component.path === filePath) || scan.layouts.find((layout) => layout.path === filePath) || { name, path: filePath }
  );
}

// The scanned component or layout with this name.
export function componentNamed(scan: ScanResult, name: string): ScanComponent | undefined {
  return scan.components.find((component) => component.name === name) || scan.layouts.find((layout) => layout.name === name);
}

// The drill-down stack with `entry` on top, unless the file is already open in it.
export function stackWith(entry: OpenFile): (stack: readonly OpenFile[]) => readonly OpenFile[] {
  return (stack) => (stack.some((open) => open.path === entry.path) ? stack : [...stack, entry]);
}

// A pasted node without the bindings of loops it no longer sits in: pasted outside
// the loop it was copied from, they would throw.
export function pastedInScope(
  model: EditorModel,
  clone: EditorNode,
  place: InsertPlace,
  vars: readonly string[],
): { readonly pasted: EditorNode; readonly removed: number; readonly lost: readonly string[] } {
  const landed = insertGesture(model, clone, place, { urgency: true }).apply(model);
  const inScope = loopVarsAt(landed.nodes, clone.id);
  const lost = vars.filter((variable) => !inScope.includes(variable));
  const { node: pasted, removed } = strippedBindings(clone, lost);
  return { pasted, removed, lost };
}

// What a paste brought across from the page it was copied from, if anything.
export function broughtMessage(needs: PasteNeeds): string | undefined {
  const brought = [...needs.carriedImports.map((i) => i.name), ...needs.carried.statements.map((statement) => statement.name)];
  if (!brought.length) {
    return undefined;
  }
  return `Brought ${brought.map((name) => `\`${name}\``).join(', ')} ` + 'across from the page it was copied from.';
}

// What the menu's Copy and Paste act on when no field has focus: see the menu effect in App.
export interface MenuEdits {
  readonly selectedIdRef: React.MutableRefObject<string | undefined>;
  readonly pageStateRef: React.MutableRefObject<PageStateSnapshot>;
  readonly cmsOpenRef: React.MutableRefObject<boolean>;
  readonly nodeClipboardRef: React.MutableRefObject<NodeClipboard | undefined>;
  readonly copyNode: (nodeId: string) => void;
  readonly pasteNode: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}

// The menu's Copy: the field's own, selected text, or else the selected node.
export function menuCopy(menu: MenuEdits): void {
  if (inEditable() || String(window.getSelection() || '')) {
    runNativeEdit('copy');
    return;
  }
  const selectionId = menu.selectedIdRef.current;
  if (selectionId && menu.pageStateRef.current.pageState?.editable && !menu.cmsOpenRef.current) {
    menu.copyNode(selectionId);
  }
}

// The menu's Paste: into the focused field, or to an open tool that claims it,
// or else the copied node. A claiming tool gets the browser's own paste, which
// fires a `paste` event even with no field focused: ⌘V is this menu item, not
// the stock Paste role, so without it the event never fires at all.
export function menuPaste(menu: MenuEdits): void {
  if (inEditable()) {
    runNativeEdit('paste');
    return;
  }
  if (menuPasteClaimed()) {
    runNativeEdit('paste');
    return;
  }
  if (menu.nodeClipboardRef.current && menu.pageStateRef.current.pageState?.editable && !menu.cmsOpenRef.current) {
    void menu.pasteNode().catch(menu.reportFailure);
  }
}
