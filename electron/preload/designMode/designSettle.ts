// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the page played through before it is pictured.
//
// A frame runs no script and does not scroll, so it shows whatever the page had reached when it was copied. The live
// canvas under Design mode has never been scrolled: a reveal on scroll has not started (its element is hidden, or its
// lines are still under their masks), one that has started is half way, and a canvas further down is blank. So before
// a copy the canvas is walked from top to bottom as a visitor would walk it, and the copy is taken once the page has
// verifiably come to rest: finite CSS and Web animations are finished at once, and script animations are waited for
// until the page stops writing (an element that never stops is a loop, and is not waited for).
//
// What only holds while it is on screen (a value tied to the scroll position, a reveal that reverses, a view
// timeline, a canvas that draws only when seen) is read while its element is nearest the middle of the screen, and
// written on the copy alone. The page is put back where it was scrolled; no style of the copy reaches the project.
// A pinned sequence has no single look: it is shown as it starts, once, without the scroll room made for it.
import { DESIGN_SNAPSHOT_LIMITS } from '../../../shared/ipc/designSnapshot';
import { assert } from '../../../shared/core/assert';
import { canvasPicture } from './designSnapshotPictures';
import { differenceOf, type DesignAppearance, type DesignOverride } from './designSettleDiff';

export const DESIGN_SETTLE_LIMITS = {
  /** The longest one walk of a page takes, reveals and all. Past it the page is pictured as it is. */
  walkMsMax: 12_000,
  /** The longest the page's load and fonts are waited for before the walk. */
  loadMsMax: 3_000,
  /** Writes must stop for this long before the page counts as at rest. */
  quietMs: 400,
  /** The same, while something the page's script hid is still hidden: a delayed or staggered entrance may be due. */
  hiddenQuietMs: 1_400,
  /** The same, at each stop of the second walk, where only what reverses or scrubs still moves. */
  stepQuietMs: 120,
  /** The longest one stop of the second walk waits. */
  stepMsMax: 2_500,
  /** An element still being written after this long, without a pause of loopGapMs, loops: it is not waited for. */
  loopMs: 3_000,
  loopGapMs: 350,
  /** Stops of one walk. A page too tall for these is walked in longer steps. */
  stopsMax: 60,
  /** Elements whose writes are followed, canvases and videos pictured, and animations handled at one stop. */
  touchedMax: 4_000,
  surfacesMax: 16,
  animationsMax: 2_000,
  /** Animation frames waited for a canvas to hold a picture: one redrawn 30 times a second skips every other. */
  surfaceFramesMax: 10,
  /** An element taller than this many screens is a holder, whose look is not read from one stop. */
  recordScreensMax: 1.5,
} as const satisfies Record<string, number>;

/** The editor's own pieces in the canvas document, whose writes say nothing about the page. */
const EDITOR_PIECES = '[id^="avb-"], [data-avb-text-editor], [data-avb-text-marks], astro-dev-toolbar, vite-error-overlay';
/** A script's pin: the element is held while its holder's padding scrolls past (GSAP's ScrollTrigger names it so). */
export const PIN_HOLDER = '.pin-spacer';

interface Seen {
  readonly distance: number;
  readonly look: DesignAppearance;
}

interface PageMemory {
  /** What each element needs on the copy to look as it did while it was on screen. */
  readonly overrides: Map<Element, DesignOverride>;
  /** What a Web animation or a scroll timeline gave an element, which no copy of the document carries. */
  readonly motion: Map<Element, Map<string, string>>;
  /** Elements whose CSS animation follows a scroll position: the copy turns it off and keeps what it showed. */
  readonly scrollDriven: Set<Element>;
  /** Canvases and videos as pictured while on screen. */
  readonly surfaces: Map<Element, string>;
  readonly loops: WeakSet<Element>;
  /** Hidden by the page and left hidden: waited for once, not on every picture after. */
  readonly hiddenAtRest: WeakSet<Element>;
  /** The elements the last walk saw: new ones (a rendering that added some) need walking again. */
  walked: WeakSet<Element> | undefined;
  viewport: string;
}

const memory: PageMemory = {
  overrides: new Map(),
  motion: new Map(),
  scrollDriven: new Set(),
  surfaces: new Map(),
  loops: new WeakSet(),
  hiddenAtRest: new WeakSet(),
  walked: undefined,
  viewport: '',
};

