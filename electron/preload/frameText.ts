import type { CanvasTextTarget, CanvasTextCatalog } from '../../shared/properties/canvasText';
import { pathsOf, canvasTextSourceMatches } from './frameRegions';
import { canvasDragged } from './frameInteraction';
import { matchCanvasText, canvasTextRect } from './frameTextMatch';
import { createCanvasTextSession } from './frameTextSession';
import { installTextMarks } from './frameTextMarks';
import { isTouchDoubleTap, type TapPoint } from './frameDoubleTap';

export function installCanvasText(
  post: (message: unknown) => void,
  selects: () => boolean,
  select: (target: CanvasTextTarget, element: Element) => void,
): void {
  const session = createCanvasTextSession(post);
  const redrawMarks = installTextMarks({
    catalog: session.catalog,
    editing: session.editing,
    editingElement: session.editingElement,
    focus: session.focus,
    visible: selects,
    post,
  });
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent) {
      return;
    }
    session.receive(event.data);
    redrawMarks();
  });
  // The last tap's point, while a touch may still make it a double tap.
  let touchTap: TapPoint | undefined;
  let touchPointer = false;
  const click = (event: MouseEvent) => {
    const doubled = event.type === 'dblclick' || touchDoubled(event);
    if (session.contains(event)) {
      // The native mousedown has already placed/extended the caret. Keep editing
      // while suppressing page click handlers and component drill-in behavior.
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    session.dismiss();
    redrawMarks();
    // A single click belongs to element selection, marked prop text included.
    // Only a double click may take over focus for typing; clicks inside an
    // open editor still place its caret.
    if (!doubled) {
      return;
    }
    const catalog = session.catalog();
    if (!selects() || canvasDragged() || !catalog || !(event.target instanceof Element)) {
      return;
    }
    const hit = findTextHit(catalog, event);
    if (!hit) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!canvasTextSourceMatches(catalog.file, catalog.checksum)) {
      post({
        type: 'avb:text-refused',
        // i18n-ignore: the English fallback beside the stable `reason` code, which the editor words in the person's language (useCanvasText); a frame older than the editor sends only this text.
        message: 'Text editing is waiting for the current source render.',
        reason: 'waiting-render',
      });
      return;
    }
    select(hit.target, hit.match.element);
    session.open(hit.target, hit.match, event);
    redrawMarks();
  };
  // Safari on iPhone and iPad may answer a double tap with two clicks and no
  // dblclick (it keeps the gesture for zooming), so two touch clicks close
  // together in time and place count as one. A mouse never takes this path,
  // which leaves Desktop and every pointer-driven browser as they were.
  const touchDoubled = (event: MouseEvent): boolean => {
    if (event.type !== 'click') {
      touchTap = undefined;
      return false;
    }
    if (!touchPointer) {
      touchTap = undefined;
      return false;
    }
    const tap: TapPoint = { x: event.clientX, y: event.clientY, timeMs: event.timeStamp };
    const doubled = isTouchDoubleTap(touchTap, tap);
    touchTap = doubled ? undefined : tap;
    return doubled;
  };
  window.addEventListener(
    'pointerdown',
    (event: PointerEvent) => {
      touchPointer = event.pointerType === 'touch';
    },
    true,
  );
  window.addEventListener('click', click, true);
  window.addEventListener('dblclick', click, true);
  window.addEventListener('scroll', session.dismiss, true);
  window.addEventListener('resize', session.dismiss);
  document.addEventListener('avb:morphed', session.reconcile);
}

// Exported for the regression suite, which hit-tests a rendered instance the
// way a double click does without standing up a whole frame.
export function findTextHit(catalog: CanvasTextCatalog, event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): TextHit | undefined {
  if (!(event.target instanceof Element)) {
    return undefined;
  }
  const ancestors = new Set<string>();
  // The paths of the innermost tagged element clicked: only its own text is
  // near enough to take a click that missed the words.
  let innermost: ReadonlySet<string> | undefined;
  let element: Element | undefined = event.target;
  for (let depth = 0; element && depth < 32; depth++) {
    const paths = pathsOf(element);
    for (const path of paths) {
      ancestors.add(path);
    }
    if (!innermost && paths.length) {
      innermost = new Set(paths);
    }
    element = element.parentElement ?? undefined;
  }
  // A double-click inside the element that holds the text but beside its
  // words — the empty width of a centred heading — still means "edit this
  // text", not "open the component": the nearest text in that element takes it.
  let nearest: { readonly hit: TextHit; readonly distance: number } | undefined;
  for (const target of catalog.targets) {
    if (!ancestors.has(target.parent)) {
      continue;
    }
    if (target.scope !== undefined && !ancestors.has(target.scope)) {
      continue;
    }
    const match = matchCanvasText(target, event.target);
    const box = match && canvasTextRect(match);
    if (!box || !match) {
      continue;
    }
    const distance = distanceToBox(box, event.clientX, event.clientY);
    if (distance === 0) {
      return { target, match };
    }
    if (!innermost?.has(target.parent)) {
      continue;
    }
    if (!nearest || distance < nearest.distance) {
      nearest = { hit: { target, match }, distance };
    }
  }
  return nearest?.hit;
}

type TextHit = {
  readonly target: CanvasTextTarget;
  readonly match: NonNullable<ReturnType<typeof matchCanvasText>>;
};

// How far a point is from a box; zero inside it.
function distanceToBox(box: DOMRect, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}
