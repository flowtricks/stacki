// Design mode's session: the frames, their documents, the selection, the tool, the view and the undo history,
// as one store the interface reads (useDesignState) and one set of gestures that change it.
//
// The no-write guarantee lives here structurally. A session holds copies of the rendered page and nothing
// else: it is started from the canvas's snapshot and a read-only view of the open page's model, its gestures
// change only the frames' own documents (designDom.ts), and the only things it sends anywhere are the read-only
// canvas requests (designBridge.ts) and the app's own browser storage (designDrafts.ts). It is never handed
// the editor, its edit queue or any IPC that writes; test/renderer/app/designMode/designModeBoundary.test.ts
// holds every module of this folder to that.
import { useSyncExternalStore } from 'react';
import { DESIGN_SANDBOX_FRAME_NAME } from '../../../../shared/designMode/designModeContract';
import { prepareBaseline, type DesignComponentEntry, type PageModelView } from '../model/designPrepare';
import { DesignHistory, bodyStateOf, restoreBodyState, type BodyState, type SelectionState } from '../model/designHistory';
import { ElementIdMint, designIdOf, elementByDesignId } from '../model/designDom';
import {
  DESIGN_LIMITS,
  toFrameId,
  type DesignElementId,
  type DesignFrameRecord,
  type DesignInstanceInfo,
  type DesignNodeSource,
  type DesignPage,
  type FrameId,
} from '../model/designTypes';
import { requestSnapshot } from './designBridge';
import { loadDraft, saveDraft, type DesignDraft } from './designDrafts';

export type DesignTool = 'move' | 'text' | 'box' | 'hand';
export const DESIGN_TOOLS: readonly DesignTool[] = ['move', 'text', 'box', 'hand'];

export interface DesignView {
  readonly xPx: number;
  readonly yPx: number;
  readonly scale: number;
}

export type DesignPhase = 'off' | 'starting' | 'on';

export interface DesignState {
  readonly phase: DesignPhase;
  readonly page: DesignPage | undefined;
  readonly frames: readonly DesignFrameRecord[];
  readonly selection: SelectionState | undefined;
  /** A frame picked by its title (for frame actions), when no element of it is. */
  readonly frameSelected: FrameId | undefined;
  readonly tool: DesignTool;
  readonly view: DesignView;
  /** The frame showing the page as it was copied while its "Original" button is held. */
  readonly peek: FrameId | undefined;
  readonly editingText: { readonly frame: FrameId; readonly id: DesignElementId } | undefined;
  /** Bumped by every change of any frame's document: what draws boxes and reads styles listens to it. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** When the session came back from a saved draft. */
  readonly restoredAtMs: number | undefined;
}

/** A page copy a frame was made from: what its changes are read against. Frames duplicated from one share it. */
export interface DesignBaseline {
  readonly id: string;
  readonly html: string;
  readonly document: Document;
  readonly url: string;
  readonly instances: Map<string, DesignInstanceInfo>;
  readonly sources: ReadonlyMap<string, DesignNodeSource>;
}

interface FrameRuntime {
  record: DesignFrameRecord;
  readonly baseline: string;
  /** What the frame's iframe loads: the baseline, a duplicate's document, or a restored draft. */
  readonly initialHTML: string;
  document: Document | undefined;
  mint: ElementIdMint | undefined;
}

const OFF: DesignState = {
  phase: 'off',
  page: undefined,
  frames: [],
  selection: undefined,
  frameSelected: undefined,
  tool: 'move',
  view: { xPx: 80, yPx: 80, scale: 0.5 },
  peek: undefined,
  editingText: undefined,
  revision: 0,
  canUndo: false,
  canRedo: false,
  restoredAtMs: undefined,
};

let state: DesignState = OFF;
const listeners = new Set<() => void>();
const frames = new Map<FrameId, FrameRuntime>();
const baselines = new Map<string, DesignBaseline>();
const history = new DesignHistory();
let frameCounter = 0;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let live: { readonly frame: FrameId; readonly before: BodyState; readonly selection: SelectionState | undefined } | undefined;

