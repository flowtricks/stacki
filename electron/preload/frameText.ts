import type { CanvasTextTarget, CanvasTextCatalog } from '../../shared/properties/canvasText';
import { isEditableThroughProps, textReach } from '../../shared/properties/closedComponentReach';
import { pathsOf, canvasTextSourceMatches, runsOf, elementsWithPath } from './frameRegions';
import { canvasDragged } from './frameInteraction';
import { matchCanvasText, canvasTextRect, elementsAt } from './frameTextMatch';
import { createCanvasTextSession } from './frameTextSession';
import { awaitingRichRender, settleRichRender } from './frameRichText';
import { installTextMarks } from './frameTextMarks';
import { inlineTextRuns } from './inlineText';
import { isTouchDoubleTap, type TapPoint } from './frameDoubleTap';

// A double click on words still shown as just typed waits for their rendering: a bounded number of short looks.
const RENDER_TRY_MS = 50;
const RENDER_TRIES_MAX = 60;

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
    if (event.target instanceof Element && selects() && !canvasDragged() && awaitingRichRender(event.target)) {
      // The words just saved are still shown as typed: they open once their rendering is on the page.
      event.preventDefault();
      event.stopImmediatePropagation();
      openAfterRender(event);
      return;
    }
    open(event);
  };
  const open = (event: MouseEvent) => {
    const catalog = session.catalog();
    if (!selects() || canvasDragged() || !catalog || !(event.target instanceof Element)) {
      return;
    }
    // A double click inside rich text but on no words (between its paragraphs, in its padding) is still typing in it:
    // the caret goes to the nearest line. The component opens by its name tag, the Navigator or the context menu.
    const hit = findTextHit(catalog, event) ?? findRichBoxHit(catalog, event) ?? findWordlessHit(catalog, event) ?? findBesideHit(catalog, event);
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
  // The same double click, tried again once the rendering has landed and the editor has said what its words are; given
  // up after a bound, or when anything else is pressed first.
  let waiting: AbortController | undefined;
  const openAfterRender = (event: MouseEvent) => {
    waiting?.abort();
    const wait = new AbortController();
    waiting = wait;
    const { clientX, clientY } = event;
    let tries = 0;
    const attempt = () => {
      const target = document.elementFromPoint(clientX, clientY) ?? undefined;
      const catalog = session.catalog();
      const ready = target !== undefined && !awaitingRichRender(target) && catalog && canvasTextSourceMatches(catalog.file, catalog.checksum);
      if (wait.signal.aborted) {
        return;
      }
      if (ready) {
        wait.abort();
        // Said again as the browser says it, to the element now under the pointer.
        target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX, clientY }));
      } else if (tries++ < RENDER_TRIES_MAX) {
        setTimeout(attempt, RENDER_TRY_MS);
      } else if (target !== undefined) {
        // No rendering is coming (the host wrote nothing): the press is not left unanswered.
        wait.abort();
        settleRichRender(target);
        document
          .elementFromPoint(clientX, clientY)
          ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, composed: true, clientX, clientY }));
      }
    };
    window.addEventListener('mousedown', () => wait.abort(), { capture: true, signal: wait.signal });
    setTimeout(attempt, RENDER_TRY_MS);
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

// The rich text whose editable box holds the clicked element: the element whose children are an instance's blocks.
// Of that instance's words, the ones drawn nearest the click open the editor. Exported for the regression suite.
export function findRichBoxHit(catalog: CanvasTextCatalog, event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): TextHit | undefined {
  const rich = catalog.targets.filter((target) => target.breaks === 'rich' && target.richRoot !== undefined);
  if (rich.length === 0 || !(event.target instanceof Element)) {
    return undefined;
  }
  // The innermost box wins: rich text inside rich text is edited as its own.
  let box: Element | undefined = event.target;
  for (let depth = 0; box && depth < 32; depth++, box = box.parentElement ?? undefined) {
    let nearest: { readonly hit: TextHit; readonly distance: number; readonly gap: number } | undefined;
    for (const target of rich) {
      if (target.scope !== undefined && !isEditableThroughProps(textReach({ loaded: true, covering: target }))) {
        continue;
      }
      const parent = blockHolding(box, target);
      const match = parent === undefined ? undefined : matchCanvasText(target, parent);
      if (!match) {
        continue;
      }
      for (const line of textLineBoxes(match)) {
        const gap = verticalGapToBox(line, event.clientY);
        const distance = distanceToBox(line, event.clientX, event.clientY);
        if (!nearest || gap < nearest.gap || (gap === nearest.gap && distance < nearest.distance)) {
          nearest = { hit: { target, match }, distance, gap };
        }
      }
    }
    if (nearest) {
      return nearest.hit;
    }
  }
  return undefined;
}

