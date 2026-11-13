// Editing one grid track: its icon and value input, the size editor (a size
// or a minmax), auto-fit, and the popover it opens in (GridSettings.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import type { ReactNode } from 'react';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import VariableConnect from './VariableConnect';
import { handleArrowStep } from './model/numberStep';
import { panelSpan } from './model/panelBox';
import { parseTrackSize, trackKind, type TrackSize } from './model/gridTemplate';
import { WarnIcon } from './GridSettingsKit';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

// Webflow's grid track glyphs: a GEAR for minmax/custom, an "A" for auto/content, and
// a double-arrow for everything else (fr / lengths). The arrow points along the axis
// (↔ columns, ↕ rows) and the faint grid lines flank that same axis.
export const FAINT_ROW = 'M1 1H15V2H1V1ZM1 14H15V15H1V14Z';
export const FAINT_COL = 'M1 1V15H2V1H1ZM14 1V15H15V1H14Z';
export const GEAR_PATH =
  'M7.00002 3.25C7.00002 3.11193 7.11195 3 7.25002 3L8.75002 3' +
  'C8.88809 3 9.00002 3.11193 9.00002 3.25V4.43301' +
  'C9.00002 4.52233 9.04767 4.60486 9.12502 4.64952L10.3391 5.35046' +
  'C10.4164 5.39512 10.5117 5.39512 10.5891 5.35046L11.6136 4.75897' +
  'C11.7331 4.68994 11.886 4.73091 11.9551 4.85048L12.7051 6.14952' +
  'C12.7741 6.26909 12.7331 6.42199 12.6136 6.49103L11.5891 7.08249' +
  'C11.5118 7.12715 11.4641 7.20968 11.4641 7.29899L11.4641 8.70076' +
  'C11.4641 8.79008 11.5118 8.87261 11.5891 8.91727L12.6137 9.50879' +
  'C12.7332 9.57782 12.7742 9.73072 12.7052 9.8503L11.9552 11.1493' +
  'C11.8861 11.2689 11.7332 11.3099 11.6137 11.2408L10.5893 10.6494' +
  'C10.5119 10.6048 10.4166 10.6048 10.3393 10.6494L9.12502 11.3505' +
  'C9.04767 11.3951 9.00002 11.4777 9.00002 11.567V12.75' +
  'C9.00002 12.8881 8.88809 13 8.75002 13H7.25002C7.11195 13 7.00002 12.8881 7.00002 12.75' +
  'V11.567C7.00002 11.4777 6.95237 11.3951 6.87502 11.3505L5.66088 10.6495' +
  'C5.58353 10.6048 5.48823 10.6048 5.41088 10.6495L4.38633 11.241' +
  'C4.26675 11.3101 4.11385 11.2691 4.04482 11.1495L3.29482 9.85048' +
  'C3.22578 9.73091 3.26675 9.57801 3.38633 9.50897L4.41092 8.91742' +
  'C4.48827 8.87277 4.53592 8.79023 4.53592 8.70092V7.29884' +
  'C4.53592 7.20952 4.48827 7.12699 4.41092 7.08233L3.38643 6.49084' +
  'C3.26686 6.4218 3.22589 6.26891 3.29492 6.14933L4.04492 4.85029' +
  'C4.11396 4.73072 4.26686 4.68975 4.38643 4.75879L5.4111 5.35038' +
  'C5.48845 5.39504 5.58375 5.39504 5.6611 5.35038L6.87502 4.64952' +
  'C6.95237 4.60486 7.00002 4.52233 7.00002 4.43301V3.25ZM7.99997 9.5' +
  'C8.82839 9.5 9.49997 8.82843 9.49997 8C9.49997 7.17157 8.82839 6.5 7.99997 6.5' +
  'C7.17154 6.5 6.49997 7.17157 6.49997 8C6.49997 8.82843 7.17154 9.5 7.99997 9.5Z';
export const AUTO_PATH =
  'M8.87418 4H7.12589L4.77295 12H5.8153L6.39552 10.0273H9.6046L10.1848 12H11.2272L8.87418 4' +
  'ZM8.12592 4.9999L9.31048 9.02728H6.68963L7.87416 4.9999H8.12592Z';
export const ARROW_PATH =
  'M8.52731 3.70718L10.6738 5.85363L11.3809 5.14652L8.02731 1.79297L4.67375 5.14652' +
  'L5.38086 5.85363L7.52731 3.70718L7.52731 12.293L5.38086 10.1465L4.67375 10.8536' +
  'L8.02731 14.2072L11.3809 10.8536L10.6738 10.1465L8.52731 12.293L8.52731 3.70718Z';
