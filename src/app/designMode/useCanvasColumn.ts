// Design mode (experimental, removable: docs/design-mode/REMOVE.md): where a part of the canvas column is, for the
// canvas and the bar, which sit over it in a fixed layer and so must follow it as panels open, close and resize.
import { useEffect, useState, type CSSProperties } from 'react';

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A column narrower or shorter than this cannot hold the bar: the window is used instead. */
const COLUMN_PX_MIN = 320;
/** The preview's own wrapper comes and goes without any size changing, so it is also looked for on a beat. */
const LOOK_AGAIN_MS = 250;

function measure(selector: string): Box | undefined {
  const box = document.querySelector(selector)?.getBoundingClientRect();
  if (box === undefined || box.width < COLUMN_PX_MIN || box.height < COLUMN_PX_MIN) {
    return undefined;
  }
  return { left: Math.round(box.left), top: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
}

function same(left: Box | undefined, right: Box | undefined): boolean {
  return left?.left === right?.left && left?.top === right?.top && left?.width === right?.width && left?.height === right?.height;
}

/**
 * The box of the element `selector` names as fixed-position style (physical sides: it is a box measured on the
 * screen, in any language). `visible` is false while it is not on screen, when the style covers the window.
 */
export function useCanvasColumn(selector: string): { readonly style: CSSProperties; readonly visible: boolean } {
  const [box, setBox] = useState<Box | undefined>(() => measure(selector));
  useEffect(() => {
    const update = (): void => {
      const next = measure(selector);
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
    const beat = window.setInterval(update, LOOK_AGAIN_MS);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      window.clearInterval(beat);
      window.removeEventListener('resize', update);
    };
  }, [selector]);
  const style = box ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  return { style: { left: style.left, top: style.top, width: style.width, height: style.height }, visible: box !== undefined };
}
