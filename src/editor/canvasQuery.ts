import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { parseCanvasReply, type CanvasAnswer } from './canvasReply';
export const CANVAS_LIMITS = { pendingMax: 1024 } as const;
interface QueryMessage {
  readonly type: 'avb:query';
  readonly id: number;
  readonly path: string;
  readonly selectors: readonly string[];
  readonly compute: readonly string[];
  readonly props: readonly string[];
  readonly textParentPath?: string;
  readonly pageMetadata?: boolean;
  readonly pageText?: boolean;
  readonly winning?: readonly string[];
  readonly scoped?: boolean;
}
interface PendingQuery {
  readonly resolve: (answer: CanvasAnswer | undefined) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly message: QueryMessage;
  held: boolean;
}

// Asking the rendered page what it actually is.
//
// The style panel's own matcher walks the app's source tree, which cannot see
// past a component's edge — `.section > *` misses an element whose `.section`
// parent is what a component renders, and a class added by a script or by
// `class:list` at runtime doesn't exist there at all. The canvas iframe has
// the real DOM, with `data-avb-p` mapping each rendered element back to its
// node, so the answers can come from Chromium's own selector engine instead.
//
// PreviewPane registers its frame here; the style panel's host adapter asks
// through `queryCanvas`. Everything degrades to the source matcher when the
// preview isn't up (no dev server, an errored page, a frame still loading).

let frame: Pick<Window, 'postMessage'> | undefined = undefined; // the canvas's contentWindow
let nextId = 1;
const pending = new Map<number, PendingQuery>(); // id -> {resolve, timer, message, held}

// How long to wait for the frame. Long enough for a busy page, short enough
// that a dead frame doesn't stall the panel behind it.
const TIMEOUT_MS = 1500;

const send = (entry: PendingQuery): boolean => {
  try {
    frame?.postMessage(entry.message, '*');
    return true;
  } catch {
    return false;
  }
};

export function setCanvasFrame(target: Pick<Window, 'postMessage'> | undefined): void {
  if (frame === target) {
    return;
  }
  frame = target || undefined;
  // A new document can't answer questions the old one was asked.
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve(undefined);
  }
  pending.clear();
}

export function hasCanvas(): boolean {
  return !!frame;
}

/** Ask the canvas to send its page reports again (rendered nodes, states,
 *  classes), after the app dropped the ones it held. */
export function requestCanvasReports(): boolean {
  return tellCanvas({ type: 'avb:resend-reports' });
}

/** Say something to the canvas that needs no answer. */
export function tellCanvas(message: unknown): boolean {
  try {
    frame?.postMessage(message, '*');
    return !!frame;
  } catch {
    return false;
  }
}

// Ask the page about one node: what it renders as, which of `selectors` target
// it, what `compute` values resolve to on it, and its computed style for `props`.
// Resolves undefined when the canvas can't answer — the caller then falls back rather
// than treating silence as "no".
export function queryCanvas(
  path: string,
  selectors: readonly string[] = [],
  compute: readonly string[] = [],
  props: readonly string[] = [],
  context: {
    readonly textParentPath?: string;
    readonly pageMetadata?: boolean;
    readonly pageText?: boolean;
    /** Custom properties whose winning declaration is wanted, traced up the element's parents. */
    readonly winning?: readonly string[];
    /** Also report the custom properties declared in scope of the element (its rules' and its parents'). */
    readonly scoped?: boolean;
  } = {},
): Promise<CanvasAnswer | undefined> {
  if (!frame || typeof path !== 'string') {
    return Promise.resolve(undefined);
  }
  if (pending.size >= CANVAS_LIMITS.pendingMax) {
    return Promise.resolve(undefined);
  }
  assert(Number.isSafeInteger(nextId), 'Canvas query ID must remain a safe integer');
  assert(path.length <= LIMITS.attrCharsMax, 'Canvas query path exceeds limit');
  assert((context.textParentPath?.length ?? 0) <= LIMITS.attrCharsMax, 'Canvas text parent path exceeds limit');
  for (const values of [selectors, compute, props, context.winning ?? []]) {
    assert(values.length <= LIMITS.scanEntriesMax, 'Canvas query list exceeds limit');
    for (const value of values) {
      assert(value.length <= LIMITS.attrCharsMax, 'Canvas query value exceeds limit');
    }
  }
  const id = nextId++;
  return new Promise<CanvasAnswer | undefined>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(undefined);
    }, TIMEOUT_MS);
    const entry: PendingQuery = {
      resolve,
      timer,
      message: { type: 'avb:query', id, path, selectors, compute, props, ...context },
      held: false,
    };
    pending.set(id, entry);
    if (!send(entry)) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(undefined);
    }
  });
}

// The page finished mapping its markers — it can answer properly now. Re-send
// everything still outstanding: the questions held below because the page
// wasn't ready, and any that were in flight when a reload swallowed them. A
// re-send carries the original id, so a duplicate answer to one already
// resolved finds no pending entry and is ignored.
//
// A ready page is a new page: whatever was cached about the last one is stale.
// Caches register here (onCanvasReady) rather than being cleared by the
// preview, which then needs to know no reader of the canvas.
export function noteCanvasReady(): void {
  for (const entry of pending.values()) {
    send(entry);
  }
  for (const listener of readyListeners) {
    listener();
  }
}

const readyListeners = new Set<() => void>();

export function onCanvasReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => {
    readyListeners.delete(listener);
  };
}

// PreviewPane hands replies over; it already owns the message listener and
// knows which frame they came from.
export function receiveCanvasReply(input: unknown): void {
  const parsed = parseCanvasReply(input);
  if (!parsed.ok) {
    return;
  }
  const data = parsed.value;
  const entry = pending.get(data?.id);
  if (!entry) {
    return;
  }
  // "I don't have that element" from a page that hasn't walked its markers yet
  // means "not yet", and taking it at face value hands the panel an absence it then
  // only corrects on its next 1.5s poll. Hold the question instead — the page
  // announces when it's ready and noteCanvasReady re-sends it. Held once, so a
  // page that never gets there falls back on the timeout as before.
  if (!data.found && data.ready === false && !entry.held) {
    entry.held = true;
    return;
  }
  clearTimeout(entry.timer);
  pending.delete(data.id);
  entry.resolve(
    data.found
      ? {
          identity: data.identity,
          matched: data.matched || {},
          computed: data.computed || {},
          computedProps: data.computedProps || {},
          authoredProps: data.authoredProps || {},
          inheritedSources: data.inheritedSources || {},
          winning: data.winning || {},
          scoped: data.scoped || {},
          ...(data.pageImage === undefined ? {} : { pageImage: data.pageImage }),
          ...(data.pageType === undefined ? {} : { pageType: data.pageType }),
          ...(data.pageText === undefined ? {} : { pageText: data.pageText }),
        }
      : undefined,
  );
}
