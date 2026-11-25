// A press on the canvas that was meant for the editor's own interface, not for the page under it. The component
// defaults editor saves and closes on a press on the dimmed page around its instance; these two presses reach the
// page there and mean something else.
import { outsideDismissedSince } from '../../ui/popupDismiss';

/** Where a canvas press landed, in the frame's own CSS pixels, and when (the frame's stamp, epoch milliseconds). */
export interface CanvasPress {
  readonly x: number | undefined;
  readonly y: number | undefined;
  readonly atMs: number | undefined;
}

// The name tags the editor draws beside its outlines. They take no pointer, so a press on one falls through to
// the page, and the tag above the instance sits on the dimmed page.
const TAG_SELECTOR = '.node-outline-tag, .canvas-drop-tag';
// A tag per drawn outline; a loop of thousands still ends here.
const TAGS_CHECKED_MAX = 2_000;

/** Whether the press only closed an open menu, picker or popover, or landed on one of the editor's name tags. */
export function pressWasForEditor(press: CanvasPress | undefined): boolean {
  if (press === undefined) {
    return false;
  }
  if (press.atMs !== undefined && outsideDismissedSince(press.atMs)) {
    return true;
  }
  return pressOnTag(press);
}

function pressOnTag({ x, y }: CanvasPress): boolean {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-clip iframe') ?? undefined;
  if (x === undefined || y === undefined || frame === undefined || frame.offsetWidth === 0) {
    return false;
  }
  const box = frame.getBoundingClientRect();
  const scale = box.width / frame.offsetWidth;
  const left = box.left + x * scale;
  const top = box.top + y * scale;
  const tags = Array.from(document.querySelectorAll(TAG_SELECTOR)).slice(0, TAGS_CHECKED_MAX);
  return tags.some((tag) => {
    const area = tag.getBoundingClientRect();
    return area.width > 0 && left >= area.left && left <= area.right && top >= area.top && top <= area.bottom;
  });
}
