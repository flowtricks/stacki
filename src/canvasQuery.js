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

let frame = null; // the design canvas's contentWindow
let nextId = 1;
const pending = new Map(); // id -> {resolve, timer, message, held}

// How long to wait for the frame. Long enough for a busy page, short enough
// that a dead frame doesn't stall the panel behind it.
const TIMEOUT_MS = 1500;

const send = (entry) => {
  try {
    frame?.postMessage(entry.message, '*');
    return true;
  } catch {
    return false;
  }
};

export function setCanvasFrame(win) {
  if (frame === win) return;
  frame = win || null;
  // A new document can't answer questions the old one was asked.
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pending.clear();
}

export function hasCanvas() {
  return !!frame;
}

// Ask the page about one node: what it renders as, which of `selectors` target
// it, what `compute` values resolve to on it, and its computed style for `props`.
// Resolves null when the canvas can't answer — the caller then falls back rather
// than treating silence as "no".
export function queryCanvas(path, selectors = [], compute = [], props = []) {
  if (!frame || typeof path !== 'string') return Promise.resolve(null);
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(null);
    }, TIMEOUT_MS);
    const entry = {
      resolve,
      timer,
      message: { type: 'avb:query', id, path, selectors, compute, props },
      held: false,
    };
    pending.set(id, entry);
    if (!send(entry)) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(null);
    }
  });
}

// The page finished mapping its markers — it can answer properly now. Re-send
// everything still outstanding: the questions held below because the page
// wasn't ready, and any that were in flight when a reload swallowed them. A
// re-send carries the original id, so a duplicate answer to one already
// resolved finds no pending entry and is ignored.
export function noteCanvasReady() {
  for (const entry of pending.values()) send(entry);
}

// PreviewPane hands replies over; it already owns the message listener and
// knows which frame they came from.
export function receiveCanvasReply(data) {
  const entry = pending.get(data?.id);
  if (!entry) return;
  // "I don't have that element" from a page that hasn't walked its markers yet
  // means "not yet", and taking it at face value hands the panel a null it then
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
        }
      : null
  );
}
