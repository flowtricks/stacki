// Design mode (experimental, removable: docs/design-mode/REMOVE.md): where the canvas column is, for the bar and the
// board, which sit over it in a fixed layer and so must follow it as panels open, close and resize.
import { useEffect, useState, type CSSProperties } from 'react';

interface ColumnBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A column narrower or shorter than this cannot hold the bar: the window is used instead. */
const COLUMN_PX_MIN = 320;

function measure(): ColumnBox {
  const center = document.querySelector('.main > .center');
  const box = center === null ? undefined : center.getBoundingClientRect();
  // No canvas column on screen (a panel covers it, or the layout has none): the whole window, so the bar and its
  // Exit are never out of sight.
  if (box === undefined || box.width < COLUMN_PX_MIN || box.height < COLUMN_PX_MIN) {
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }
  return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}

function same(left: ColumnBox, right: ColumnBox): boolean {
  return left.left === right.left && left.top === right.top && left.width === right.width && left.height === right.height;
}

/** The column's box as fixed-position style (physical sides: it is a box measured on the screen, in any language). */
export function useCanvasColumn(): CSSProperties {
  const [box, setBox] = useState<ColumnBox>(measure);
  useEffect(() => {
    const update = (): void => {
      const next = measure();
      setBox((current) => (same(current, next) ? current : next));
    };
    update();
    const observer = new ResizeObserver(update);
    const main = document.querySelector('.main');
    if (main !== null) {
      observer.observe(main);
      for (const child of main.children) {
        observer.observe(child);
      }
    }
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}