function setState(change: (current: DesignState) => DesignState): void {
  state = change(state);
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tells `listener` each time Design mode goes on or off; returns the unsubscribe. */
export function subscribeDesignActive(listener: () => void): () => void {
  let last = isDesignModeActive();
  return subscribe(() => {
    const active = isDesignModeActive();
    if (active !== last) {
      last = active;
      listener();
    }
  });
}

export function designState(): DesignState {
  return state;
}

export function useDesignState(): DesignState {
  return useSyncExternalStore(subscribe, designState);
}

export function isDesignModeActive(): boolean {
  return state.phase !== 'off';
}

/** What starting a session needs from the open page; all of it read-only. */
export interface DesignStart {
  readonly page: DesignPage;
  readonly model: PageModelView | undefined;
  readonly components: readonly DesignComponentEntry[];
}

export type StartOutcome = 'started' | 'restored' | 'no-canvas' | 'failed';

/** Copies the canvas and opens the design canvas on it, or on the draft saved for this page. */
export async function startDesignMode(start: DesignStart): Promise<StartOutcome> {
  if (state.phase !== 'off') {
    return 'started';
  }
  setState(() => ({ ...OFF, phase: 'starting', page: start.page }));
  const draft = await loadDraft(start.page);
  if (draft !== undefined && designState().phase === 'starting') {
    restoreDraft(draft);
    return 'restored';
  }
  const snapshot = await requestSnapshot();
  if (designState().phase !== 'starting') {
    return 'failed';
  }
  if (!snapshot.ok) {
    setState(() => OFF);
    return snapshot.reason === 'no-canvas' ? 'no-canvas' : 'failed';
  }
  const baseline = makeBaseline(snapshot.value.html, snapshot.value.url, start.model, start.components);
  const widthPx = clampWidth(snapshot.value.viewportWidthPx > 0 ? snapshot.value.viewportWidthPx : 1440);
  const viewportHeightPx = clampViewport(snapshot.value.viewportHeightPx > 0 ? snapshot.value.viewportHeightPx : 900);
  const record = newRecord(start.page.title, widthPx, viewportHeightPx, 0);
  frames.set(record.id, { record, baseline: baseline.id, initialHTML: baseline.html, document: undefined, mint: undefined });
  setState((current) => ({ ...current, phase: 'on', frames: [record], view: fittedView([record]) }));
  return 'started';
}

/** Copies the canvas again, as it is now, into a new frame beside the others with its own baseline. */
export async function addFreshFrame(start: Pick<DesignStart, 'model' | 'components'>): Promise<boolean> {
  const snapshot = await requestSnapshot();
  if (!snapshot.ok || state.phase !== 'on' || state.frames.length >= DESIGN_LIMITS.framesMax) {
    return false;
  }
  const baseline = makeBaseline(snapshot.value.html, snapshot.value.url, start.model, start.components);
  const last = state.frames.at(-1);
  const record = newRecord((state.page?.title ?? 'Page') + ' (fresh)', last?.widthPx ?? 1440, last?.viewportHeightPx ?? 900, nextX());
  frames.set(record.id, { record, baseline: baseline.id, initialHTML: baseline.html, document: undefined, mint: undefined });
  pushFrames([...state.frames, record], new Map([[record.id, baseline.html]]));
  return true;
}

function makeBaseline(html: string, url: string, model: PageModelView | undefined, components: readonly DesignComponentEntry[]): DesignBaseline {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const prepared = prepareBaseline(document, model, components);
  const id = 'b' + String(baselines.size + 1);
  const baseline: DesignBaseline = { id, html: prepared.html, document, url, instances: new Map(prepared.instances), sources: prepared.sources };
  baselines.set(id, baseline);
  return baseline;
}

function restoreDraft(draft: DesignDraft): void {
  for (const saved of draft.baselines) {
    const document = new DOMParser().parseFromString(saved.html, 'text/html');
    baselines.set(saved.id, { id: saved.id, html: saved.html, document, url: saved.url, instances: new Map(saved.instances), sources: new Map(saved.sources) });
  }
  for (const saved of draft.frames) {
    frames.set(saved.record.id, { record: saved.record, baseline: saved.baseline, initialHTML: saved.html, document: undefined, mint: undefined });
    frameCounter = Math.max(frameCounter, Number.parseInt(saved.record.id.slice(1), 36));
  }
  const records = draft.frames.map((saved) => saved.record);
  setState((current) => ({ ...current, phase: 'on', frames: records, view: fittedView(records), restoredAtMs: draft.savedAtMs }));
}

/** Leaves Design mode; the frames are saved first, so coming back to this page brings them back. */
export async function exitDesignMode(): Promise<void> {
  if (state.phase === 'off') {
    return;
  }
  await saveNow();
  frames.clear();
  baselines.clear();
  history.clear();
  live = undefined;
  frameCounter = 0;
  setState(() => OFF);
}

/** Throws the saved draft and the frames away and copies the page again. */
export async function startOver(start: DesignStart): Promise<StartOutcome> {
  frames.clear();
  baselines.clear();
  history.clear();
  frameCounter = 0;
  setState(() => OFF);
  await saveDraft(start.page, undefined);
  return startDesignMode(start);
}

function newRecord(name: string, widthPx: number, viewportHeightPx: number, xPx: number): DesignFrameRecord {
  frameCounter += 1;
  return { id: toFrameId('f' + frameCounter.toString(36)), name: name.slice(0, DESIGN_LIMITS.frameNameCharsMax), widthPx, viewportHeightPx, xPx, yPx: 0 };
}

function nextX(): number {
  return state.frames.reduce((right, frame) => Math.max(right, frame.xPx + frame.widthPx + DESIGN_LIMITS.frameGapPx), 0);
}

export function clampWidth(widthPx: number): number {
  return Math.round(Math.min(DESIGN_LIMITS.frameWidthPxMax, Math.max(DESIGN_LIMITS.frameWidthPxMin, widthPx)));
}

function clampViewport(heightPx: number): number {
  return Math.round(Math.min(DESIGN_LIMITS.viewportHeightPxMax, Math.max(DESIGN_LIMITS.viewportHeightPxMin, heightPx)));
}

/** The view that shows every frame's top within a typical canvas, before the canvas measures itself. */
function fittedView(records: readonly DesignFrameRecord[]): DesignView {
  const right = records.reduce((most, frame) => Math.max(most, frame.xPx + frame.widthPx), 0);
  const scale = Math.min(1, Math.max(DESIGN_LIMITS.zoomMin, 1100 / Math.max(1, right)));
  return { xPx: 60, yPx: 70, scale };
}

// ---------------------------------------------------------------------------
// Frames and their documents
// ---------------------------------------------------------------------------

export function frameInitialHTML(id: FrameId): string | undefined {
  return frames.get(id)?.initialHTML;
}

export function frameDocument(id: FrameId): Document | undefined {
  return frames.get(id)?.document;
}

export function frameBaseline(id: FrameId): DesignBaseline | undefined {
  const runtime = frames.get(id);
  return runtime === undefined ? undefined : baselines.get(runtime.baseline);
}

export function frameRecord(id: FrameId): DesignFrameRecord | undefined {
  return state.frames.find((frame) => frame.id === id);
}

/** The name sandbox iframes carry, so the preload leaves them alone (they are this window's documents). */
export const SANDBOX_FRAME_NAME = DESIGN_SANDBOX_FRAME_NAME;

/** A frame's iframe finished loading its document. */
export function attachFrameDocument(id: FrameId, document: Document): void {
  const runtime = frames.get(id);
  if (runtime === undefined) {
    return;
  }
  runtime.document = document;
  runtime.mint = new ElementIdMint(document);
  bump();
}

export function detachFrameDocument(id: FrameId, document: Document): void {
  const runtime = frames.get(id);
  if (runtime !== undefined && runtime.document === document) {
    runtime.document = undefined;
  }
}

export function frameMint(id: FrameId): ElementIdMint | undefined {
  return frames.get(id)?.mint;
}

/** Says a frame's document changed outside a gesture (it measured, an image loaded): boxes are drawn again. */
export function bump(): void {
  setState((current) => ({ ...current, revision: current.revision + 1 }));
}

/** The full document of a frame as text, as it is now (for a duplicate, a capture, or the draft). */
export function serializeFrame(id: FrameId): string | undefined {
  const document = frames.get(id)?.document;
  return document === undefined ? frames.get(id)?.initialHTML : '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
}

// ---------------------------------------------------------------------------
// Selection, tool, view
// ---------------------------------------------------------------------------

export function select(selection: SelectionState | undefined): void {
  const ids = selection === undefined ? [] : selection.ids.slice(0, DESIGN_LIMITS.selectionMax);
  setState((current) => ({
    ...current,
    selection: selection === undefined || ids.length === 0 ? undefined : { frame: selection.frame, ids },
    frameSelected: selection === undefined || ids.length === 0 ? current.frameSelected : undefined,
  }));
}

export function selectFrame(id: FrameId | undefined): void {
  setState((current) => ({ ...current, frameSelected: id, selection: undefined }));
}

/** The selected elements that are still in their frame's document. */
export function selectedElements(): { readonly frame: FrameId; readonly document: Document; readonly elements: readonly Element[] } | undefined {
  const selection = state.selection;
  if (selection === undefined) {
    return undefined;
  }
  const document = frames.get(selection.frame)?.document;
  if (document === undefined) {
    return undefined;
  }
  const elements = selection.ids.map((id) => elementByDesignId(document, id)).filter((element): element is Element => element !== undefined);
  return { frame: selection.frame, document, elements };
}

export function setTool(tool: DesignTool): void {
  setState((current) => ({ ...current, tool }));
}

export function setView(view: DesignView): void {
  const scale = Math.min(DESIGN_LIMITS.zoomMax, Math.max(DESIGN_LIMITS.zoomMin, view.scale));
  setState((current) => ({ ...current, view: { xPx: view.xPx, yPx: view.yPx, scale } }));
}

export function setPeek(id: FrameId | undefined): void {
  setState((current) => ({ ...current, peek: id }));
}

export function setEditingText(editing: DesignState['editingText']): void {
  setState((current) => ({ ...current, editingText: editing }));
}

// ---------------------------------------------------------------------------
// Gestures and history
// ---------------------------------------------------------------------------

function selectionIds(elements: readonly Element[]): readonly DesignElementId[] {
  return elements.map((element) => designIdOf(element)).filter((id): id is DesignElementId => id !== undefined);
}

/**
 * One gesture on a frame, as one undo step: `change` edits the frame's document (and only it) and answers the
 * elements to select afterwards (undefined keeps the selection). Answers false when the frame is not loaded.
 */
export function commitFrame(id: FrameId, change: (document: Document, mint: ElementIdMint) => readonly Element[] | undefined): boolean {
  const runtime = frames.get(id);
  const document = runtime?.document;
  const mint = runtime?.mint;
  if (runtime === undefined || document === undefined || mint === undefined) {
    return false;
  }
  const before = live?.frame === id ? live.before : bodyStateOf(document);
  const selectionBefore = live?.frame === id ? live.selection : state.selection;
  live = undefined;
  const picked = change(document, mint);
  const selectionAfter = picked === undefined ? state.selection : picked.length === 0 ? undefined : { frame: id, ids: selectionIds(picked) };
  history.push({ kind: 'frame', frame: id, before, after: bodyStateOf(document), selectionBefore, selectionAfter });
  setState((current) => ({
    ...current,
    selection: selectionAfter,
    revision: current.revision + 1,
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
  }));
  scheduleSave();
  return true;
}

/** Starts a gesture that changes the document as the pointer moves (a drag, a scrub): its end is one undo step. */
export function beginLive(id: FrameId): boolean {
  const document = frames.get(id)?.document;
  if (document === undefined) {
    return false;
  }
  live = { frame: id, before: bodyStateOf(document), selection: state.selection };
  return true;
}

/** Puts the frame back as it was when the live gesture began. */
export function cancelLive(): void {
  const current = live;
  live = undefined;
  const document = current === undefined ? undefined : frames.get(current.frame)?.document;
  if (current !== undefined && document !== undefined) {
    restoreBodyState(document, current.before);
    bump();
  }
}

export function isLive(): boolean {
  return live !== undefined;
}

export function undo(): void {
  const entry = history.undo();
  if (entry !== undefined) {
    applyHistory(entry, 'before');
  }
}

export function redo(): void {
  const entry = history.redo();
  if (entry !== undefined) {
    applyHistory(entry, 'after');
  }
}

function applyHistory(entry: ReturnType<DesignHistory['undo']> & object, side: 'before' | 'after'): void {
  live = undefined;
  if (entry.kind === 'frame') {
    const document = frames.get(entry.frame)?.document;
    if (document !== undefined) {
      restoreBodyState(document, side === 'before' ? entry.before : entry.after);
    }
    const selection = side === 'before' ? entry.selectionBefore : entry.selectionAfter;
    setState((current) => ({
      ...current,
      selection,
      editingText: undefined,
      revision: current.revision + 1,
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
    }));
  } else {
    const records = side === 'before' ? entry.before : entry.after;
    const kept = new Set(records.map((record) => record.id));
    for (const record of records) {
      const runtime = frames.get(record.id);
      if (runtime === undefined) {
        const html = entry.documents.get(record.id);
        const baseline = [...baselines.keys()][0];
        if (html !== undefined && baseline !== undefined) {
          frames.set(record.id, { record, baseline: removedBaselines.get(record.id) ?? baseline, initialHTML: html, document: undefined, mint: undefined });
        }
      } else {
        runtime.record = record;
      }
    }
    for (const id of [...frames.keys()]) {
      if (!kept.has(id)) {
        const html = serializeFrame(id);
        const runtime = frames.get(id);
        if (html !== undefined && runtime !== undefined) {
          removedBaselines.set(id, runtime.baseline);
        }
        frames.delete(id);
      }
    }
    setState((current) => ({
      ...current,
      frames: records.filter((record) => frames.has(record.id)),
      selection: current.selection !== undefined && kept.has(current.selection.frame) ? current.selection : undefined,
      frameSelected: current.frameSelected !== undefined && kept.has(current.frameSelected) ? current.frameSelected : undefined,
      revision: current.revision + 1,
      canUndo: history.canUndo(),
      canRedo: history.canRedo(),
    }));
  }
  scheduleSave();
}

/** The baseline a removed frame belonged to, so bringing it back by undo reads its changes against the right copy. */
const removedBaselines = new Map<FrameId, string>();

function pushFrames(after: readonly DesignFrameRecord[], documents: ReadonlyMap<FrameId, string>): void {
  const before = state.frames;
  history.push({ kind: 'frames', before, after, documents });
  for (const record of after) {
    const runtime = frames.get(record.id);
    if (runtime !== undefined) {
      runtime.record = record;
    }
  }
  setState((current) => ({ ...current, frames: after, canUndo: history.canUndo(), canRedo: history.canRedo(), revision: current.revision + 1 }));
  scheduleSave();
}

/** A copy of a frame, as it is now, beside the last frame. */
export function duplicateFrame(id: FrameId): FrameId | undefined {
  const source = frames.get(id);
  const html = serializeFrame(id);
  if (source === undefined || html === undefined || state.frames.length >= DESIGN_LIMITS.framesMax) {
    return undefined;
  }
  const record = newRecord(copyName(source.record.name), source.record.widthPx, source.record.viewportHeightPx, nextX());
  frames.set(record.id, { record, baseline: source.baseline, initialHTML: html, document: undefined, mint: undefined });
  pushFrames([...state.frames, record], new Map([[record.id, html]]));
  return record.id;
}

function copyName(name: string): string {
  const numbered = /^(.*?)\s+(\d+)$/.exec(name);
  const stem = numbered?.[1] ?? name;
  const taken = new Set(state.frames.map((frame) => frame.name));
  for (let count = numbered === null ? 2 : Number(numbered[2]) + 1; count < 10_000; count += 1) {
    const candidate = `${stem} ${String(count)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  return stem;
}

export function deleteFrame(id: FrameId): void {
  if (state.frames.length <= 1) {
    return; // The last frame stays: Design mode always shows the page.
  }
  const html = serializeFrame(id);
  const runtime = frames.get(id);
  if (html === undefined || runtime === undefined) {
    return;
  }
  removedBaselines.set(id, runtime.baseline);
  const after = state.frames.filter((frame) => frame.id !== id);
  history.push({ kind: 'frames', before: state.frames, after, documents: new Map([[id, html]]) });
  frames.delete(id);
  setState((current) => ({
    ...current,
    frames: after,
    selection: current.selection?.frame === id ? undefined : current.selection,
    frameSelected: undefined,
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    revision: current.revision + 1,
  }));
  scheduleSave();
}

/** What a frame action changes about a frame; an absent field stays as it is. */
export interface FrameChange {
  readonly name?: string;
  readonly widthPx?: number;
  readonly xPx?: number;
  readonly yPx?: number;
}

export function updateFrame(id: FrameId, change: FrameChange): void {
  const after = state.frames.map((frame) =>
    frame.id === id
      ? {
          ...frame,
          name: (change.name ?? frame.name).slice(0, DESIGN_LIMITS.frameNameCharsMax) || frame.name,
          widthPx: change.widthPx === undefined ? frame.widthPx : clampWidth(change.widthPx),
          xPx: change.xPx ?? frame.xPx,
          yPx: change.yPx ?? frame.yPx,
        }
      : frame,
  );
  pushFrames(after, new Map());
}

/** Lays the frames out side by side again, in the given order, keeping their widths. */
export function arrangeFrames(order: readonly FrameId[]): void {
  let x = 0;
  const after: DesignFrameRecord[] = [];
  for (const id of order) {
    const frame = state.frames.find((candidate) => candidate.id === id);
    if (frame !== undefined) {
      after.push({ ...frame, xPx: x, yPx: 0 });
      x += frame.widthPx + DESIGN_LIMITS.frameGapPx;
    }
  }
  if (after.length === state.frames.length) {
    pushFrames(after, new Map());
  }
}

/** Puts a frame back to the page as it was copied (one undo step). */
export function resetFrame(id: FrameId): boolean {
  const baseline = frameBaseline(id);
  if (baseline === undefined) {
    return false;
  }
  const original = baseline.document.body;
  if (original === null) {
    return false;
  }
  return commitFrame(id, (document) => {
    restoreBodyState(document, {
      attributes: original.getAttributeNames().map((name) => [name, original.getAttribute(name) ?? ''] as const),
      inner: original.innerHTML,
    });
    return [];
  });
}

/** The instance a key names in a frame's baseline, or one a gesture inserted. */
export function instanceInfo(frame: FrameId, key: string): DesignInstanceInfo | undefined {
  return frameBaseline(frame)?.instances.get(key);
}

/** Records an instance a gesture inserted, so the props panel can render it with props. */
export function addInstance(frame: FrameId, key: string, info: DesignInstanceInfo): void {
  frameBaseline(frame)?.instances.set(key, info);
}

// ---------------------------------------------------------------------------
// Drafts: the app's own storage, outside the project
// ---------------------------------------------------------------------------

const SAVE_DELAY_MS = 1_200;

function scheduleSave(): void {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void saveNow();
  }, SAVE_DELAY_MS);
}

async function saveNow(): Promise<void> {
  if (saveTimer !== undefined) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  const page = state.page;
  if (page === undefined || state.phase !== 'on') {
    return;
  }
  const used = new Set([...frames.values()].map((runtime) => runtime.baseline));
  const draft: DesignDraft = {
    savedAtMs: Date.now(),
    baselines: [...baselines.values()]
      .filter((baseline) => used.has(baseline.id))
      .map((baseline) => ({ id: baseline.id, html: baseline.html, url: baseline.url, instances: [...baseline.instances], sources: [...baseline.sources] })),
    frames: state.frames.flatMap((record) => {
      const runtime = frames.get(record.id);
      const html = serializeFrame(record.id);
      return runtime === undefined || html === undefined ? [] : [{ record, baseline: runtime.baseline, html }];
    }),
  };
  await saveDraft(page, draft);
}
