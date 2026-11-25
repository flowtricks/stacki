// The composer's capture bar, built around the microphone. At rest the row shows only the microphone (`children`,
// the dictation button itself, its click unchanged). Hovering or focusing it grows a bar upward from behind it (its
// height animates, anchored at the microphone's bottom, so the microphone never moves) to reveal Screenshot and
// Record above it, and a pill slides to the segment the pointer or focus is on. Screenshot drags a region and
// photographs it; Record drags a region and records it (RecordingBar.tsx, then FramePicker.tsx). While a recording
// runs the bar stays open with Record red, in every state.
//
// Why it overlays: the bar is absolutely placed and grows over whatever is above it, so it reserves nothing and
// nothing in the composer moves. Closing waits 180 ms (screenshot.css), the hover-intent delay. Closed, Screenshot
// and Record are `visibility: hidden`, neither seen nor tabbable; focusing the microphone opens the bar, so Tab
// reaches them next, and ArrowUp and ArrowDown move between all three. Their tooltips open beside the bar (to its
// inline start, towards the input), so they never cover a segment; Screenshot's names its shortcut.
import { useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { crop as centralCrop, video as centralVideo } from '../../../ui/central/centralGeometry';
import FittedTooltip from '../../../ui/FittedTooltip';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import { ariaKeyShortcuts, currentDesktopPlatform, shortcutLabel } from '../../../lib/shortcutLabel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { SCREENSHOT_SHORTCUT_KEY, type CaptureMode } from './useScreenshotCapture';

const CropGlyph = centralIcon(centralCrop);
const VideoGlyph = centralIcon(centralVideo);

/** The bar's segments from the bottom up, as the document orders them (so Tab goes microphone, Screenshot, Record). */
export const CAPTURE_SEGMENTS = ['mic', 'photo', 'record'] as const;
export type CaptureSegment = (typeof CAPTURE_SEGMENTS)[number];

export function ScreenshotButton({
  disabled,
  busy,
  active,
  onCapture,
  children,
}: {
  readonly disabled: boolean;
  readonly busy: boolean;
  /** The capture under way, if any: `record` keeps the bar open and Record red. */
  readonly active: CaptureMode | undefined;
  readonly onCapture: (kind: CaptureMode) => void;
  /** The microphone button, drawn as the bar's bottom segment exactly as it is. */
  readonly children: ReactNode;
}) {
  const translate = useTranslate();
  const recording = active === 'record';
  const screenshotLabel = translate('ai.screenshot.button');
  const shortcut = shortcutLabel(SCREENSHOT_SHORTCUT_KEY, 'primary-shift', currentDesktopPlatform());
  const recordLabel = translate('ai.record.toggle');
  const tip = useDelayedTooltip();
  const [tipFor, setTipFor] = useState<CaptureMode | undefined>(undefined);
  const [pointed, setPointed] = useState<CaptureSegment | undefined>(undefined);
  const track = useRef<HTMLDivElement>(null);
  // The segment an event came from, by its slot; delegated, so the microphone needs no handler of ours.
  const segmentOf = (target: EventTarget | undefined): CaptureSegment | undefined => {
    const slot = target instanceof Element ? (target.closest<HTMLElement>('[data-segment]') ?? undefined) : undefined;
    const name = slot?.dataset['segment'];
    return CAPTURE_SEGMENTS.find((segment) => segment === name);
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
      return;
    }
    const buttons = [...(track.current?.querySelectorAll<HTMLButtonElement>('[data-segment] button, button[data-segment]') ?? [])].filter(
      (button) => !button.disabled,
    );
    const at = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + (event.key === 'ArrowUp' ? 1 : -1)))];
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  };
  const showTip = (kind: CaptureMode) => (event: MouseEvent<HTMLButtonElement>) => {
    setTipFor(kind);
    tip.show(event);
  };
  const tipText = tipFor === 'photo' ? translate('rail.withShortcut', { label: screenshotLabel, shortcut }) : recordLabel;
  const side = typeof document !== 'undefined' && document.documentElement.dir === 'rtl' ? 'right' : 'left';
  return (
    <span className={`ai-capture-bar${recording ? ' is-recording-mode' : ''}`}>
      <div
        ref={track}
        className="ai-capture-track"
        role="group"
        aria-label={screenshotLabel}
        onKeyDown={onKey}
        onMouseOver={(event) => setPointed(segmentOf(event.target))}
        onMouseLeave={() => setPointed(undefined)}
        onFocus={(event: FocusEvent<HTMLDivElement>) => setPointed(segmentOf(event.target))}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setPointed(undefined);
          }
        }}
      >
        <span className={`ai-capture-thumb${pointed === undefined ? '' : ` is-on-${pointed}`}`} aria-hidden="true" />
        <span className="ai-capture-slot" data-segment="mic">
          {children}
        </span>
        <button
          type="button"
          data-segment="photo"
          className={`ghost ai-capture-segment ai-capture-photo${busy ? ' is-busy' : ''}`}
          aria-label={screenshotLabel}
          aria-keyshortcuts={ariaKeyShortcuts(shortcut)}
          disabled={disabled || busy}
          onClick={() => onCapture('photo')}
          onMouseEnter={showTip('photo')}
          onMouseLeave={tip.hide}
          onBlur={tip.hide}
        >
          <CropGlyph size={14} />
        </button>
        <button
          type="button"
          data-segment="record"
          className={`ghost ai-capture-segment ai-capture-mode${recording ? ' is-on' : ''}`}
          aria-label={recordLabel}
          aria-pressed={recording}
          // While it records it stays enabled (a disabled button would turn grey); a click then does nothing.
          disabled={disabled || (busy && !recording)}
          onClick={() => onCapture('record')}
          onMouseEnter={showTip('record')}
          onMouseLeave={tip.hide}
          onBlur={tip.hide}
        >
          <VideoGlyph size={14} />
        </button>
      </div>
      {tip.value !== undefined &&
        tipFor !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value} preferred={side}>
            {tipText}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </span>
  );
}