export interface DesignSettled {
  readonly overrides: ReadonlyMap<Element, DesignOverride>;
  readonly motion: ReadonlyMap<Element, ReadonlyMap<string, string>>;
  readonly scrollDriven: ReadonlySet<Element>;
  readonly surfaces: ReadonlyMap<Element, string>;
}

function isEditorPiece(element: Element): boolean {
  return element.closest(EDITOR_PIECES) !== null;
}

/** The writes of the page, as heard while it is waited for. */
class PageWrites {
  readonly touched = new Set<Element>();
  /** When each element's present run of writes began, and its latest write. */
  private readonly runs = new Map<Element, { readonly sinceMs: number; latestMs: number }>();
  private heardMs = 0;
  private heard = 0;

  get latestMs(): number {
    return this.heardMs;
  }

  get count(): number {
    return this.heard;
  }

  hear(records: readonly MutationRecord[]): void {
    const now = performance.now();
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : (record.target.parentElement ?? undefined);
      if (target === undefined || isEditorPiece(target)) {
        continue;
      }
      if (record.type === 'attributes' && this.touched.size < DESIGN_SETTLE_LIMITS.touchedMax) {
        this.touched.add(target);
      }
      if (memory.loops.has(target) || this.loops(target, now)) {
        continue;
      }
      this.heardMs = now;
      this.heard += 1;
    }
  }

  /** Notes a write to `target`, and says whether it has now been written for so long that it loops. */
  private loops(target: Element, now: number): boolean {
    const run = this.runs.get(target);
    if (run === undefined || now - run.latestMs > DESIGN_SETTLE_LIMITS.loopGapMs) {
      if (this.runs.size < DESIGN_SETTLE_LIMITS.touchedMax) {
        this.runs.set(target, { sinceMs: now, latestMs: now });
      }
      return false;
    }
    run.latestMs = now;
    if (now - run.sinceMs <= DESIGN_SETTLE_LIMITS.loopMs) {
      return false;
    }
    memory.loops.add(target);
    return true;
  }
}

/** One animation frame, or 50 ms where the frame is not being drawn. */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

function animationsNow(): readonly Animation[] {
  return typeof document.getAnimations === 'function' ? document.getAnimations().slice(0, DESIGN_SETTLE_LIMITS.animationsMax) : [];
}

function targetOf(animation: Animation): Element | undefined {
  const effect = animation.effect;
  return effect instanceof KeyframeEffect && effect.pseudoElement === null ? (effect.target ?? undefined) : undefined;
}

function followsScroll(animation: Animation): boolean {
  return animation.timeline !== null && !(animation.timeline instanceof DocumentTimeline);
}

/** Every CSS transition and finite animation is taken to its end now; a loop and a scroll timeline are left. */
function finishAnimations(): void {
  for (const animation of animationsNow()) {
    const timing = animation.effect?.getComputedTiming();
    // A paused one is left too: a script may be moving its time by hand.
    if (followsScroll(animation) || timing === undefined || animation.playState !== 'running') {
      continue;
    }
    if (timing.iterations === Infinity || timing.endTime === Infinity || animation.playbackRate === 0) {
      continue;
    }
    try {
      animation.finish();
    } catch {
      // An animation that cannot be finished is left as it is.
    }
  }
}

/** Whether something the page wrote on is still hidden: an entrance that may yet come. */
function hiddenPending(writes: PageWrites): boolean {
  for (const element of writes.touched) {
    if ((element instanceof HTMLElement || element instanceof SVGElement) && !memory.hiddenAtRest.has(element)) {
      if (element.style.opacity === '0' || element.style.visibility === 'hidden') {
        return true;
      }
    }
  }
  return false;
}

function acceptHidden(writes: PageWrites): void {
  for (const element of writes.touched) {
    if ((element instanceof HTMLElement || element instanceof SVGElement) && (element.style.opacity === '0' || element.style.visibility === 'hidden')) {
      memory.hiddenAtRest.add(element);
    }
  }
}

interface Rest {
  readonly quietMs: number;
  readonly deadlineMs: number;
  readonly hidden: 'waited-for' | 'ignored';
}