export function TrackIcon({ track, axis }: { track: string; axis: 'column' | 'row' }) {
  const kind = trackKind(track);
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={axis === 'column' ? FAINT_COL : FAINT_ROW} fill="currentColor" />
      {kind === 'minmax' ? (
        <path fillRule="evenodd" clipRule="evenodd" d={GEAR_PATH} fill="currentColor" />
      ) : kind === 'auto' || kind === 'content' ? (
        <path fillRule="evenodd" clipRule="evenodd" d={AUTO_PATH} fill="currentColor" />
      ) : (
        <path d={ARROW_PATH} fill="currentColor" transform={axis === 'column' ? 'rotate(90 8 8)' : undefined} />
      )}
    </svg>
  );
}

// A single track's value input (default size, or a minmax bound).
export function TrackInput({
  value,
  placeholder,
  ariaLabel,
  busy,
  onCommit,
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  busy: boolean;
  onCommit: (value: string) => void;
}) {
  const translate = useTranslate();
  const [text, setText] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value);
    }
  }, [value]);
  // No onInput: a track list has no preview channel, only the real write, so the drag
  // moves the field's text and writes once on release rather than at pointer speed.
  const commitScrub = (next: string) => {
    setText(next);
    onCommit(next.trim());
  };
  const scrub = useScrub({
    value: text,
    disabled: busy,
    onPreview: setText,
    onCommit: commitScrub,
  });
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.trackEditor.connect', { name: ariaLabel })}
      disabled={busy}
      className="is-fill"
      prop="grid-template-columns"
      onPick={(binding) => onCommit(binding)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={text}
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          onCommit(text.trim());
        }}
        onKeyDown={(event) => {
          const stepped = stepTrackInput(event);
          if (stepped !== undefined) {
            setText(stepped);
            onCommit(stepped.trim());
          }
        }}
      />
    </VariableConnect>
  );
}

