// The composer's screenshot state: whether a capture runs (one at a time), the region selector while a
// region is being dragged, and the ⌘⇧S / Ctrl+Shift+S shortcut, which starts the same capture while
// the composer is on screen. A finished capture goes through the same append as a pasted image.
//
// With Record on, the dragged region is recorded instead (RecordingBar.tsx) and, once stopped, the
// "Pick frames" sheet (FramePicker.tsx) turns the chosen frames into ordinary image attachments. The
// recording itself lives in main's memory; whichever way the sheet closes, main is told to free it.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RECORDING_DURATION_MS_MAX, RECORDING_FRAMES_MAX, type RecordedFrame, type RecordStopReason } from '../../../../shared/ipc/aiChat';
import type { Formatters } from '../../../../shared/core/i18n/format';
import type { Translator } from '../../../lib/i18n/localeContext';
import { screenshotSource, type WindowRect } from '../../../lib/screenshotSource';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { aiRecord } from '../aiBridge';
import { requestComposerFocus, type DraftAttachment } from '../aiStore';
import { reportActionToast, reportErrorToast } from '../../../ui/errorNotices';
import { POPUP_MOTION_MS } from '../../../ui/popupLifecycle';
import { FramePicker } from './FramePicker';
import { RecordingBar } from './RecordingBar';
import { RecordScrim } from './RecordScrim';
import { RegionSelector } from './RegionSelector';
import { screenshotNote, secondsText, type ScreenshotFacts } from './screenshotNote';
import { clampToWindow, regionFacts, takeScreenshot } from './takeScreenshot';
import './screenshot.css';

/** The letter of the shortcut, with the platform's primary modifier and Shift (shortcutLabel's `primary-shift`). */
export const SCREENSHOT_SHORTCUT_KEY = 'S';

/** What the next capture is: one photograph, or a recording to pick frames from. */
export type CaptureMode = 'photo' | 'record';

