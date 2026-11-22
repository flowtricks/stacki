// Taking one screenshot for the composer: let the person drag the part of the window to photograph, hide the editor's own marks over the canvas
// for the frame of the capture, ask main to photograph it (`ai:screenshot`) and turn the reply into a
// draft attachment with its one-line note. The bytes stay in memory: in the reply, in the draft, in the
// prompt, never in a file or in browser storage.
import { assert } from '../../../../shared/core/assert';
import type { Translator } from '../../../lib/i18n/localeContext';
import { screenshotSource, type CanvasTarget, type WindowRect } from '../../../lib/screenshotSource';
import { aiScreenshot } from '../aiBridge';
import type { DraftAttachment } from '../aiStore';
import { screenshotNote, type ScreenshotFacts } from './screenshotNote';

export type ScreenshotOutcome =
  { readonly kind: 'captured'; readonly attachment: DraftAttachment } | { readonly kind: 'cancelled' } | { readonly kind: 'failed'; readonly message: string };

export interface ScreenshotRequest {
  readonly projectPath: string;
  /** The number this screenshot takes in its draft (nextScreenshotNumber). */
  readonly number: number;
  /** Lets the person drag a region; undefined when they pressed Escape. */
  readonly pickRegion: () => Promise<WindowRect | undefined>;
}

export async function takeScreenshot(request: ScreenshotRequest, translate: Translator): Promise<ScreenshotOutcome> {
  assert(request.number >= 1, 'takeScreenshot: screenshots count from one');
  const source = screenshotSource();
  const picked = await request.pickRegion();
  if (picked === undefined) {
    return { kind: 'cancelled' };
  }
  const facts = regionFacts(picked, source?.canvas(), request.number);
  const shown = clampToWindow(picked);
  if (shown === undefined) {
    return { kind: 'failed', message: translate('ai.screenshot.failed') };
  }
  const restore = source?.hideMarks() ?? (() => undefined);
  let reply: Awaited<ReturnType<typeof aiScreenshot>>;
  try {
    // The marks are hidden by a class; two frames let the compositor paint without them before main photographs.
    await nextPaint();
    reply = await aiScreenshot({ projectPath: request.projectPath, rect: shown });
  } finally {
    restore();
  }
  if (!reply.ok) {
    return { kind: 'failed', message: translate('ai.screenshot.failed') };
  }
  const image = reply.value;
  const name = translate('ai.screenshot.name', { number: request.number, width: image.width, height: image.height });
  return {
    kind: 'captured',
    attachment: {
      id: crypto.randomUUID(),
      preview: `data:${image.mimeType};base64,${image.data}`,
      screenshotNumber: request.number,
      attachment: { kind: 'image', name, mimeType: image.mimeType, data: image.data, note: screenshotNote(facts) },
    },
  };
}

/** A dragged region over the canvas is a canvas region at its breakpoint; anywhere else it shows Stacki's own panels. */
export function regionFacts(region: WindowRect, canvas: CanvasTarget | undefined, number: number): ScreenshotFacts {
  if (canvas !== undefined) {
    const centreX = region.x + region.width / 2;
    const centreY = region.y + region.height / 2;
    const { rect } = canvas;
    if (centreX >= rect.x && centreX < rect.x + rect.width) {
      if (centreY >= rect.y && centreY < rect.y + rect.height) {
        return { kind: 'region', number, breakpointPx: canvas.breakpointPx };
      }
    }
  }
  return { kind: 'panel', number };
}

/** The rect cut to the window and rounded outwards to whole pixels, or undefined when none of it is in the window. */
export function clampToWindow(rect: WindowRect, view: { readonly width: number; readonly height: number } = viewport()): WindowRect | undefined {
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(Math.floor(view.width), Math.ceil(rect.x + rect.width));
  const bottom = Math.min(Math.floor(view.height), Math.ceil(rect.y + rect.height));
  if (right - left < 1) {
    return undefined;
  }
  if (bottom - top < 1) {
    return undefined;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function viewport(): { readonly width: number; readonly height: number } {
  return { width: globalThis.innerWidth, height: globalThis.innerHeight };
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
