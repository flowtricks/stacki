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
  window.addEventListener(
    'dblclick',
    (event: MouseEvent) => {
      if (!selects() || canvasDragged()) {
        return;
      }
      const image = imageOf(event.target ?? undefined);
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