/** Resolves once the page has written nothing for the quiet asked, or at the deadline. */
async function atRest(writes: PageWrites, rest: Rest): Promise<void> {
  const startMs = performance.now();
  // A frame is at least a few milliseconds, so this many outlast any deadline.
  const framesMax = Math.ceil(DESIGN_SETTLE_LIMITS.walkMsMax / 2);
  for (let frame = 0; frame < framesMax; frame += 1) {
    await nextFrame();
    finishAnimations();
    const now = performance.now();
    if (now >= rest.deadlineMs) {
      return;
    }
    const quietFor = now - Math.max(startMs, writes.latestMs);
    if (frame >= 2 && quietFor >= rest.quietMs) {
      if (rest.hidden === 'ignored' || !hiddenPending(writes)) {
        return;
      }
      if (quietFor >= DESIGN_SETTLE_LIMITS.hiddenQuietMs) {
        acceptHidden(writes);
        return;
      }
    }
  }
}

/** The scroll positions of one walk, top to bottom, `share` of a screen apart. */
export function walkStops(scrollMaxPx: number, screenPx: number, share: number): readonly number[] {
  assert(screenPx > 0, 'A walk is over a screen of some height');
  assert(share > 0, 'A step moves down the page');
  assert(share <= 1, 'A step is at most a screen, so nothing is stepped over');
  const end = Math.max(0, Math.ceil(scrollMaxPx));
  const step = Math.max(1, Math.floor(screenPx * share), Math.ceil(end / (DESIGN_SETTLE_LIMITS.stopsMax - 1)));
  const stops: number[] = [];
  for (let at = 0; at < end && stops.length < DESIGN_SETTLE_LIMITS.stopsMax - 1; at += step) {
    stops.push(at);
  }
  stops.push(end);
  return stops;
}

function scrollMaxPx(): number {
  return Math.max(0, (document.scrollingElement ?? document.documentElement).scrollHeight - window.innerHeight);
}

function scrollPageTo(topPx: number): void {
  window.scrollTo({ left: window.scrollX, top: topPx, behavior: 'instant' });
}

function lookOf(element: Element): DesignAppearance {
  return { style: element.getAttribute('style') ?? undefined, classes: Array.from(element.classList) };
}

/** How far an element's middle is from the screen's, or undefined when it is off screen or too large to read here. */
function distanceFromMiddle(element: Element): number | undefined {
  const box = element.getBoundingClientRect();
  const screen = window.innerHeight;
  if (box.bottom <= 0 || box.top >= screen || box.height > screen * DESIGN_SETTLE_LIMITS.recordScreensMax) {
    return undefined;
  }
  return Math.abs(box.top + box.height / 2 - screen / 2);
}

const KEYFRAME_FIELDS: ReadonlySet<string> = new Set(['offset', 'computedOffset', 'easing', 'composite']);

