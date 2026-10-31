import type { CanvasTextTarget, CanvasTextCatalog } from '../../shared/properties/canvasText';
import { pathsOf, canvasTextSourceMatches } from './frameRegions';
import { canvasDragged } from './frameInteraction';
import { matchCanvasText, canvasTextRect } from './frameTextMatch';
import { createCanvasTextSession } from './frameTextSession';
import { installTextMarks } from './frameTextMarks';

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
  const click = (event: MouseEvent) => {
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
    if (event.type !== 'dblclick') {
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
        message: 'Text editing is waiting for the current source render.',
      });
      return;
    }
    select(hit.target, hit.match.element);
    session.open(hit.target, hit.match, event);
    redrawMarks();
  };
  window.addEventListener('click', click, true);
  window.addEventListener('dblclick', click, true);
  window.addEventListener('scroll', session.dismiss, true);
  window.addEventListener('resize', session.dismiss);
  document.addEventListener('avb:morphed', session.reconcile);
}

function findTextHit(catalog: CanvasTextCatalog, event: MouseEvent) {
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
