// A double click on an image asks the editor to open its small popup (change the picture, edit its alt
// text). The frame only says which image: the marker paths the element carries, which name its own node and
// every component instance that rendered it, and where its bottom-left corner is. The editor traces those
// paths back to the prop (or attribute) that decides the picture (src/app/model/canvasImageTrace.ts), so a
// closed component's image is edited without opening the component.
//
// It listens ahead of the double click that opens a component (frameTargets.ts) and takes the event only
// for an image: every other double click, text included, goes on as it did.
import { canvasDragged } from './frameInteraction';
import { pathsOf, renderToken } from './frameRegions';

// How many ancestors are read for paths, and how many paths are sent: a page nests deeply, and the editor
// only needs the nodes that enclose the image.
export const IMAGE_ANCESTORS_MAX = 32;
export const IMAGE_PATHS_MAX = 128;
// How many of the page's images are measured against a double click.
export const IMAGES_MAX = 500;
const OWN_NODES_MAX = 200;
// How many elements under the pointer are searched for words.
const STACK_MAX = 24;

/** The `<img>` a double click landed on (itself, or the image inside a `<picture>`), or undefined for anything else. */
export function imageOf(target: EventTarget | undefined): HTMLImageElement | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  if (target instanceof HTMLImageElement) {
    return target;
  }
  const picture = target.closest('picture');
  const inside = picture?.querySelector('img');
  return inside instanceof HTMLImageElement ? inside : undefined;
}

// Controls that mean their own press: a double click on one, over its own box, is never an image's.
const CONTROL_SELECTOR = 'a, button, input, select, textarea, label, summary';

/**
 * The image a double click means: the one it landed on, or the one whose box holds the pointer. A Card
 * draws its picture under other things: a cover Card's picture takes no pointer at all
 * (`pointer-events: none`), and a Card with a link stretches the link's `::after` over the whole card, so the
 * click lands on the overlay, the content or the link and the picture is only under the pointer. A control
 * keeps a double click on its own box; the stretched part of its hit area beyond that box is the picture's.
 * The smallest picture holding the pointer wins.
 */
export function imageAtPoint(event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): HTMLImageElement | undefined {
  const direct = imageOf(event.target ?? undefined);
  if (direct !== undefined) {
    return direct;
  }
  const target = event.target;
  if (!(target instanceof Element)) {
    return undefined;
  }
  // Words keep their double click (text editing, frameText.ts): an element with text of its own is the words' to
  // claim. A control keeps it over its own box; beyond that, where its hit area is only stretched, it is the picture's.
  const control = target.closest(CONTROL_SELECTOR);
  if (wordsAt(event) || (control !== null && holds(control.getBoundingClientRect(), event))) {
    return undefined;
  }
  let best: { readonly image: HTMLImageElement; readonly area: number } | undefined;
  for (const image of Array.from(document.images).slice(0, IMAGES_MAX)) {
    const box = image.getBoundingClientRect();
    if (pathsOf(image).length === 0 || !holds(box, event)) {
      continue;
    }
    const area = box.width * box.height;
    if (best === undefined || area < best.area) {
      best = { image, area };
    }
  }
  return best?.image;
}

// Whether the pointer is on words: on a text node's own box, in any element under it, however a stretched link or
// an overlay covers them. Words keep the double click for text editing, whatever picture lies beneath.
function wordsAt(point: Pick<MouseEvent, 'clientX' | 'clientY'>): boolean {
  for (const element of document.elementsFromPoint(point.clientX, point.clientY).slice(0, STACK_MAX)) {
    const children = Array.from(element.childNodes).slice(0, OWN_NODES_MAX);
    for (const node of children) {
      if (node.nodeType !== Node.TEXT_NODE || (node.textContent ?? '').trim() === '') {
        continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      if (Array.from(range.getClientRects()).some((box) => holds(box, point))) {
        return true;
      }
    }
  }
  return false;
}

function holds(box: DOMRect, point: Pick<MouseEvent, 'clientX' | 'clientY'>): boolean {
  return box.width > 0 && box.height > 0 && point.clientX >= box.left && point.clientX <= box.right && point.clientY >= box.top && point.clientY <= box.bottom;
}

/** The marker paths an image carries and its ancestors do, nearest first, without repeats. */
export function imagePaths(image: Element): readonly string[] {
  const seen = new Set<string>();
  let element: Element | undefined = image;
  for (let depth = 0; element !== undefined && depth < IMAGE_ANCESTORS_MAX; depth++) {
    for (const path of pathsOf(element)) {
      if (seen.size < IMAGE_PATHS_MAX) {
        seen.add(path);
      }
    }
    element = element.parentElement ?? undefined;
  }
  return [...seen];
}

export function installCanvasImage(post: (message: unknown) => void, selects: () => boolean): void {
  // Whether the editor may have a popup open beside an image: the canvas moving under it closes it.
  let popupMayBeOpen = false;
  const closePopup = (): void => {
    if (popupMayBeOpen) {
      popupMayBeOpen = false;
      post({ type: 'avb:image-close' });
    }
  };
  window.addEventListener('scroll', closePopup, true);
  window.addEventListener('resize', closePopup);
  // Any press on the canvas after the double click goes elsewhere: the popup is done, even when the press selects the same node.
  window.addEventListener('mousedown', closePopup, true);
  window.addEventListener(
    'dblclick',
    (event: MouseEvent) => {
      if (!selects() || canvasDragged()) {
        return;
      }
      const image = imageAtPoint(event);
      if (image === undefined) {
        return;
      }
      const paths = imagePaths(image);
      if (paths.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      popupMayBeOpen = true;
      const box = image.getBoundingClientRect();
      post({ type: 'avb:image-edit', paths, left: Math.max(0, box.left), top: Math.max(0, box.bottom), token: renderToken });
    },
    true,
  );
}