// Rich text with no words to find it by (only an image, an empty paragraph): its box, found by the blocks the catalog
// says are an instance's. The edit is named by the instance. Exported for the regression suite.
export function findWordlessHit(catalog: CanvasTextCatalog, event: Pick<MouseEvent, 'target'>): TextHit | undefined {
  let box: Element | undefined = event.target instanceof Element ? event.target : undefined;
  for (let depth = 0; box && depth < 32; depth++, box = box.parentElement ?? undefined) {
    for (const root of catalog.boxes ?? []) {
      const block = ownBlockOf(box, root);
      if (block !== undefined) {
        return wordlessHit(root, block);
      }
    }
  }
  return undefined;
}

function wordlessHit(root: string, block: Element): TextHit {
  const target: CanvasTextTarget = {
    kind: 'component',
    key: `box:${root}`,
    path: root,
    parent: root,
    value: '',
    label: '',
    nested: false,
    tag: '',
    siblings: [],
    breaks: 'rich',
    richRoot: root,
  };
  return { target, match: { nodes: [], element: block } };
}

// A double click in the empty space beside typed text that is narrower than its row (a maximum width): on an element
// around the text, level with it, left or right of its box. As in any text editor, that is typing in the nearest words.
// Space above or below stays the element's, and opens the component as before. Exported for the regression suite.
export function findBesideHit(catalog: CanvasTextCatalog, event: Pick<MouseEvent, 'target' | 'clientX' | 'clientY'>): TextHit | undefined {
  const around = event.target;
  if (!(around instanceof Element)) {
    return undefined;
  }
  let nearest: { readonly hit: TextHit; readonly distance: number } | undefined;
  for (const target of catalog.targets) {
    if (target.breaks === undefined || (target.scope !== undefined && !isEditableThroughProps(textReach({ loaded: true, covering: target })))) {
      continue;
    }
    for (const parent of elementsWithPath(target.parent)) {
      // The box that is typed in: the element holding an instance's blocks, or the line of words itself.
      const box = target.breaks === 'rich' ? editableBox(parent, target.richRoot ?? '') : parent;
      if (box === undefined || box === around || !around.contains(box)) {
        continue;
      }
      const bounds = box.getBoundingClientRect();
      const level = event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      if (!level || (event.clientX >= bounds.left && event.clientX <= bounds.right)) {
        continue;
      }
      const match = matchCanvasText(target, parent);
      for (const line of match ? textLineBoxes(match) : []) {
        const distance = distanceToBox(line, event.clientX, event.clientY);
        if (match && (nearest === undefined || distance < nearest.distance)) {
          nearest = { hit: { target, match }, distance };
        }
      }
    }
  }
  return nearest?.hit ?? besideWordlessBox(catalog, around, event);
}

// The same beside rich text with no words, whose box may be next to nothing wide.
function besideWordlessBox(catalog: CanvasTextCatalog, around: Element, event: Pick<MouseEvent, 'clientX' | 'clientY'>): TextHit | undefined {
  for (const root of catalog.boxes ?? []) {
    // The first block still marked is enough to find the box; a few places are looked at.
    const block = Array.from({ length: BOX_BLOCKS_LOOKED }, (_, index) => elementsWithPath(`${root}.${index}`)[0]).find((found) => found !== undefined);
    const box = block?.parentElement ?? undefined;
    if (block === undefined || box === undefined || box === around || !around.contains(box)) {
      continue;
    }
    const bounds = box.getBoundingClientRect();
    if (event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      return wordlessHit(root, block);
    }
  }
  return undefined;
}

const BOX_BLOCKS_LOOKED = 8;

// The child of `box` that is a block of the instance at `root`, when it has one.
function ownBlockOf(box: Element, root: string): Element | undefined {
  return Array.from(box.children)
    .slice(0, 500)
    .find((element) => pathsOf(element).some((path) => path.startsWith(`${root}.`) && /^\d+$/.test(path.slice(root.length + 1))));
}

function editableBox(element: Element, root: string): Element | undefined {
  let current: Element | undefined = element.parentElement ?? undefined;
  for (let depth = 0; current && depth < 32; depth++, current = current.parentElement ?? undefined) {
    if (ownBlockOf(current, root) !== undefined) {
      return current;
    }
  }
  return undefined;
}

// The element holding a rich target's words, when `box` is the instance's editable box: one of the box's own children
// is a block of the instance, and holds those words.
function blockHolding(box: Element, target: CanvasTextTarget): Element | undefined {
  const root = target.richRoot ?? '';
  const isBlock = (element: Element) => pathsOf(element).some((path) => path.startsWith(`${root}.`) && /^\d+$/.test(path.slice(root.length + 1)));
  const block = Array.from(box.children)
    .slice(0, 500)
    .find(
      (child) =>
        isBlock(child) &&
        (pathsOf(child).includes(target.parent) || target.parent.startsWith(`${pathsOf(child).find((path) => path.startsWith(`${root}.`)) ?? ''}.`)),
    );
  if (block === undefined) {
    return undefined;
  }
  if (pathsOf(block).includes(target.parent)) {
    return block;
  }
  return Array.from(block.querySelectorAll('*'))
    .slice(0, 500)
    .find((element) => pathsOf(element).includes(target.parent));
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