export interface ScreenshotCapture {
  readonly busy: boolean;
  /** The capture under way (from the region drag to the attachment), or undefined. */
  readonly active: CaptureMode | undefined;
  /** Opens the region selector; the finished drag becomes a draft attachment (`photo`) or is recorded (`record`). Nothing records before the drag is committed. */
  readonly start: (kind: CaptureMode) => void;
  /** The region selector, the recording bar or the frame sheet while one is open; each portals to the body. */
  readonly overlay: ReactNode;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording'; readonly id: string; readonly region: WindowRect; readonly restore: () => void }
  | {
      readonly kind: 'picking';
      readonly id: string;
      readonly region: WindowRect;
      readonly frames: readonly RecordedFrame[];
      readonly fps: number;
    };

export function useScreenshotCapture(options: {
  readonly projectPath: string;
  readonly enabled: boolean;
  /** The number the next screenshot takes, read when the capture starts. */
  readonly nextNumber: () => number;
  /** Attachment slots the draft has left, read when the frame sheet opens. */
  readonly slotsLeft: () => number;
  readonly onCaptured: (attachments: readonly DraftAttachment[]) => void;
}): ScreenshotCapture {
  const translate = useTranslate();
  const format = useFormat();
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState<CaptureMode | undefined>(undefined);
  const [picking, setPicking] = useState<((region: WindowRect | undefined) => void) | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The region between the end of the drag and main's answer to `start`: the dim stays up so nothing flashes bright.
  const [starting, setStarting] = useState<WindowRect | undefined>(undefined);
  const running = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  // "Record again" in a toast starts a fresh recording through the same start as the button.
  const again = useRef<() => void>(() => undefined);
  const pickRegion = useCallback(
    (): Promise<WindowRect | undefined> =>
      new Promise((resolve) => {
        setPicking(() => (region: WindowRect | undefined) => {
          setPicking(undefined);
          resolve(region);
        });
      }),
    [],
  );
  const end = useCallback((): void => {
    running.current = false;
    setBusy(false);
    setActive(undefined);
    setPhase({ kind: 'idle' });
    setStarting(undefined);
  }, []);
  const startRecording = useCallback(async (): Promise<void> => {
    const current = latest.current;
    const picked = await pickRegion();
    const region = picked === undefined ? undefined : clampToWindow(picked);
    if (region === undefined) {
      end();
      return;
    }
    setStarting(region);
    const restore = screenshotSource()?.prepare() ?? (() => undefined);
    const started = await aiRecord({ projectPath: current.projectPath, action: { kind: 'start', rect: region } });
    if (!started.ok || started.value.kind !== 'started') {
      restore();
      problemToast(translate('ai.record.failed'));
      end();
      return;
    }
    setPhase({ kind: 'recording', id: started.value.id, region, restore });
    setStarting(undefined);
  }, [pickRegion, end, translate]);
  const start = useCallback(
    (kind: CaptureMode): void => {
      if (running.current || !latest.current.enabled) {
        return;
      }
      running.current = true;
      setBusy(true);
      setActive(kind);
      const current = latest.current;
      if (kind === 'record') {
        void startRecording().catch((error: unknown) => {
          problemToast(error instanceof Error ? error.message : String(error));
          end();
        });
        return;
      }
      void takeScreenshot({ projectPath: current.projectPath, number: current.nextNumber(), pickRegion }, translate)
        .then((outcome) => {
          switch (outcome.kind) {
            case 'captured':
              latest.current.onCaptured([outcome.attachment]);
              focusComposerSoon();
              break;
            case 'failed':
              problemToast(outcome.message);
              break;
            case 'cancelled':
              break;
            default: {
              const exhaustive: never = outcome;
              return exhaustive;
            }
          }
          return undefined;
        })
        .catch((error: unknown) => problemToast(error instanceof Error ? error.message : String(error)))
        .finally(end);
    },
    [translate, pickRegion, startRecording, end],
  );
  again.current = () => start('record');
  const stopRecording = useCallback(
    (id: string, region: WindowRect, reason: RecordStopReason, restore: () => void): void => {
      restore();
      void aiRecord({ projectPath: latest.current.projectPath, action: { kind: 'stop', id } }).then((reply) => {
        if (!reply.ok || reply.value.kind !== 'stopped') {
          problemToast(translate('ai.record.failed'));
          end();
          return undefined;
        }
        // A recording that stopped by itself says why in a toast, never in the sheet.
        const notice = stopNotice(reason, translate, format);
        if (notice !== undefined) {
          reportActionToast(notice, 'warning', []);
        }
        setPhase({ kind: 'picking', id, region, frames: reply.value.frames, fps: reply.value.fps });
        return undefined;
      });
    },
    [translate, format, end],
  );
  const discard = useCallback(
    (id: string): void => {
      void aiRecord({ projectPath: latest.current.projectPath, action: { kind: 'discard', id } });
      end();
    },
    [end],
  );
  const add = useCallback(
    async (id: string, region: WindowRect, chosen: readonly RecordedFrame[]): Promise<void> => {
      const current = latest.current;
      const canvas = screenshotSource()?.canvas();
      const first = current.nextNumber();
      const attachments: DraftAttachment[] = [];
      for (const [offset, frame] of chosen.entries()) {
        const reply = await aiRecord({ projectPath: current.projectPath, action: { kind: 'frame', id, index: frame.index } });
        if (!reply.ok || reply.value.kind !== 'frame') {
          // Gone (freed in main): say so in a toast that offers to record again, and close the sheet.
          reportActionToast(translate('ai.record.gone'), 'error', [{ label: translate('ai.record.again'), run: () => again.current() }]);
          break;
        }
        const facts = regionFacts(region, canvas, first + offset);
        attachments.push(frameAttachment({ frame, image: reply.value.image, facts }, translate, format));
      }
      if (attachments.length > 0) {
        current.onCaptured(attachments);
      }
      discard(id);
      focusComposerSoon();
    },
    [translate, format, discard],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const primary = navigator.platform.includes('Mac') ? event.metaKey : event.ctrlKey;
      if (primary && event.shiftKey && !event.altKey && event.key.toUpperCase() === SCREENSHOT_SHORTCUT_KEY) {
        event.preventDefault();
        start('photo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start]);
  // A composer that goes away (the chat closed) frees a recording it left in main.
  const open = useRef(phase);
  open.current = phase;
  useEffect(
    () => () => {
      const left = open.current;
      if (left.kind !== 'idle') {
        if (left.kind === 'recording') {
          left.restore();
        }
        void aiRecord({ projectPath: latest.current.projectPath, action: { kind: 'discard', id: left.id } });
      }
    },
    [],
  );
  let overlay: ReactNode = picking === undefined ? undefined : <RegionSelector onDone={picking} />;
  if (phase.kind === 'idle' && starting !== undefined) {
    overlay = <RecordScrim region={starting} />;
  } else if (phase.kind === 'recording') {
    overlay = (
      <RecordingBar
        projectPath={options.projectPath}
        id={phase.id}
        region={phase.region}
        onStop={(reason) => stopRecording(phase.id, phase.region, reason, phase.restore)}
      />
    );
  } else if (phase.kind === 'picking') {
    overlay = (
      <FramePicker
        projectPath={options.projectPath}
        id={phase.id}
        frames={phase.frames}
        fps={phase.fps}
        cap={Math.max(0, options.slotsLeft())}
        onGone={() => {
          reportActionToast(translate('ai.record.gone'), 'error', [{ label: translate('ai.record.again'), run: () => again.current() }]);
          discard(phase.id);
        }}
        onAdd={(chosen) => void add(phase.id, phase.region, chosen)}
        onDiscard={() => discard(phase.id)}
      />
    );
  }
  return { busy, active, start, overlay };
}

/** A chosen frame as an ordinary image attachment: "Recording frame 3 (t=1.2s)" and its one-line note. */
export function frameAttachment(
  chosen: {
    readonly frame: RecordedFrame;
    readonly image: { readonly mimeType: 'image/png' | 'image/jpeg'; readonly data: string };
    readonly facts: ScreenshotFacts;
  },
  translate: Translator,
  format: Pick<Formatters, 'formatNumber'>,
): DraftAttachment {
  const { frame, image, facts } = chosen;
  const seconds = format.formatNumber(Number(secondsText(frame.atMs)), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return {
    id: crypto.randomUUID(),
    preview: `data:${image.mimeType};base64,${image.data}`,
    screenshotNumber: facts.number,
    attachment: {
      kind: 'image',
      name: translate('ai.record.frameName', { frame: frame.index + 1, seconds }),
      mimeType: image.mimeType,
      data: image.data,
      note: screenshotNote(facts, { atMs: frame.atMs }),
    },
  };
}

/** What the sheet says when a recording stopped by itself; undefined when the person stopped it. */
function stopNotice(reason: RecordStopReason, translate: Translator, format: Pick<Formatters, 'formatNumber'>): string | undefined {
  switch (reason) {
    case 'person':
    case 'discarded':
      return undefined;
    case 'duration':
      return translate('ai.record.limit.duration', { seconds: format.formatNumber(RECORDING_DURATION_MS_MAX / 1000) });
    case 'frames':
      return translate('ai.record.limit.frames', { count: RECORDING_FRAMES_MAX });
    case 'bytes':
      return translate('ai.record.limit.bytes');
    case 'failed':
      return translate('ai.record.failed');
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}

// Back to typing: once the sheet or the selector has closed (and its focus restore has run), the composer takes the
// keyboard with the caret at the end of its draft, docked or popped out (requestComposerFocus). Two frames, so a
// closing popup's own focus restore comes first; and once more after the popup motion (POPUP_MOTION_MS), when
// something (a dialog's late focus return, the capture bar) still holds the keyboard, so the last word is the
// composer's.
function focusComposerSoon(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      requestComposerFocus();
      setTimeout(() => {
        if (document.activeElement?.closest('.ai-composer .cm-content') === null || document.activeElement === null) {
          requestComposerFocus();
        }
      }, POPUP_MOTION_MS + 40);
    }),
  );
}

// Every problem in the capture flow is a toast, never text in the composer or the sheet (the app's one place for notices).
function problemToast(message: string): void {
  reportErrorToast(message);
}