function cssName(keyframeName: string): string {
  if (keyframeName.startsWith('--')) {
    return keyframeName;
  }
  const named = keyframeName === 'cssFloat' ? 'float' : keyframeName === 'cssOffset' ? 'offset' : keyframeName;
  return named.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Reads what a scroll timeline, or a Web animation that holds its end, shows right now. */
function readMotion(nearest: Map<Element, number>): void {
  for (const animation of animationsNow()) {
    const target = targetOf(animation);
    const effect = animation.effect;
    if (target === undefined || !(effect instanceof KeyframeEffect) || isEditorPiece(target)) {
      continue;
    }
    const scrolls = followsScroll(animation);
    if (!scrolls) {
      // A CSS animation or transition is the copy's own to run to its end; one made by script is not in it.
      const own = animation instanceof CSSAnimation || animation instanceof CSSTransition;
      const fill = effect.getComputedTiming().fill;
      if (own || (fill !== 'forwards' && fill !== 'both') || animation.playState !== 'finished') {
        continue;
      }
    } else {
      const distance = distanceFromMiddle(target);
      if (distance === undefined || (nearest.get(target) ?? Infinity) < distance) {
        continue;
      }
      nearest.set(target, distance);
      memory.scrollDriven.add(target);
    }
    const computed = getComputedStyle(target);
    const values = memory.motion.get(target) ?? new Map<string, string>();
    for (const keyframe of effect.getKeyframes()) {
      for (const field of Object.keys(keyframe)) {
        if (!KEYFRAME_FIELDS.has(field)) {
          const property = cssName(field);
          values.set(property, computed.getPropertyValue(property));
        }
      }
    }
    memory.motion.set(target, values);
  }
}

function surfaces(): readonly (HTMLCanvasElement | HTMLVideoElement)[] {
  return Array.from(document.querySelectorAll<HTMLCanvasElement | HTMLVideoElement>('canvas, video'))
    .filter((element) => !isEditorPiece(element))
    .slice(0, DESIGN_SETTLE_LIMITS.surfacesMax);
}

// Read inside a frame, after the page's own drawing in it: a WebGL picture is gone once the frame is shown. A
// callback asked for from a timer comes after every one the page asked for while drawing the frame before.
function pictureAfterDrawing(element: HTMLCanvasElement | HTMLVideoElement): Promise<string | undefined> {
  return new Promise((resolve) => {
    window.setTimeout(() => {
      const timer = window.setTimeout(() => resolve(canvasPicture(element)), 50);
      requestAnimationFrame(() => {
        window.clearTimeout(timer);
        resolve(canvasPicture(element));
      });
    }, 0);
  });
}

/** Pictures the canvases and videos on screen now that have none yet, or a fainter one. */
async function pictureSurfaces(nearest: Map<Element, number>, deadlineMs: number): Promise<void> {
  for (const element of surfaces()) {
    const distance = distanceFromMiddle(element) ?? (element.getBoundingClientRect().bottom > 0 ? window.innerHeight : undefined);
    const onScreen = element.getBoundingClientRect().top < window.innerHeight && element.getBoundingClientRect().bottom > 0;
    if (distance === undefined || !onScreen || (nearest.get(element) ?? Infinity) <= distance) {
      continue;
    }
    for (let frame = 0; frame < DESIGN_SETTLE_LIMITS.surfaceFramesMax && performance.now() < deadlineMs; frame += 1) {
      const picture = await pictureAfterDrawing(element);
      if (picture !== undefined) {
        memory.surfaces.set(element, picture);
        nearest.set(element, distance);
        break;
      }
    }
  }
}

async function loaded(): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    if (document.readyState === 'complete') {
      resolve();
    } else {
      window.addEventListener('load', () => resolve(), { once: true });
    }
  });
  await Promise.race([
    ready.then(async () => {
      await document.fonts?.ready;
    }),
    new Promise<void>((resolve) => window.setTimeout(resolve, DESIGN_SETTLE_LIMITS.loadMsMax)),
  ]);
}

function viewportKey(): string {
  return `${String(window.innerWidth)}x${String(window.innerHeight)}`;
}

/** Whether the page must be walked: never was, is drawn at another size, or has elements the last walk never saw. */
function walkDue(): boolean {
  const walked = memory.walked;
  if (walked === undefined || memory.viewport !== viewportKey()) {
    return true;
  }
  const elements = document.body.getElementsByTagName('*');
  const scanned = Math.min(elements.length, DESIGN_SNAPSHOT_LIMITS.elementsMax);
  for (let index = 0; index < scanned; index += 1) {
    const element = elements[index];
    if (element !== undefined && !walked.has(element) && !isEditorPiece(element) && !inLoop(element)) {
      return true;
    }
  }
  return false;
}

function inLoop(element: Element): boolean {
  return memory.loops.has(element) || (element.parentElement !== null && memory.loops.has(element.parentElement));
}

function remember(): void {
  const walked = new WeakSet<Element>();
  for (const element of Array.from(document.body.getElementsByTagName('*')).slice(0, DESIGN_SNAPSHOT_LIMITS.elementsMax)) {
    walked.add(element);
  }
  memory.walked = walked;
  memory.viewport = viewportKey();
}

async function walk(writes: PageWrites): Promise<void> {
  const deadlineMs = performance.now() + DESIGN_SETTLE_LIMITS.walkMsMax;
  memory.overrides.clear();
  memory.motion.clear();
  memory.scrollDriven.clear();
  for (const element of memory.surfaces.keys()) {
    if (!element.isConnected) {
      memory.surfaces.delete(element);
    }
  }
  // First, quickly to the bottom, so every trigger on the way fires; then the page is let come to rest.
  for (const stop of walkStops(scrollMaxPx(), window.innerHeight, 0.75)) {
    if (performance.now() < deadlineMs) {
      scrollPageTo(stop);
      await nextFrame();
      await nextFrame();
      finishAnimations();
    }
  }
  await atRest(writes, { quietMs: DESIGN_SETTLE_LIMITS.quietMs, deadlineMs, hidden: 'waited-for' });
  await readOnScreen(writes, deadlineMs);
}

