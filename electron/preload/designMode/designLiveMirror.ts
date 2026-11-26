// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the panels' live previews, mirrored to a frame.
//
// While a person hovers a value, scrubs a number or drags a colour, the editor shows it by restyling the live canvas
// without saving: an inline style, a stylesheet rule changed in place, or a variable override. None of that is a new
// rendering, and the frame the person sees is a copy. So after each such message from the editor, what the page's
// styles and classes now differ by is reported, and the shown frame is restyled in place. Taking a preview back is a
// message too, and reports the page as it was.
import { DESIGN_SNAPSHOT_LIMITS, type DesignCanvasMessage, type DesignLiveElement, type DesignLiveSheet } from '../../../shared/ipc/designSnapshot';
import { freezeViewportUnits, rebaseCssURLs } from './designSnapshotCss';

/** Ids given to the page's elements and stylesheets, which its snapshots carry, so a report can name them. */
const ids = new WeakMap<Element, number>();
let nextId = 0;

export function liveId(element: Element): number {
  let id = ids.get(element);
  if (id === undefined) {
    nextId += 1;
    id = nextId;
    ids.set(element, id);
  }
  return id;
}

/** The editor's messages that restyle the page without a rendering. */
const PREVIEW_MESSAGE = /^avb:(live-|hover-style|class-patch|optimistic-|hide-pending|move-revert|insert-revert)/;
/** How long after such a message the page may still be restyling because of it. */
const FOLLOW_MS = 400;
/** The editor's own live variable overrides (frameLiveVariables.ts). */
const VARIABLES_STYLE_ID = 'avb-live-variables';

interface Mirror {
  /** Each stylesheet's rules as the frames last had them. */
  readonly sheets: Map<number, string>;
  readonly touched: Set<Element>;
  variables: string;
  until: number;
  scheduled: boolean;
}

const mirror: Mirror = { sheets: new Map(), touched: new Set(), variables: '', until: 0, scheduled: false };
let observer: MutationObserver | undefined;

function sheetOwners(): readonly (HTMLStyleElement | HTMLLinkElement)[] {
  return Array.from(document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style:not([id^="avb-"]), link[rel~="stylesheet"]')).slice(
    0,
    DESIGN_SNAPSHOT_LIMITS.liveSheetsMax,
  );
}

function rulesOf(owner: HTMLStyleElement | HTMLLinkElement): string | undefined {
  try {
    const sheet = owner.sheet;
    return sheet === null ? undefined : Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
  } catch {
    return undefined;
  }
}

/** Remembers the page's stylesheets as they are before any preview: what a change is measured against. */
function baseline(): void {
  mirror.sheets.clear();
  for (const owner of sheetOwners()) {
    const rules = rulesOf(owner);
    if (rules !== undefined) {
      mirror.sheets.set(liveId(owner), rules);
    }
  }
}

function report(): DesignCanvasMessage | undefined {
  const sheets: DesignLiveSheet[] = [];
  let chars = 0;
  for (const owner of sheetOwners()) {
    const id = liveId(owner);
    const rules = rulesOf(owner);
    if (rules === undefined || mirror.sheets.get(id) === rules) {
      continue;
    }
    mirror.sheets.set(id, rules);
    const base = owner instanceof HTMLLinkElement ? owner.href : location.href;
    const css = freezeViewportUnits(rebaseCssURLs(rules, base));
    chars += css.length;
    if (chars <= DESIGN_SNAPSHOT_LIMITS.htmlCharsMax) {
      sheets.push({ id, css });
    }
  }
  const elements: DesignLiveElement[] = [];
  for (const element of mirror.touched) {
    const id = ids.get(element);
    if (id !== undefined && elements.length < DESIGN_SNAPSHOT_LIMITS.liveElementsMax) {
      const style = element.getAttribute('style');
      elements.push({ id, style: style === null ? undefined : freezeViewportUnits(style), className: element.getAttribute('class') ?? undefined });
    }
  }
  mirror.touched.clear();
  const variables = freezeViewportUnits(document.getElementById(VARIABLES_STYLE_ID)?.textContent ?? '');
  const variablesChanged = variables !== mirror.variables;
  mirror.variables = variables;
  if (sheets.length === 0 && elements.length === 0 && !variablesChanged) {
    return undefined;
  }
  return { type: 'stacki:design-live', sheets, elements, variables };
}

/** Frames one preview is followed for: two seconds at 60 a second, past FOLLOW_MS even when frames run slow. */
const FOLLOW_FRAMES_MAX = 120;

// Reported once a frame while a preview may still be settling: the editor's restyling is itself done on the next frame.
async function follow(post: (message: DesignCanvasMessage) => void): Promise<void> {
  if (mirror.scheduled) {
    return;
  }
  mirror.scheduled = true;
  for (let frame = 0; frame < FOLLOW_FRAMES_MAX; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const message = report();
    if (message !== undefined) {
      post(message);
    }
    if (performance.now() >= mirror.until) {
      break;
    }
  }
  mirror.scheduled = false;
  observer?.disconnect();
  observer = undefined;
}

/** Hears one of the editor's messages; a preview among them starts a report of what it changes. */
export function mirrorPreview(type: string, post: (message: DesignCanvasMessage) => void): void {
  if (!PREVIEW_MESSAGE.test(type)) {
    return;
  }
  if (observer === undefined) {
    baseline();
    // Registered before the editor's own handlers have run for this message, so their writes are heard.
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.target instanceof Element && mirror.touched.size < DESIGN_SNAPSHOT_LIMITS.liveElementsMax) {
          mirror.touched.add(record.target);
        }
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'], subtree: true });
  }
  mirror.until = performance.now() + FOLLOW_MS;
  void follow(post);
}