// Enter blurs (which commits); ↑/↓ step the number under the caret (unit preserved) in
// place. Returns the stepped text to apply immediately, or undefined.
export function stepTrackInput(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  const input = event.currentTarget;
  if (event.key === 'Enter') {
    input.blur();
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

export const sizingOptions = (translate: Translator): ReadonlyArray<SegmentedOption<'default' | 'minmax'>> => [
  { value: 'default', label: translate('style.trackEditor.sizingDefault') },
  { value: 'minmax', label: translate('style.trackEditor.sizingMinMax') },
];

export type AutoFit = { on: boolean; can: boolean; onToggle: (on: boolean) => void };

// The size a sizing-mode switch writes. When Auto-fit is on the track is
// `repeat(auto-fit, <inner>)`; switching the mode operates on that INNER track and drops
// the wrapper — writing the unwrapped value also unchecks Auto-fit (rawTemplate no
// longer contains repeat(auto-fit, …)), instead of nesting the whole repeat() inside the
// new minmax's max.
export function switchedSize(track: string, mode: 'default' | 'minmax'): TrackSize {
  const match = track.match(/^repeat\(\s*auto-fit\s*,\s*(.+)\)\s*$/is);
  const base = match ? parseTrackSize((match[1] ?? '').trim()) : parseTrackSize(track);
  if (mode === 'minmax') {
    if (base.mode === 'minmax') {
      return base;
    }
    // Min 0px (Webflow's minmax default) so a track can shrink to nothing rather than
    // being held open by its content — matches the count stepper's new-column default.
    // The unit matters: a bare `0` makes Webflow read the grid-template as a custom value.
    return { mode: 'minmax', min: '0px', max: base.value || '1fr' };
  }
  if (base.mode === 'default') {
    return base;
  }
  return { mode: 'default', value: base.max || base.min || 'auto' };
}

// The per-track editor: Default (a single size) or Min/Max (a minmax pair). Track lists
// (not the auto sections) also get the Auto-fit toggle + its constraint warning.
export function TrackSizeEditor({ track, busy, autoFit, onChange }: { track: string; busy: boolean; autoFit?: AutoFit; onChange: (size: TrackSize) => void }) {
  const translate = useTranslate();
  const size = parseTrackSize(track);
  const switchMode = (mode: 'default' | 'minmax') => {
    if (mode !== size.mode) {
      onChange(switchedSize(track, mode));
    }
  };
  return (
    <div className="embed-editor_grid-track-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.trackEditor.sizing')}</span>
        <SegmentedControl
          value={size.mode}
          options={sizingOptions(translate)}
          onChange={switchMode}
          ariaLabel={translate('style.trackEditor.trackSizing')}
          disabled={busy}
        />
      </div>
      <TrackSizeFields size={size} busy={busy} onChange={onChange} />
      {autoFit ? <AutoFitToggle autoFit={autoFit} busy={busy} /> : undefined}
    </div>
  );
}

// Default: one Size field; Min/Max: the two bounds.
export function TrackSizeFields({ size, busy, onChange }: { size: TrackSize; busy: boolean; onChange: (size: TrackSize) => void }) {
  const translate = useTranslate();
  if (size.mode === 'default') {
    return (
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.trackEditor.size')}</span>
        <TrackInput
          value={size.value}
          placeholder="1fr"
          ariaLabel={translate('style.trackEditor.trackSize')}
          busy={busy}
          onCommit={(next) => onChange({ mode: 'default', value: next || 'auto' })}
        />
      </div>
    );
  }
  return (
    <>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.trackEditor.min')}</span>
        <TrackInput
          value={size.min}
          placeholder="auto"
          ariaLabel={translate('style.trackEditor.trackMin')}
          busy={busy}
          onCommit={(next) => onChange({ mode: 'minmax', min: next || 'auto', max: size.max })}
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">{translate('style.trackEditor.max')}</span>
        <TrackInput
          value={size.max}
          placeholder="1fr"
          ariaLabel={translate('style.trackEditor.trackMax')}
          busy={busy}
          onCommit={(next) => onChange({ mode: 'minmax', min: size.min, max: next || '1fr' })}
        />
      </div>
    </>
  );
}

export function AutoFitToggle({ autoFit, busy }: { autoFit: AutoFit; busy: boolean }) {
  const translate = useTranslate();
  return (
    <>
      <label className="embed-editor_grad-check embed-editor_grid-autofit">
        <input
          type="checkbox"
          checked={autoFit.on}
          disabled={busy || (!autoFit.can && !autoFit.on)}
          onChange={(event) => autoFit.onToggle(event.target.checked)}
        />
        <span>{translate('style.trackEditor.autoFit')}</span>
      </label>
      {!autoFit.can && !autoFit.on ? (
        <div className="embed-editor_grid-warning">
          <span className="embed-editor_grid-warning-icon">
            <WarnIcon />
          </span>
          <span>{translate('style.trackEditor.autoFitWarning')}</span>
        </div>
      ) : undefined}
    </>
  );
}

export interface PopoverPosition {
  readonly top: number;
  readonly caretLeft: number;
  readonly below: boolean;
}

// The size editor as an anchored POPUP (Webflow's track popover), not an inline
// accordion — portaled over the modal, positioned below the clicked row (flips above
// when there isn't room), with a caret pointing at it. Closes on outside click /
// Escape / scroll.
export function TrackPopover({ anchorElement, onClose, children }: { anchorElement: HTMLElement; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PopoverPosition | undefined>(undefined);
  // The panel's span, read at mount so the first layout (which measures this
  // popover's height) already has the right width. The anchor lives inside the
  // grid modal — itself portaled — so this falls back to the published box.
  const [span] = useState(() => panelSpan(anchorElement));
  useLayoutEffect(() => {
    const popover = ref.current;
    if (!popover) {
      return;
    }
    setPosition(popoverPosition(anchorElement, popover.offsetHeight, span));
  }, [anchorElement, span]);
  return (
    <Popup
      mode="popover"
      onClose={onClose}
      anchor={anchorElement}
      ref={ref}
      className={`embed-editor_grid-popover ${position && !position.below ? 'is-above' : ''}`}
      role="dialog"
      style={{
        position: 'fixed',
        left: span.left,
        width: span.width,
        top: position?.top ?? 0,
        visibility: position === undefined ? 'hidden' : 'visible',
      }}
    >
      <span className="embed-editor_grid-popover-caret" style={{ left: position?.caretLeft ?? 16 }} aria-hidden="true" />
      {children}
    </Popup>
  );
}

// Below the anchor when the popover fits there, else above it; the caret points at
// the anchor's middle.
export function popoverPosition(anchorElement: HTMLElement, height: number, span: { left: number; width: number }): PopoverPosition {
  const anchor = anchorElement.getBoundingClientRect();
  const gap = 8;
  const below = anchor.bottom + gap + height <= window.innerHeight;
  const top = below ? anchor.bottom + gap : Math.max(gap, anchor.top - gap - height);
  // The caret is absolutely positioned inside the popover, so its x is local
  // to the popover's left edge — not the window's.
  const caretLeft = Math.min(Math.max(anchor.left + anchor.width / 2 - span.left, 16), span.width - 16);
  return { top, caretLeft, below };
}
