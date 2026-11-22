// `ai:record`: a short screen recording of one region of the sender's window, for the composer's
// "Pick frames" sheet (docs/contracts.md, "Screenshots"). Frames are `capturePage` photographs taken at a
// rate chosen from what a capture of this region measurably costs (fpsForCost), scaled to the screenshot edge, JPEG-encoded, and kept in this process's memory only:
// never on disk, never in a temporary file, never logged, never persisted. The renderer receives small
// thumbnails when the recording stops and asks for a full frame only when it shows or sends one, so the
// full frames exist once, here, until the recording is discarded.
//
// The bounds are tight on purpose (the machines this runs on are often short of memory): a recording stops
// by itself at RECORDING_LIMITS.durationMsMax of capture time, framesMax frames or bytesMax bytes, whichever
// comes first, and the reason is reported. It is not a ring: the earliest frames are kept and capture stops,
// because the person started recording at the moment they wanted. One recording exists at a time; starting
// another, discarding, the window closing, or a stopped recording left alone for stoppedKeepMs frees it.
//
// Timing: the first frame is taken at once on start, and Stop waits for a capture under way and then takes one
// last frame (unless the previous one is under half an interval old), so the end of what the person saw is in
// the recording. Frames are never deduplicated: an unchanged frame is still a frame, and the sheet chooses.
import { randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import {
  RECORDING_DURATION_MS_MAX,
  RECORDING_FRAMES_MAX,
  type AiFailure,
  type RecordAction,
  type RecordReply,
  type RecordStopReason,
  type ScreenshotRect,
} from '../../../shared/ipc/aiChat';
import { described } from './aiMessages';
import { scaledToEdge, type ScreenshotImage } from './screenshotCapture';

export const RECORDING_LIMITS = {
  /** Capture time (paused time does not count) after which a recording stops by itself. */
  durationMsMax: RECORDING_DURATION_MS_MAX,
  framesMax: RECORDING_FRAMES_MAX,
  /** Full frames and thumbnails together, as encoded bytes. */
  bytesMax: 40 * 1024 * 1024,
  /** Frames per second: the rate before anything is measured, and the ceiling and floor of the chosen rate. */
  fpsStart: 10,
  fpsMax: 15,
  fpsMin: 2,
  /** Frames between two choices of the rate, each from the mean cost of the last this many frames. */
  fpsWindowFrames: 10,
  /** How much of each interval a capture may use: the rest is headroom for the window's own work. */
  costHeadroom: 1.5,
  /** The thumbnail's longer side: sharp enough to stand in for the full frame in the sheet's preview while it loads. */
  thumbEdgePx: 640,
  /** JPEG qualities of a full frame and of a thumbnail. */
  frameQuality: 70,
  thumbQuality: 80,
  /** How often a paused (hidden) recording looks again. */
  pausedPollMs: 250,
  /** A stopped recording nobody discards is freed after this. */
  stoppedKeepMs: 10 * 60_000,
} as const;

export interface EncodedFrame {
  /** Capture time since the recording began, in milliseconds. */
  readonly atMs: number;
  readonly width: number;
  readonly height: number;
  readonly frame: Buffer;
  readonly thumb: Buffer;
}

/** Why a frame was not kept: the buffer is at one of its bounds. */
export type FrameRefusal = 'frames' | 'bytes';

/** The recording's frames, in capture order, within the frame and byte bounds. */
export class FrameBuffer {
  private readonly frames: EncodedFrame[] = [];
  private bytes = 0;

  constructor(private readonly bounds: { readonly framesMax: number; readonly bytesMax: number } = RECORDING_LIMITS) {
    assert(bounds.framesMax >= 1, 'FrameBuffer: holds at least a frame');
    assert(bounds.bytesMax >= 1, 'FrameBuffer: holds at least a byte');
  }

  /** Keeps the frame, or says which bound refuses it; a refused frame is not kept and the buffer is unchanged. */
  push(frame: EncodedFrame): FrameRefusal | undefined {
    const last = this.frames.at(-1);
    assert(last === undefined || frame.atMs >= last.atMs, 'FrameBuffer: frames arrive in time order');
    if (this.frames.length >= this.bounds.framesMax) {
      return 'frames';
    }
    const size = frame.frame.length + frame.thumb.length;
    if (this.bytes + size > this.bounds.bytesMax) {
      return 'bytes';
    }
    this.frames.push(frame);
    this.bytes += size;
    assert(this.bytes <= this.bounds.bytesMax, 'FrameBuffer: within the byte bound');
    return undefined;
  }

  get count(): number {
    return this.frames.length;
  }

  get byteCount(): number {
    return this.bytes;
  }

  at(index: number): EncodedFrame | undefined {
    return this.frames[index];
  }

  list(): readonly EncodedFrame[] {
    return this.frames;
  }

  /** Drops every frame, so the memory can be reclaimed. */
  clear(): void {
    this.frames.length = 0;
    this.bytes = 0;
  }
}

/**
 * The rate a capture costing `costMs` (photograph and encode, per frame) affords: a frame every `costMs` times
 * costHeadroom, so capturing never takes the main process's whole time, within fpsMin..fpsMax. A small region
 * costs a few milliseconds and gets the ceiling; a large one on a busy machine comes down towards five.
 */
export function fpsForCost(costMs: number): number {
  assert(Number.isFinite(costMs), 'fpsForCost: a measured cost');
  assert(costMs >= 0, 'fpsForCost: a cost is not negative');
  if (costMs === 0) {
    return RECORDING_LIMITS.fpsMax;
  }
  const affordable = Math.floor(1000 / (costMs * RECORDING_LIMITS.costHeadroom));
  return Math.min(RECORDING_LIMITS.fpsMax, Math.max(RECORDING_LIMITS.fpsMin, affordable));
}

/** What the recorder needs of the world, so a test drives it without Electron or real time. */
export interface RecorderDeps {
  readonly capture: (rect: ScreenshotRect) => Promise<ScreenshotImage>;
  /** Whether the window is on screen: a hidden or minimised window pauses capture. */
  readonly visible: () => boolean;
  readonly now: () => number;
  /** Runs `run` once after `delayMs`; the answer cancels it. */
  readonly setTimer: (run: () => void, delayMs: number) => Timer;
}

export interface Timer {
  readonly cancel: () => void;
}

type RecorderState =
  { readonly kind: 'recording'; readonly paused: boolean } | { readonly kind: 'stopped'; readonly reason: RecordStopReason } | { readonly kind: 'discarded' };

/** One recording: its capture loop while it runs, its frames once it stopped. */
export class Recording {
  readonly id = `r${randomBytes(8).toString('hex')}`;
  private readonly buffer = new FrameBuffer();
  private state: RecorderState = { kind: 'recording', paused: false };
  private fps: number = RECORDING_LIMITS.fpsStart;
  /** Capture time so far, not counting pauses. */
  private elapsedMs = 0;
  /** When the loop last counted time; undefined before the first frame, so the first frame is at 0 ms. */
  private lastTickAt: number | undefined;
  private timer: Timer | undefined;
  /** The capture step under way, so Stop can wait for its frame. */
  private running: Promise<void> | undefined;
  /** Stop has begun: the loop takes no further step. */
  private stopping = false;
  /** Costs of the frames since the rate was last chosen, in milliseconds; at most fpsWindowFrames. */
  private costs: number[] = [];

  constructor(
    private readonly rect: ScreenshotRect,
    private readonly deps: RecorderDeps,
    private readonly onFinished: (recording: Recording) => void,
  ) {
    this.schedule(0);
  }

  status(): RecordReply {
    const base = {
      kind: 'status' as const,
      elapsedMs: Math.min(this.elapsedMs, RECORDING_LIMITS.durationMsMax),
      frames: this.buffer.count,
      bytes: this.buffer.byteCount,
    };
    switch (this.state.kind) {
      case 'recording':
        return { ...base, state: this.state.paused ? 'paused' : 'recording', stopReason: undefined };
      case 'stopped':
        return { ...base, state: 'stopped', stopReason: this.state.reason };
      case 'discarded':
        return { ...base, state: 'stopped', stopReason: 'discarded' };
      default: {
        const exhaustive: never = this.state;
        return exhaustive;
      }
    }
  }

  /** Stops capture (when still running): waits for a capture under way, takes the last frame, and answers the thumbnails. */
  async stop(): Promise<RecordReply> {
    if (this.isRecording() && !this.stopping) {
      this.stopping = true;
      this.timer?.cancel();
      this.timer = undefined;
      await this.running;
      if (this.isRecording()) {
        await this.lastFrame();
      }
      if (this.isRecording()) {
        this.finish('person');
      }
    }
    const reason = this.state.kind === 'stopped' ? this.state.reason : 'discarded';
    const frames = this.buffer.list().map((frame, index) => ({
      index,
      atMs: frame.atMs,
      width: frame.width,
      height: frame.height,
      thumb: frame.thumb.toString('base64'),
    }));
    assert(frames.length <= RECORDING_LIMITS.framesMax, 'stop: within the frame bound');
    return { kind: 'stopped', frames, fps: this.measuredFps(), stopReason: reason };
  }

  /** One full frame, base64; undefined past the end or once discarded. */
  frame(index: number): RecordReply | undefined {
    const frame = this.buffer.at(index);
    if (frame === undefined) {
      return undefined;
    }
    return { kind: 'frame', image: { mimeType: 'image/jpeg', data: frame.frame.toString('base64'), width: frame.width, height: frame.height } };
  }

  /** Frees every frame and ends the loop; the recording answers nothing afterwards. */
  discard(): void {
    this.timer?.cancel();
    this.timer = undefined;
    this.buffer.clear();
    this.state = { kind: 'discarded' };
  }

  get discarded(): boolean {
    return this.state.kind === 'discarded';
  }

  get stopped(): boolean {
    return this.state.kind !== 'recording';
  }

  /** The rate the loop uses now, for tests and the debug summary. */
  get currentFps(): number {
    return this.fps;
  }

  // A method, not a narrowed field read: the state changes across the awaits in Stop.
  private isRecording(): boolean {
    return this.state.kind === 'recording';
  }

  // The frame at the moment Stop was pressed, unless the last one is under half an interval old.
  private async lastFrame(): Promise<void> {
    if (this.state.kind !== 'recording' || this.state.paused || !this.deps.visible()) {
      return;
    }
    const now = this.deps.now();
    this.elapsedMs += now - (this.lastTickAt ?? now);
    this.lastTickAt = now;
    const last = this.buffer.list().at(-1);
    const fresh = last !== undefined && this.elapsedMs - last.atMs < Math.floor(500 / this.fps);
    if (fresh || this.elapsedMs >= RECORDING_LIMITS.durationMsMax) {
      return;
    }
    const encoded = await this.captureFrame(this.elapsedMs);
    if (encoded !== undefined && this.isRecording()) {
      // At a bound the last frame is simply not kept; the recording still ends as the person stopped it.
      this.buffer.push(encoded);
    }
  }

  private async captureFrame(atMs: number): Promise<EncodedFrame | undefined> {
    try {
      return encodeFrame(await this.deps.capture(this.rect), atMs);
    } catch {
      // A failed capture (the window closing) is undefined; the reason is not logged.
      return undefined;
    }
  }

  // After each kept frame: the first measured frame sets the rate, then every fpsWindowFrames frames the mean
  // cost of the window does; a single frame that overran its interval re-chooses at once, so a busy machine is
  // never left queueing captures.
  private chooseRate(costMs: number): void {
    this.costs.push(costMs);
    const overran = costMs > Math.floor(1000 / this.fps);
    if (this.buffer.count === 1 || overran || this.costs.length >= RECORDING_LIMITS.fpsWindowFrames) {
      const mean = this.costs.reduce((sum, cost) => sum + cost, 0) / this.costs.length;
      this.fps = fpsForCost(overran ? costMs : mean);
      this.costs = [];
    }
    assert(this.costs.length < RECORDING_LIMITS.fpsWindowFrames, 'chooseRate: the cost window is bounded');
  }

  // Frames per second between the first and the last frame kept, to one decimal; the rate in use before two frames exist.
  private measuredFps(): number {
    const frames = this.buffer.list();
    const first = frames[0];
    const last = frames.at(-1);
    if (first === undefined || last === undefined || last.atMs <= first.atMs) {
      return this.fps;
    }
    return Math.round(((frames.length - 1) * 10_000) / (last.atMs - first.atMs)) / 10;
  }

  private schedule(delayMs: number): void {
    this.timer = this.deps.setTimer(
      () => {
        this.running = this.tick();
      },
      Math.max(0, delayMs),
    );
  }

  private finish(reason: RecordStopReason): void {
    assert(this.state.kind === 'recording', 'finish: only a running recording stops');
    this.timer?.cancel();
    this.timer = undefined;
    this.state = { kind: 'stopped', reason };
    this.onFinished(this);
  }

  // One step of the loop: count the time since the last step (unless paused), stop at the duration bound,
  // capture one frame, keep it or stop at the buffer's bound, adapt the rate and wait for the next frame.
  private async tick(): Promise<void> {
    if (this.state.kind !== 'recording' || this.stopping) {
      return;
    }
    const now = this.deps.now();
    if (!this.deps.visible()) {
      this.state = { kind: 'recording', paused: true };
      this.lastTickAt = now;
      this.schedule(RECORDING_LIMITS.pausedPollMs);
      return;
    }
    if (!this.state.paused && this.lastTickAt !== undefined) {
      this.elapsedMs += now - this.lastTickAt;
    }
    this.state = { kind: 'recording', paused: false };
    this.lastTickAt = now;
    if (this.elapsedMs >= RECORDING_LIMITS.durationMsMax) {
      this.finish('duration');
      return;
    }
    const encoded = await this.captureFrame(this.elapsedMs);
    // The recording may have been discarded while the capture ran.
    if (!this.isRecording()) {
      return;
    }
    // A failed capture ends the recording; the frames so far are kept.
    if (encoded === undefined) {
      this.finish('failed');
      return;
    }
    const refused = this.buffer.push(encoded);
    if (refused !== undefined) {
      this.finish(refused);
      return;
    }
    const captureMs = this.deps.now() - now;
    this.chooseRate(captureMs);
    // Stop pressed while this frame was taken: Stop takes it from here.
    if (this.stopping) {
      return;
    }
    this.schedule(Math.floor(1000 / this.fps) - captureMs);
  }
}

/** A captured image as a full JPEG frame within the screenshot edge, and a small JPEG thumbnail. */
export function encodeFrame(image: ScreenshotImage, atMs: number): EncodedFrame | undefined {
  if (image.isEmpty()) {
    return undefined;
  }
  const full = scaledToEdge(image);
  const size = full.getSize();
  const thumb = scaledToEdge(full, RECORDING_LIMITS.thumbEdgePx);
  return {
    atMs,
    width: size.width,
    height: size.height,
    frame: full.toJPEG(RECORDING_LIMITS.frameQuality),
    thumb: thumb.toJPEG(RECORDING_LIMITS.thumbQuality),
  };
}

/** The one recording of the app: `ai:record`'s actions against it. */
export class ScreenRecorder {
  private current: Recording | undefined;
  private expiry: Timer | undefined;

  constructor(private readonly deps: Pick<RecorderDeps, 'now' | 'setTimer'>) {}

  async act(action: RecordAction, sender: Pick<RecorderDeps, 'capture' | 'visible'>): Promise<Result<RecordReply, AiFailure>> {
    if (action.kind === 'start') {
      this.release();
      this.current = new Recording(action.rect, { ...this.deps, ...sender }, () => this.expireLater());
      return ok({ kind: 'started', id: this.current.id });
    }
    const recording = this.current;
    if (recording === undefined || recording.id !== action.id || recording.discarded) {
      return err({ code: 'invalid', ...described('ai.record.gone') });
    }
    // Any use of a stopped recording (the sheet scrubbing, fetching, keeping alive) restarts its lifetime, so it is
    // freed only after stoppedKeepMs with nobody looking at it.
    if (recording.stopped && action.kind !== 'discard') {
      this.expireLater();
    }
    switch (action.kind) {
      case 'status':
        return ok(recording.status());
      case 'stop':
        return ok(await recording.stop());
      case 'frame': {
        const frame = recording.frame(action.index);
        return frame === undefined ? err({ code: 'invalid', ...described('ai.record.gone') }) : ok(frame);
      }
      case 'discard':
        this.release();
        return ok({ kind: 'discarded' });
      default: {
        const exhaustive: never = action;
        return exhaustive;
      }
    }
  }

  /** Frees the recording (the window closed, the app quits). */
  release(): void {
    this.expiry?.cancel();
    this.expiry = undefined;
    this.current?.discard();
    this.current = undefined;
  }

  private expireLater(): void {
    this.expiry?.cancel();
    this.expiry = this.deps.setTimer(() => this.release(), RECORDING_LIMITS.stoppedKeepMs);
  }
}
