// The canvas frames that have their page, and the question asked of them: are you still there? (previewSupervisor.ts,
// electron/preload/frameAlive.ts). A frame registers while it shows a loaded page and leaves when it loads another or
// goes, so a page still on its way is never asked.
//
// Bounded: at most PREVIEW_FRAMES_MAX frames are held (the all-breakpoints canvas draws a handful; one past the cap
// is not asked), and every question is given up after a stated wait, with its listener and timer removed.
import { assert } from '../../../shared/core/assert';

export const PREVIEW_FRAMES_MAX = 16;
/** How long a frame has to answer. A busy page takes a while; a dead one never does. */
export const PREVIEW_FRAME_ANSWER_MS = 3_000;

/** `silent`: at least one loaded frame did not answer. `none`: no frame has a page to ask. */
export type FramesAnswer = 'answered' | 'silent' | 'none';

type FrameElement = () => HTMLIFrameElement | undefined;

const frames = new Map<string, FrameElement>();
let asked = 0;

export function registerPreviewFrame(frameId: string, element: FrameElement): () => void {
  assert(frameId.length > 0, 'A frame id is never empty');
  if (frames.size < PREVIEW_FRAMES_MAX) {
    frames.set(frameId, element);
  }
  assert(frames.size <= PREVIEW_FRAMES_MAX, 'The frames asked are bounded');
  return () => {
    if (frames.get(frameId) === element) {
      frames.delete(frameId);
    }
  };
}

export async function askPreviewFrames(): Promise<FramesAnswer> {
  const windows: Window[] = [];
  for (const element of frames.values()) {
    const target = element()?.contentWindow;
    if (target) {
      windows.push(target);
    }
  }
  if (windows.length === 0) {
    return 'none';
  }
  const answers = await Promise.all(windows.map(askFrame));
  return answers.every(Boolean) ? 'answered' : 'silent';
}

function askFrame(target: Window): Promise<boolean> {
  asked += 1;
  const id = asked;
  return new Promise((resolve) => {
    const finish = (outcome: 'answered' | 'silent'): void => {
      window.removeEventListener('message', receive);
      window.clearTimeout(timer);
      resolve(outcome === 'answered');
    };
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source === target && isAliveReply(event.data, id)) {
        finish('answered');
      }
    };
    window.addEventListener('message', receive);
    const timer = window.setTimeout(() => finish('silent'), PREVIEW_FRAME_ANSWER_MS);
    // The question holds nothing but a number, so it needs no target origin of its own.
    target.postMessage({ type: 'avb:alive', id }, '*');
  });
}

function isAliveReply(data: unknown, id: number): boolean {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  return 'type' in data && data.type === 'avb:alive-reply' && 'id' in data && data.id === id;
}
