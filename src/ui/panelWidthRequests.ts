// A width something other than the user asks a side panel to take for a while: a
// docked app's manifest width (src/features/apps). The user's own width stays
// stored and returns when the request is released. A drag or arrow key while the
// request holds resizes the request, not the stored width, and is reported to its
// owner through `onResize`, so the owner can remember it: a manual resize wins
// over the requested default. ResizablePanel.tsx reads the held requests, clamps
// them to its own bounds and draws them; this module sits below it so features
// can request a width without importing the app shell.
import { assert } from '../../shared/core/assert';

export type PanelKind = 'left' | 'code' | 'right';

export interface PanelWidthRequest {
  readonly widthPx: number;
  readonly onResize: (widthPx: number) => void;
}

interface HeldWidthRequest extends PanelWidthRequest {
  readonly token: symbol;
}

// One request per panel kind, so at most three: the latest request wins its panel.
const PANEL_KINDS_COUNT = 3;
// Panels and layout readers mounted at once: a few per edition, so more means a leak.
const REQUEST_LISTENERS_MAX = 64;
const requests = new Map<PanelKind, HeldWidthRequest>();
const listeners = new Set<() => void>();

/** Holds `request` on `kind`'s panel until the returned release runs. */
export function requestPanelWidth(kind: PanelKind, request: PanelWidthRequest): () => void {
  assert(Number.isFinite(request.widthPx), 'A requested panel width must be finite');
  assert(request.widthPx > 0, 'A requested panel width must be positive');
  const token = Symbol(kind);
  requests.set(kind, { ...request, token });
  assert(requests.size <= PANEL_KINDS_COUNT, 'Panel width requests are one per panel');
  changed();
  return () => {
    // A later request for the same panel replaced this one; its release must not drop that.
    if (requests.get(kind)?.token === token) {
      requests.delete(kind);
      changed();
    }
  };
}

/** The width requested for `kind`'s panel, unclamped, or undefined when none holds. */
export function requestedPanelWidth(kind: PanelKind): number | undefined {
  return requests.get(kind)?.widthPx;
}

/**
 * The user resized a panel while a request held: the request takes the new width
 * and its owner hears it. Returns false when no request holds, so the caller
 * stores the width as the user's own.
 */
export function resizeRequestedPanel(kind: PanelKind, widthPx: number): boolean {
  assert(Number.isFinite(widthPx), 'A resized panel width must be finite');
  const held = requests.get(kind);
  if (held === undefined) {
    return false;
  }
  requests.set(kind, { ...held, widthPx });
  held.onResize(widthPx);
  changed();
  return true;
}

export function subscribePanelWidthRequests(listener: () => void): () => void {
  assert(listeners.size < REQUEST_LISTENERS_MAX, 'Panel width request listeners exceed their limit');
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function changed(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}
