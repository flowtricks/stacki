import { useEffect, useRef, useState, type RefObject } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';

// A frame's later addresses replace its history entry instead of adding one. Frames
// share the tab's history, so an iframe whose `src` changes pushes an entry each time:
// every page the editor opened made back step through the canvas's own loads (and the
// preview's, in preview mode) before it reached the visitor's pages, and stepping back
// opened a page that loaded the canvas again, pushing anew and losing forward.
//
// The first address is the frame's `src`, which replaces the frame's initial empty
// document; each one after it is `location.replace`d, as the frame is the editor's
// and same-origin in Studio and the demo. A frame on another origin falls back to `src`.

/**
 * The `src` to render: the first address the frame was given, kept for its whole life.
 * `request` counts the times the editor asked for an address, so asking again for the
 * one the frame first had still moves a frame that has since left it (a link followed
 * in the preview).
 */
export function useFrameAddress(frame: RefObject<HTMLIFrameElement | null>, url: string | undefined, request = 0): string | undefined {
  const [first, setFirst] = useState(url);
  if (first === undefined && url !== undefined) {
    setFirst(url); // The frame had nothing to show yet: its first address is still `src`.
  }
  const asked = useRef({ url, request });
  useEffect(() => {
    const before = asked.current;
    asked.current = { url, request };
    if (url === undefined) {
      return;
    }
    if (before.url === url && before.request === request) {
      return; // Nothing new was asked for: the first render, or a render for another reason.
    }
    const element = frame.current;
    if (element === null) {
      return;
    }
    if (frameShows(element, url)) {
      return;
    }
    replaceFrameAddress(element, url);
  }, [frame, url, request]);
  return first;
}

// Whether the frame already shows this address's page (its hash aside), where the
// editor can read the frame's location.
function frameShows(element: Pick<HTMLIFrameElement, 'contentWindow'>, url: string): boolean {
  try {
    const shown = element.contentWindow?.location.href;
    if (shown === undefined) {
      return false;
    }
    const left = new URL(shown);
    const right = new URL(url, shown);
    return left.origin === right.origin && left.pathname === right.pathname && left.search === right.search && left.hash === right.hash;
  } catch {
    return false; // Another origin: replace and let the frame load it.
  }
}

/** Points a frame at an address without adding a history entry, where the editor may. */
export function replaceFrameAddress(element: Pick<HTMLIFrameElement, 'contentWindow' | 'src'>, url: string): void {
  assert(url.length > 0, 'A frame address is not empty');
  try {
    const target = element.contentWindow;
    if (target !== null) {
      target.location.replace(url);
      return;
    }
  } catch {
    /* Another origin: its location cannot be replaced from here. */
  }
  element.src = url;
}
