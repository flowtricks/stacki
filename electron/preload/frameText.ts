import type { CanvasTextTarget, CanvasTextCatalog } from '../../shared/properties/canvasText';
import { isEditableThroughProps, textReach } from '../../shared/properties/closedComponentReach';
import { pathsOf, canvasTextSourceMatches, runsOf } from './frameRegions';
import { canvasDragged } from './frameInteraction';
import { matchCanvasText, canvasTextRect, elementsAt } from './frameTextMatch';
import { createCanvasTextSession } from './frameTextSession';
import { installTextMarks } from './frameTextMarks';
import { inlineTextRuns } from './inlineText';
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
      refuseBlockedText(catalog, event, post);
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
  window.addEventListener('scroll', session.dismissOnMovement, true);
  window.addEventListener('resize', session.dismissOnMovement);
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
  // Everything stacked at the point counts, so words beneath a stretched link are found; only the clicked element decides which text is nearest.
  const stack = elementsAt(event.clientX, event.clientY, event.target);
  // The clicked element's inline children (a `strong` or `em` in a heading) are candidates after the stacked elements: a click in
  // the empty corner beside the heading's last line is not on them, yet the words that end it are theirs.
  for (const inline of inlineDescendants(event.target)) {
    if (!stack.includes(inline)) {
      stack.push(inline);
    }
  }
  for (const [position, start] of stack.entries()) {
    let element: Element | undefined = start;
    for (let depth = 0; element && depth < 32; depth++) {
      const paths = pathsOf(element);
      for (const path of paths) {
        ancestors.add(path);
      }
      if (position === 0 && !innermost && paths.length) {
        innermost = new Set(paths);
      }
      element = element.parentElement ?? undefined;
    }
  }
  // A double-click inside the element that holds the text but beside its
  // words — the empty width of a centred heading — still means "edit this
  // text", not "open the component": the nearest text in that element takes it.
  let nearest: { readonly hit: TextHit; readonly distance: number; readonly gap: number } | undefined;
  for (const target of catalog.targets) {
    if (!ancestors.has(target.parent)) {
      continue;
    }
    if (target.scope !== undefined && !ancestors.has(target.scope)) {
      continue;
    }
    // Words inside a closed component are typed in only when a prop or the slot of this instance decides them, the same
    // rule the hover follows (closedComponentReach.ts), so a double click never opens an editor the hover did not offer.
    if (target.scope !== undefined && !isEditableThroughProps(textReach({ loaded: true, covering: target }))) {
      continue;
    }
    // The words are found from whichever stacked element lies inside their component: the clicked one first.
    const match = stack.reduce<ReturnType<typeof matchCanvasText>>((found, candidate) => found ?? matchCanvasText(target, candidate), undefined);
    // The words' own line boxes, not the one box around them all: that spans a `<br>`'s lines and the whitespace after the last
    // word, so it would hold the empty corner beside a shorter last line and take it for the first words' own.
    const boxes = match ? textLineBoxes(match) : [];
    if (!match || boxes.length === 0) {
      continue;
    }
    const distance = Math.min(...boxes.map((box) => distanceToBox(box, event.clientX, event.clientY)));
    if (distance === 0) {
      return { target, match };
    }
    // Only the clicked element's own words, or the words of an inline child of it (a `strong` or `em` the heading holds), are near
    // enough: they are the same text to the eye, so the empty corner beside a heading's last, shorter line reaches the `strong`
    // that ends it.
    if (!innermost?.has(target.parent) && !inlineWithin(event.target, match.element)) {
      continue;
    }
    // The nearest line first (the vertical gap), then the horizontal gap: the corner below and beside the last line belongs to
    // that line's words and not to a longer line above it that happens to be nearer by straight distance.
    const gap = Math.min(...boxes.map((box) => verticalGapToBox(box, event.clientY)));
    if (!nearest || gap < nearest.gap || (gap === nearest.gap && distance < nearest.distance)) {
      nearest = { hit: { target, match }, distance, gap };
    }
  }
  return nearest?.hit;
}

// Exported for the regression suite, with findTextHit. A double click on text
// printed from data that has no string to write to: the
// editor says why and where, in the person's language. The element is found by
// the source path of its words, since there is no text to match.
export function refuseBlockedText(catalog: CanvasTextCatalog, event: MouseEvent, post: (message: unknown) => void): void {
  const clicked = event.target;
  if (!(clicked instanceof Element)) {
    return;
  }
  const blocked = (catalog.blocked ?? []).find((entry) =>
    [...(runsOf(entry.path) ?? []), ...inlineTextRuns(entry.path)].some((run) => run.some((node) => node.parentElement === clicked)),
  );
  if (!blocked) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  post({
    type: 'avb:text-refused',
    // i18n-ignore: the English fallback beside the stable `reason` code, which the editor words in the person's language (useCanvasText); a frame older than the editor sends only this text.
    message: 'This text is computed in its source: edit it there.',
    reason: 'source-blocked',
    key: blocked.key,
  });
}

type TextHit = {
  readonly target: CanvasTextTarget;
  readonly match: NonNullable<ReturnType<typeof matchCanvasText>>;
};

// The boxes the browser draws the matched words' lines in. Bounded: a text node is a few lines, and the match a bounded number of nodes.
function textLineBoxes(match: NonNullable<ReturnType<typeof matchCanvasText>>): DOMRect[] {
  const boxes: DOMRect[] = [];
  // A host with no per-line boxes (a test double) still has the one box around the words.
  const probe = document.createRange();
  if (typeof probe.getClientRects !== 'function') {
    const whole = canvasTextRect(match);
    return whole ? [whole] : [];
  }
  for (const node of match.nodes) {
    if (node.length === 0) {
      continue;
    }
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.length);
    for (const box of Array.from(range.getClientRects())) {
      if (box.width > 0 && box.height > 0) {
        boxes.push(box);
      }
    }
  }
  return boxes;
}

// The inline elements inside one, in document order; a bounded walk.
const INLINE_DESCENDANTS_MAX = 24;
function inlineDescendants(clicked: Element): Element[] {
  const found: Element[] = [];
  if (typeof getComputedStyle !== 'function') {
    return found;
  }
  const queue: Element[] = Array.from(clicked.children).reverse();
  for (let step = 0; queue.length > 0 && step < 200 && found.length < INLINE_DESCENDANTS_MAX; step++) {
    const element = queue.pop();
    if (element && getComputedStyle(element).display === 'inline') {
      found.push(element);
      queue.push(...Array.from(element.children).reverse());
    }
  }
  return found;
}

// Whether an element lies inside the clicked one and is drawn inline with its words.
function inlineWithin(clicked: Element, element: Element): boolean {
  return typeof getComputedStyle === 'function' && clicked !== element && clicked.contains(element) && getComputedStyle(element).display === 'inline';
}

// How far a point's height is from a box's; zero within its rows.
function verticalGapToBox(box: DOMRect, y: number): number {
  return Math.max(box.top - y, 0, y - box.bottom);
}

// How far a point is from a box; zero inside it.
function distanceToBox(box: DOMRect, x: number, y: number): number {
  const dx = Math.max(box.left - x, 0, x - box.right);
  const dy = Math.max(box.top - y, 0, y - box.bottom);
  return Math.hypot(dx, dy);
}
