// The one line of text sent right before each screenshot, so the agent knows what the image shows
// without guessing: the capture kind and, for a region of the canvas, the breakpoint width. Nothing more: no
// selector, no styles, no file contents (the agent reads the file itself if it needs more).
//
//   Screenshot 1: region, 768px breakpoint
//   Screenshot 2: panel
//   Screenshot 3: recording frame at 1.2s, region, 1280px breakpoint
//   Screenshot 4: recording frame at 0.4s, panel
//
// The line is for the agent, so it stays English whatever the interface language, as a chip's plain
// text does. It is never stored: the transcript keeps only the attachment's name.
import { assert } from '../../../../shared/core/assert';
import { SCREENSHOT_NOTE_CHARS_MAX } from '../../../../shared/ipc/aiChat';

export type ScreenshotFacts =
  { readonly kind: 'region'; readonly number: number; readonly breakpointPx: number } | { readonly kind: 'panel'; readonly number: number };

/** A frame of a recording: where in the recording it was taken, in milliseconds of capture time. */
export interface RecordingMoment {
  readonly atMs: number;
}

export function screenshotNote(facts: ScreenshotFacts, moment?: RecordingMoment): string {
  assert(Number.isSafeInteger(facts.number), 'screenshotNote: the number is an integer');
  assert(facts.number >= 1, 'screenshotNote: screenshots count from one');
  const head = `Screenshot ${facts.number}: ${moment === undefined ? '' : `recording frame at ${secondsText(moment.atMs)}s, `}${facts.kind}`;
  const line = facts.kind === 'panel' ? head : `${head}, ${breakpoint(facts.breakpointPx)}`;
  assert(line.length <= SCREENSHOT_NOTE_CHARS_MAX, 'screenshotNote: within the wire bound');
  assert(!/\p{Cc}/u.test(line), 'screenshotNote: one line');
  return line;
}

function breakpoint(widthPx: number): string {
  assert(Number.isSafeInteger(widthPx), 'screenshotNote: the breakpoint is whole pixels');
  return `${widthPx}px breakpoint`;
}

/** Seconds to one decimal, for the agent: written the same in every interface language, like the rest of the line. */
export function secondsText(atMs: number): string {
  assert(Number.isSafeInteger(atMs), 'secondsText: whole milliseconds');
  assert(atMs >= 0, 'secondsText: not before the recording began');
  return (Math.round(atMs / 100) / 10).toFixed(1);
}
