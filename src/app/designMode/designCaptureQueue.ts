// Design mode (experimental, removable: docs/design-mode/REMOVE.md): keeping the shown frame's picture current.
//
// The shown frame is the one the site's copy holds, so whatever the live canvas draws is that frame: after each
// change it is snapshotted again. Every other frame keeps the snapshot it had when it was last shown. Captures run
// one at a time, wait for the changes to rest, and slow down for a page that never does; a snapshot that arrives
// after the shown frame changed is dropped.
import { DESIGN_SNAPSHOT_LIMITS, type DesignSnapshot } from '../../../shared/ipc/designSnapshot';
import type { DesignFrameId } from '../../../shared/ipc/designSession';
import { designSession } from './designBridge';
import { requestSnapshot, type SnapshotResult } from './designLiveCanvas';
import { designView, updateDesignView } from './designStore';

/** Changes closer together than this are one change. */
const QUIET_MS = 120;
/** A page that keeps changing is pictured no more often than this, after BUSY_RUN captures in a row. */
const BUSY_INTERVAL_MS = 2_000;
const BUSY_RUN = 12;
const BUSY_GAP_MS = 1_000;
/** A frame's snapshot is written to its file once it has rested this long. */
const KEEP_QUIET_MS = 500;
const FLUSH_POLLS_MAX = 100;
const FLUSH_POLL_MS = 20;

let timer: number | undefined;
let running: Promise<void> | undefined;
let wanted = false;
let runLength = 0;
let lastCaptureMs = 0;
let lastChangeMs = 0;
const unkept = new Map<DesignFrameId, DesignSnapshot>();
let keepTimer: number | undefined;
let onRefused: ((failure: Extract<SnapshotResult, { ok: false }>['failure']) => void) | undefined;

/** Who is told when the page cannot be pictured at all. */
export function reportCaptureRefusals(listener: typeof onRefused): void {
  onRefused = listener;
}

/** The live canvas may show something new. */
export function noteCanvasChange(): void {
  lastChangeMs = performance.now();
  wanted = true;
  arm();
}

function arm(): void {
  window.clearTimeout(timer);
  const now = performance.now();
  if (now - lastCaptureMs > BUSY_GAP_MS) {
    runLength = 0;
  }
  const wait = runLength >= BUSY_RUN ? Math.max(QUIET_MS, lastCaptureMs + BUSY_INTERVAL_MS - now) : QUIET_MS;
  timer = window.setTimeout(() => void capture(), wait);
}

function capture(): Promise<void> {
  if (running !== undefined) {
    return running;
  }
  const view = designView();
  // While the copy is being rewritten the canvas shows neither frame.
  if (view.session.kind !== 'on' || view.switching !== undefined || view.phase === 'leaving') {
    return Promise.resolve();
  }
  const frame = view.session.active;
  wanted = false;
  running = (async () => {
    const result = await requestSnapshot();
    lastCaptureMs = performance.now();
    runLength += 1;
    if (result.ok) {
      store(frame, result.snapshot);
    } else {
      onRefused?.(result.failure);
    }
  })().finally(() => {
    running = undefined;
    if (wanted) {
      arm();
    }
  });
  return running;
}

/** Every distinct document the frames hold, in characters: duplicates share one string. */
export function snapshotCharsHeld(snapshots: ReadonlyMap<DesignFrameId, DesignSnapshot>): number {
  const distinct = new Set([...snapshots.values()].map((snapshot) => snapshot.html));
  return [...distinct].reduce((total, html) => total + html.length, 0);
}

function store(frame: DesignFrameId, snapshot: DesignSnapshot): void {
  const view = designView();
  const session = view.session;
  if (session.kind !== 'on' || session.active !== frame || view.switching !== undefined) {
    return;
  }
  const held = view.snapshots.get(frame);
  if (held !== undefined && held.html === snapshot.html && held.viewportWidthPx === snapshot.viewportWidthPx) {
    return;
  }
  const snapshots = new Map(view.snapshots).set(frame, snapshot);
  // Past the budget the frame keeps its older, smaller picture.
  if (snapshotCharsHeld(snapshots) > DESIGN_SNAPSHOT_LIMITS.totalCharsMax) {
    onRefused?.('too-large');
    return;
  }
  updateDesignView((current) => ({ ...current, snapshots }));
  unkept.set(frame, snapshot);
  window.clearTimeout(keepTimer);
  keepTimer = window.setTimeout(() => void keepSnapshots(), KEEP_QUIET_MS);
}

async function keepSnapshots(): Promise<void> {
  window.clearTimeout(keepTimer);
  const pending = [...unkept];
  unkept.clear();
  for (const [frame, snapshot] of pending) {
    await designSession({ op: 'frame-snapshot', frame, snapshot });
  }
}

/**
 * Before the shown frame is left: waits for a change under way to rest, pictures it, and writes what is pending.
 * `recentMs`: how long after the last change the canvas may still be drawing it.
 */
export async function flushCaptures(recentMs: number): Promise<void> {
  for (let poll = 0; poll < FLUSH_POLLS_MAX; poll += 1) {
    const resting = performance.now() - lastChangeMs >= recentMs;
    if (resting && running === undefined) {
      if (!wanted) {
        break;
      }
      window.clearTimeout(timer);
      await capture();
      break;
    }
    await new Promise((resolve) => window.setTimeout(resolve, FLUSH_POLL_MS));
  }
  window.clearTimeout(timer);
  wanted = false;
  await running;
  await keepSnapshots();
}

/** Forgets a removed frame's pending write. */
export function dropCapture(frame: DesignFrameId): void {
  unkept.delete(frame);
}
