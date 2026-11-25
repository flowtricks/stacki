// `node.measure`: an element's boxes on the canvas, for an app that does its own
// geometry. The canvas measures only the paths it tracks, so this reads the
// overlay layer's latest measurement (AppOverlayLayer.tsx notes each one here);
// an element nobody tracks yet is added to the paths the canvas measures until
// its boxes arrive or APP_RPC_LIMITS.measureTimeoutMs passes. A one-off read
// lags a scroll; an overlay anchor (with `at` for a point) does not.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppRect } from '../../../shared/properties/appsRpc';
import type { MeasuredRects } from './overlayPlacement';

/** What the RPC asks of the measurer. */
export interface AppNodeMeasurer {
  /** The element's boxes, in the canvas viewport's CSS pixels; empty when it is not on the canvas. */
  readonly measure: (nodeId: string, occurrence: number | undefined) => Promise<readonly AppRect[]>;
}

interface Measurement {
  readonly rects: MeasuredRects;
  readonly pathFor: (nodeId: string) => string | undefined;
}

export interface OverlayMeasureStore extends AppNodeMeasurer {
  /** The overlay layer's newest measurement. */
  readonly note: (measurement: Measurement) => void;
  /** Node ids waiting to be measured: the canvas tracks them beside the overlay anchors. */
  readonly requested: () => readonly string[];
  readonly subscribe: (listener: () => void) => () => void;
}

export function createOverlayMeasure(options: { readonly timeoutMs: number }): OverlayMeasureStore {
  let latest: Measurement | undefined;
  let requested: readonly string[] = [];
  const waiters = new Map<string, Set<() => void>>();
  const listeners = new Set<() => void>();
  const setRequested = (next: readonly string[]): void => {
    requested = next;
    for (const listener of [...listeners]) {
      listener();
    }
  };
  const boxesOf = (nodeId: string, occurrence: number | undefined): readonly AppRect[] | undefined => {
    const path = latest?.pathFor(nodeId);
    const boxes = path === undefined ? undefined : latest?.rects[path];
    if (boxes === undefined) {
      return undefined;
    }
    const chosen = occurrence === undefined ? boxes.slice(0, APP_RPC_LIMITS.measureRectsMax) : boxes.slice(occurrence, occurrence + 1);
    return chosen.map((box) => ({ x: box.x, y: box.y, width: Math.max(0, box.w), height: Math.max(0, box.h) }));
  };
  return {
    note: (measurement) => {
      latest = measurement;
      for (const [nodeId, resolvers] of [...waiters]) {
        const path = measurement.pathFor(nodeId);
        if (path !== undefined && measurement.rects[path] !== undefined) {
          waiters.delete(nodeId);
          for (const resolve of resolvers) {
            resolve();
          }
        }
      }
    },
    requested: () => requested,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    measure: async (nodeId, occurrence) => {
      const known = boxesOf(nodeId, occurrence);
      if (known !== undefined) {
        return known;
      }
      if (latest?.pathFor(nodeId) === undefined) {
        return []; // Not an element of what the canvas shows.
      }
      if (waiters.size >= APP_RPC_LIMITS.measureRequestsMax && !waiters.has(nodeId)) {
        return []; // Too many waiting: answer with what is known, which is nothing.
      }
      await new Promise<void>((resolve) => {
        const resolvers = waiters.get(nodeId) ?? new Set<() => void>();
        resolvers.add(resolve);
        waiters.set(nodeId, resolvers);
        if (!requested.includes(nodeId)) {
          setRequested([...requested, nodeId]);
        }
        setTimeout(resolve, options.timeoutMs);
      });
      // Resolved by a measurement or the timeout: stop tracking it either way.
      if (!waiters.has(nodeId)) {
        setRequested(requested.filter((id) => id !== nodeId));
      }
      assert(waiters.size <= APP_RPC_LIMITS.measureRequestsMax, 'Measure requests are bounded');
      return boxesOf(nodeId, occurrence) ?? [];
    },
  };
}

/** The one store per editor window. */
export const overlayMeasure: OverlayMeasureStore = createOverlayMeasure({ timeoutMs: APP_RPC_LIMITS.measureTimeoutMs });

/** Node ids `node.measure` waits on, for the canvas to track beside the overlay anchors. */
export function useMeasureRequests(): readonly string[] {
  return useSyncExternalStore(overlayMeasure.subscribe, overlayMeasure.requested);
}