/** The second walk: what each moving element looks like on screen, compared with how it rests afterwards. */
async function readOnScreen(writes: PageWrites, deadlineMs: number): Promise<void> {
  // A page that wrote nothing and has nothing drawn by script or tied to its scroll looks the same everywhere.
  if (writes.count === 0 && surfaces().length === 0 && !animationsNow().some(followsScroll)) {
    return;
  }
  const seen = new Map<Element, Seen>();
  const motionNearest = new Map<Element, number>();
  const surfaceNearest = new Map<Element, number>();
  for (const stop of walkStops(scrollMaxPx(), window.innerHeight, 0.6)) {
    if (performance.now() >= deadlineMs) {
      break;
    }
    scrollPageTo(stop);
    await atRest(writes, {
      quietMs: DESIGN_SETTLE_LIMITS.stepQuietMs,
      deadlineMs: Math.min(deadlineMs, performance.now() + DESIGN_SETTLE_LIMITS.stepMsMax),
      hidden: 'ignored',
    });
    for (const element of writes.touched) {
      const distance = element.isConnected && element !== document.body && element !== document.documentElement ? distanceFromMiddle(element) : undefined;
      if (distance !== undefined && distance < (seen.get(element)?.distance ?? Infinity) && element.closest(PIN_HOLDER) === null) {
        seen.set(element, { distance, look: lookOf(element) });
      }
    }
    readMotion(motionNearest);
    await pictureSurfaces(surfaceNearest, deadlineMs);
  }
  // The rest every copy is taken at is the top of the page, wherever the canvas was scrolled.
  scrollPageTo(0);
  await atRest(writes, { quietMs: DESIGN_SETTLE_LIMITS.quietMs, deadlineMs: deadlineMs + DESIGN_SETTLE_LIMITS.stepMsMax, hidden: 'ignored' });
  readMotion(motionNearest);
  for (const [element, found] of seen) {
    const difference = element.isConnected ? differenceOf(found.look, lookOf(element), parseStyle) : undefined;
    if (difference !== undefined) {
      memory.overrides.set(element, difference);
    }
  }
}

const scratch = (): CSSStyleDeclaration => document.createElement('span').style;

/** A style attribute's declarations, read by the browser's own parser. */
function parseStyle(text: string): ReadonlyMap<string, { readonly value: string; readonly priority: string }> {
  const style = scratch();
  style.cssText = text;
  const declarations = new Map<string, { readonly value: string; readonly priority: string }>();
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index);
    declarations.set(property, { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) });
  }
  return declarations;
}

async function atTop(writes: PageWrites): Promise<void> {
  scrollPageTo(0);
  await atRest(writes, {
    quietMs: DESIGN_SETTLE_LIMITS.stepQuietMs,
    deadlineMs: performance.now() + DESIGN_SETTLE_LIMITS.stepMsMax,
    hidden: 'ignored',
  });
}

export interface DesignRest {
  readonly settled: DesignSettled;
  /** Puts the page back where it was scrolled, once it has been copied. */
  readonly release: () => void;
}

/**
 * Brings the page to rest before it is pictured, walking it first when it has not been walked as it is now.
 * `walking` is 'held' while the person sees the page itself, which is never scrolled under them. The caller makes
 * one copy at a time.
 */
export async function settlePage(walking: 'allowed' | 'held'): Promise<DesignRest> {
  const originPx = window.scrollY;
  const release = (): void => {
    if (window.scrollY !== originPx) {
      scrollPageTo(originPx);
    }
  };
  // Held: the person may be looking at the page, so nothing on it is touched; it is copied as it stands.
  if (walking === 'held') {
    return { settled: memory, release };
  }
  const writes = new PageWrites();
  const observer = new MutationObserver((records) => writes.hear(records));
  observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
  try {
    await loaded();
    if (walkDue()) {
      await walk(writes);
      remember();
    } else {
      await atTop(writes);
    }
  } catch (error: unknown) {
    release();
    throw error;
  } finally {
    observer.disconnect();
  }
  return { settled: memory, release };
}
