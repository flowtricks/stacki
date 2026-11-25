// Canvas click capture (docs/apps.md, "Canvas clicks"): while an app captures
// the canvas, a click there goes to the app as `canvas.click` instead of
// selecting, so a comment pin or an annotation is placed the way every design
// tool places one: click the thing, then type.
//
// One app captures at a time, by the rules overrides follow: the most recent
// `canvas.capture({ on: true })` wins (the app it displaces hears
// `canvas.capture` with `on: false, reason: 'replaced'`), Escape cancels
// (`reason: 'escape'`), and an app that stops
// running releases it. Pure state over two callbacks, so tests drive it without
// frames; the runtime (appsRuntime.ts) owns the one instance.
import { assert } from '../../../shared/core/assert';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import {
  APP_RPC_LIMITS,
  type AppCanvasClick,
  type AppCanvasCursor,
  type AppCaptureMode,
  type AppEditOutcome,
  type AppEventData,
  type AppEventName,
  type AppNodeLayer,
  type AppPoint,
} from '../../../shared/properties/appsRpc';
import type { CanvasClickBox } from '../../ui/canvasClickSlot';

/** The app that captures the canvas now. */
export interface CanvasCaptureOwner {
  readonly appId: string;
  /** Shown in the capture chip, so the person knows whose click this is. */
  readonly appName: string;
  readonly cursor: AppCanvasCursor;
  /** `capture` takes clicks from the editor; `observe` lets the editor have them and the app hear them too. */
  readonly mode: AppCaptureMode;
  /** What the chip says the clicks are for (`reason`); undefined for the mode's own words. */
  readonly reason: string | undefined;
}

export interface CanvasCaptureDeps {
  /** Sends one app's frames an event; returns how many frames it reached. */
  readonly emit: <E extends AppEventName>(appId: string, event: E, data: AppEventData[E]) => number;
  readonly running: (appId: string) => boolean;
}

export interface CanvasCapture {
  /** `canvas.capture`: starts or ends the calling app's capture. */
  readonly set: (
    app: { readonly id: string; readonly name: string },
    on: boolean,
    capture: { readonly cursor: AppCanvasCursor; readonly mode: AppCaptureMode; readonly reason: string | undefined },
  ) => AppEditOutcome;
  readonly owner: () => CanvasCaptureOwner | undefined;
  /** Escape: ends the capture, telling its app. False when nothing was captured. */
  readonly cancel: () => boolean;
  /** Sends a click to the owner; false when nothing captures. */
  readonly click: (click: AppCanvasClick) => boolean;
  /** The running apps changed: an owner that stopped loses the capture, silently (its frames are gone). */
  readonly changed: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createCanvasCapture(deps: CanvasCaptureDeps): CanvasCapture {
  let owner: CanvasCaptureOwner | undefined;
  const listeners = new Set<() => void>();
  const publish = (next: CanvasCaptureOwner | undefined): void => {
    owner = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    set: (app, on, { cursor, mode, reason }) => {
      if (on) {
        if (!deps.running(app.id)) {
          return { applied: false, reason: 'Only a running app captures the canvas' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
        }
        const previous = owner;
        publish({ appId: app.id, appName: app.name, cursor, mode, reason });
        if (previous !== undefined && previous.appId !== app.id) {
          deps.emit(previous.appId, 'canvas.capture', { on: false, reason: 'replaced' });
        }
        // The app's own frames hear it too, so a panel and its popup agree on whether it captures.
        deps.emit(app.id, 'canvas.capture', { on: true, reason: 'app' });
        assert(owner?.appId === app.id, 'The latest capture owns the canvas');
        return { applied: true };
      }
      if (owner?.appId === app.id) {
        publish(undefined);
        // An app that ends its own capture hears it as any end, told apart from Escape by the reason.
        deps.emit(app.id, 'canvas.capture', { on: false, reason: 'app' });
      }
      assert(owner?.appId !== app.id, 'An app that ends its capture no longer owns the canvas');
      return { applied: true };
    },
    owner: () => owner,
    cancel: () => {
      const previous = owner;
      if (previous === undefined) {
        return false;
      }
      publish(undefined);
      deps.emit(previous.appId, 'canvas.capture', { on: false, reason: 'escape' });
      return true;
    },
    click: (click) => {
      if (owner === undefined) {
        return false;
      }
      deps.emit(owner.appId, 'canvas.click', click);
      return true;
    },
    changed: () => {
      if (owner !== undefined && !deps.running(owner.appId)) {
        publish(undefined);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The capture chip's text: the app's name, then its reason or the mode's own words; a capture offers Escape. */
export function captureChipText(owner: Pick<CanvasCaptureOwner, 'appName' | 'mode' | 'reason'>, translate: Translator): string {
  if (owner.mode === 'observe') {
    // An observing app leaves Escape to the editor (leaving a component), so its chip does not offer it.
    return owner.reason === undefined
      ? translate('apps.capture.listening', { name: owner.appName })
      : translate('apps.capture.reason', { name: owner.appName, reason: owner.reason });
  }
  return translate('apps.capture.cancelable', { name: owner.appName, reason: owner.reason ?? translate('apps.capture.clickToPlace') });
}

/**
 * What a captured click tells the app: the element (when the click landed on
 * one the open file owns), the point within its box (0–1 each way), the point
 * in the canvas viewport, and every file's element under it (nodeRefs.ts). A
 * box the frame could not measure, or one with no area, has no point within it.
 */
export function canvasClickPayload(input: {
  readonly nodeId: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly box: CanvasClickBox | undefined;
  readonly layers: readonly AppNodeLayer[];
}): AppCanvasClick {
  const at = input.nodeId === undefined || input.box === undefined ? undefined : pointWithin(input.box, input.x, input.y);
  const payload: AppCanvasClick = { nodeId: input.nodeId, at, x: input.x, y: input.y, layers: input.layers.slice(0, APP_RPC_LIMITS.nodeLayersMax) };
  assert(payload.at === undefined || payload.nodeId !== undefined, 'A point within an element names the element');
  assert(payload.layers.length <= APP_RPC_LIMITS.nodeLayersMax, 'A click names a bounded number of layers');
  return payload;
}

// The click within the box, clamped: a click on a border or a sub-pixel outside still belongs to the element.
function pointWithin(box: CanvasClickBox, x: number, y: number): AppPoint | undefined {
  if (box.w > 0 && box.h > 0) {
    const point = { x: clampUnit((x - box.x) / box.w), y: clampUnit((y - box.y) / box.h) };
    assert(point.x >= 0, 'A point starts at the left edge');
    assert(point.y <= 1, 'A point ends at the bottom edge');
    return point;
  }
  return undefined;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}
