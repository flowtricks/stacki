// The editor's half of the canvas, small enough to run in a test page: the real
// message parser (previewMessages.ts) and the real click ladder
// (canvasClickRetry.ts) around one preview iframe, with the gate's token rule
// standing in for main's disk check. test/electron/preload/canvasClickCorpus.test.js
// bundles it into the host page of a real Electron window, so the real preload
// in the iframe and this ladder talk over real postMessage, with Chromium's own
// layout and hit testing in between.
//
// The page reads `window.canvasHost`: what was selected, hovered and noticed.
import { parsePreviewMessage } from '../../src/features/preview/previewMessages';
import { CanvasClickRetry, type CanvasNoticeEvent } from '../../src/features/preview/canvasClickRetry';
import { canvasClickLogText } from '../../src/features/preview/canvasClickLog';

interface Selection {
  readonly path: string | undefined;
  readonly kind: 'node' | 'page';
}

interface HostState {
  token: string | undefined;
  files: readonly string[];
  /** The file the editor has open: a rendering without its stamp shows another page. */
  openFile: string | undefined;
  readonly selections: Selection[];
  readonly hovers: (string | undefined)[];
  readonly notices: CanvasNoticeEvent[];
  readonly problems: string[];
  reloads: number;
  renders: number;
  /** Fresh looks the ladder asked the frame for. */
  queries: number;
}

const HISTORY_MAX = 10_000;
const state: HostState = {
  token: undefined,
  files: [],
  openFile: undefined,
  selections: [],
  hovers: [],
  notices: [],
  problems: [],
  reloads: 0,
  renders: 0,
  queries: 0,
};
Reflect.set(window, 'canvasHost', state);
// The ladder's own log, for a failing check to print.
Reflect.set(window, 'canvasClickLog', canvasClickLogText);

function remember<T>(list: T[], item: T): void {
  list.push(item);
  if (HISTORY_MAX < list.length) {
    list.splice(0, list.length - HISTORY_MAX);
  }
}

const frameElement = document.querySelector('iframe');
if (!(frameElement instanceof HTMLIFrameElement)) {
  throw new Error('Assertion failed: the host page holds the canvas iframe');
}
const canvas = frameElement;
const post = (message: unknown): void => canvas.contentWindow?.postMessage(message, '*');

const ladder = new CanvasClickRetry({
  nowMs: () => performance.now(),
  schedule: (delayMs, run) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  },
  query: (id, x, y) => {
    state.queries += 1;
    post({ type: 'avb:click-query', id, x, y });
  },
  selectPage: () => remember(state.selections, { path: undefined, kind: 'page' }),
  reloadCanvas: () => {
    state.reloads += 1;
    canvas.contentWindow?.location.reload();
  },
  notice: (event) => remember(state.notices, event),
  requestRender: () => post({ type: 'avb:request-render' }),
});

// The frame announces each document's rendering itself, at its DOMContentLoaded,
// which can come before this load event: the token is not reset here, or a
// rendering announced first would be forgotten.
canvas.addEventListener('load', () => {
  ladder.frameReset();
  post({ type: 'avb:track', paths: [], scope: '', focus: '', focusOcc: 0 });
  post({ type: 'avb:request-render' });
});

// The gate's rules a test page can exercise without a disk: the click's token
// is the frame's latest, and the open file is in the rendering.
function judge(
  token: string | undefined,
): { readonly tag: 'current' } | { readonly tag: 'stale'; readonly reason: 'no-render' | 'superseded' | 'unstamped-file'; readonly file: string | undefined } {
  if (state.token === undefined || token === undefined) {
    return { tag: 'stale', reason: 'no-render', file: undefined };
  }
  if (token !== state.token) {
    return { tag: 'stale', reason: 'superseded', file: undefined };
  }
  if (state.openFile !== undefined && !state.files.includes(state.openFile)) {
    return { tag: 'stale', reason: 'unstamped-file', file: state.openFile };
  }
  return { tag: 'current' };
}

// `?drop-renders=N` loses the first N announcements, as an editor whose listener
// mounted late does: the ladder has to ask for the rendering again.
let rendersToDrop = Number(new URLSearchParams(location.search).get('drop-renders') ?? '0');

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== canvas.contentWindow) {
    return;
  }
  const message = parsePreviewMessage(event.data);
  if (message === undefined) {
    return;
  }
  if (message.kind === 'render' && rendersToDrop > 0) {
    rendersToDrop -= 1;
    return;
  }
  switch (message.kind) {
    case 'render':
      state.token = message.render.token;
      state.files = message.render.stamps.map((stamp) => stamp.file);
      state.renders += 1;
      ladder.rendered();
      return;
    case 'render-problem':
      state.token = undefined;
      remember(state.problems, message.problem);
      ladder.renderFailed(message.problem);
      return;
    case 'hover-node':
      if (message.token === state.token || (message.token === undefined && state.token === undefined)) {
        remember(state.hovers, message.path);
      }
      return;
    case 'click-node': {
      let id: number;
      if (message.replay === undefined) {
        id = ladder.begin({ x: message.x, y: message.y });
      } else if (ladder.claimReplay(message.replay)) {
        id = message.replay;
      } else {
        return;
      }
      // Main answers asynchronously; so does this stand-in.
      const token = message.token;
      const path = message.path;
      void Promise.resolve().then(() => {
        if (!ladder.current(id)) {
          return;
        }
        const verdict = judge(token);
        if (verdict.tag === 'current') {
          ladder.succeeded(id);
          remember(state.selections, { path, kind: 'node' });
        } else {
          ladder.failed(id, { kind: 'stale', reason: verdict.reason, file: verdict.file, stamped: undefined });
        }
      });
      return;
    }
    case 'rects':
    case 'node-classes':
    case 'rendered-nodes':
    case 'node-states':
    case 'modifiers':
    case 'open-node':
    case 'context-node':
    case 'canvas-ready':
    case 'guide':
    case 'preview-reload':
    case 'query-result':
    case 'point-result':
    case 'text-marks':
      return; // Measurements and menus: not what this host is about.
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
});

// The canvas loads only once every listener above is in place, so no
// announcement can arrive before the host can hear it (the dropped ones above
// stand in for that race on purpose).
const source = canvas.dataset['src'];
if (source === undefined) {
  throw new Error('Assertion failed: the canvas iframe names its page in data-src');
}
canvas.src = source;
