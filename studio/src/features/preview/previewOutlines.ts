import { collectRegions, focusPath, announceMapped } from '../../../vendor/stacki/electron/preload/frameRegions';
import { rectsForPath, spacingForPath, classesForPath } from '../../../vendor/stacki/electron/preload/frameMeasure';
import { outlineBoxPath } from '../../../vendor/stacki/src/features/preview/outlineBoxes';
export interface OutlineTarget {
  readonly id: string;
  readonly label: string;
  readonly component: boolean;
  readonly nodeKind: string;
  readonly occurrence?: number;
}
// Stacki measures inside the page and draws in the editor, keeping labels and
// stroke widths constant even when the canvas is scaled down.
export function createOutlines(post: (message: unknown) => void) {
  const collect = () => {
    collectRegions();
    announceMapped();
  };
  collect();
  document.addEventListener('avb:morphed', collect);
  let pending = 0;
  let current: { selected: OutlineTarget | undefined; hovered: OutlineTarget | undefined };
  let collaborators: readonly string[] = [];
  const draw = () => {
    pending = 0;
    const paths = new Set([current.selected, current.hovered].flatMap((target) => (target ? [target.id, outlineBoxPath(target.id, target.nodeKind)] : [])));
    if (focusPath) {
      paths.add(focusPath);
    }
    for (const path of collaborators) {
      paths.add(path);
    }
    const rects = Object.fromEntries([...paths].map((path) => [path, rectsForPath(path)?.slice(0, 500) ?? []]));
    const spacing = Object.fromEntries([...paths].map((path) => [path, spacingForPath(path).slice(0, 500)]));
    const classes = Object.fromEntries([...paths].map((path) => [path, classesForPath(path).slice(0, 500)]));
    post({ type: 'studio:outlines', ...current, rects, spacing, classes });
  };
  return (selected: OutlineTarget | undefined, hovered: OutlineTarget | undefined, paths: readonly string[] = []) => {
    collaborators = paths;
    current = { selected, hovered };
    if (!pending) {
      pending = requestAnimationFrame(draw);
    }
  };
}
