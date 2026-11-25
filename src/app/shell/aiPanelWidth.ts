import { useEffect } from 'react';
import { assert } from '../../../shared/core/assert';
import { requestPanelWidth } from '../../ui/panelWidthRequests';
import { CANVAS_WIDTH_PX_MIN } from './editorLayout';
import { PANEL_WIDTH_PX_MAX, PANEL_WIDTH_PX_MIN } from './ResizablePanel';

// The docked AI chat is the one left tab that wants room: a transcript at the shared 260px
// left width wraps every message after a few words. Other left tabs keep the shared width,
// so the chat asks for its own through a width request (panelWidthRequests.ts), and the
// user's resize while it shows is remembered here, not in the shared left width.
export const AI_PANEL_WIDTH_PX_DEFAULT = 440;

const STORAGE_KEY = 'stacki.panel.width.ai';
const STORED_WIDTH_CHARS_MAX = 3;

/** The width the docked chat opens at: the user's last resize when stored, else the default fitted to the window. */
export function aiPanelWidthPx(viewportWidthPx: number): number {
  assert(Number.isFinite(viewportWidthPx), 'The viewport width must be finite');
  const stored = readStoredAiPanelWidth();
  if (stored !== undefined) {
    return stored;
  }
  // Leave the canvas its minimum when the window allows; never go below the panel's own minimum.
  const room = Math.floor(viewportWidthPx) - CANVAS_WIDTH_PX_MIN;
  const width = Math.max(PANEL_WIDTH_PX_MIN.left, Math.min(AI_PANEL_WIDTH_PX_DEFAULT, room));
  assert(width >= PANEL_WIDTH_PX_MIN.left, 'The default chat width keeps the panel minimum');
  assert(width <= AI_PANEL_WIDTH_PX_DEFAULT, 'The default chat width never exceeds the default');
  return width;
}

export function parseStoredAiPanelWidth(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > STORED_WIDTH_CHARS_MAX) {
    return undefined;
  }
  const width = Number(raw);
  if (!Number.isSafeInteger(width)) {
    return undefined;
  }
  if (width < PANEL_WIDTH_PX_MIN.left || width > PANEL_WIDTH_PX_MAX) {
    return undefined;
  }
  return width;
}

/** Holds the chat's width on the left panel while it shows; the release restores the user's shared left width. */
export function useAiPanelWidth(): void {
  useEffect(
    () =>
      requestPanelWidth('left', {
        widthPx: aiPanelWidthPx(window.innerWidth),
        onResize: storeAiPanelWidth,
      }),
    [],
  );
}

function readStoredAiPanelWidth(): number | undefined {
  try {
    return parseStoredAiPanelWidth(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be unavailable; the default still applies.
    return undefined;
  }
}

function storeAiPanelWidth(widthPx: number): void {
  assert(parseStoredAiPanelWidth(String(widthPx)) === widthPx, 'A stored chat width is within the panel bounds');
  try {
    localStorage.setItem(STORAGE_KEY, String(widthPx));
  } catch {
    // Losing an optional preference must not interrupt a resize.
  }
}
