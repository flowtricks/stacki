import { centralIcon } from '../../ui/central/CentralIcon';
import { more as centralMore } from '../../ui/central/centralGeometry';
// How an image fills its box: object-fit, with Custom asking for the caret
// only when it was picked, and object-position as a grid, two offsets and a
// modal editor (SizeSection.tsx).

import { useEffect, useRef, useState } from 'react';
import PanelSheet from './components/PanelSheet';
import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip } from './components/CssPropertyTip';
import { HoverTooltip } from './components/SegmentedControl';
import Select, { type SelectOption } from './components/Select';
import useScrub from './components/useScrub';
import VariableConnect from './VariableConnect';
import { splitTopLevelSpaces } from './model/background';
import { displayOf, type Display } from './model/styleDisplay';
import { type SetProp, type ClearProp, type LiveSetProp, type Props, SizeLabel, withImportant, useFollowingDraft, stepSizeKey } from './SizeKit';
import { RatioOtherInput } from './AspectRatioField';

// ─────────────────────── Image fit (object-fit / object-position) ───────────────────────

export const FIT_OPTIONS: SelectOption<string>[] = [
  { value: 'fill', label: 'Fill' },
  { value: 'contain', label: 'Contain' },
  { value: 'cover', label: 'Cover' },
  { value: 'none', label: 'None' },
  { value: 'scale-down', label: 'Scale Down' },
];
export const FIT_CUSTOM = '__custom__';

export const OBJECT_POSITION_PERCENTS = ['0%', '50%', '100%'];
// Which of the 3 grid columns/rows a position token lands on (−1 = a custom offset).
// Empty → center: object-position's initial value is 50% 50%, so an unset position
// reads as centered (unlike background-position, which defaults to the top-left).
export function objectPositionAxis(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (normalized === '' || normalized === 'center' || normalized === '50%') {
    return 1;
  }
  if (normalized === 'left' || normalized === 'top' || normalized === '0' || normalized === '0%' || normalized === '0px') {
    return 0;
  }
  if (normalized === 'right' || normalized === 'bottom' || normalized === '100%') {
    return 2;
  }
  return -1;
}

export const DotsIcon = centralIcon(centralMore);

// A position offset field. The same field the rest of the panel uses — it was its
// own smaller control with a bordered box and an inline "%" chip, which made this
// popup read as a different app. The input holds the RAW value, so any unit works
// (10px, 50%, unset, var(--x)…); a bare number still commits as a percentage, which
// is what the placeholder says.
export function ObjectPositionInput({
  value,
  busy,
  label,
  onLive,
  onCommit,
}: {
  value: string;
  busy: boolean;
  label: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(asPositionOffset(text));
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => onLive(asPositionOffset(text)),
    onCommit: commitScrub,
  });
  return (
    <VariableConnect code ariaLabel={`Connect ${label} to a variable`} disabled={busy} prop="object-position" onPick={(binding) => onCommit(binding)}>
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        placeholder="50%"
        aria-label={label}
        disabled={busy}
        spellCheck={false}
        onChange={(event) => {
          setDraft(event.target.value);
          onLive(asPositionOffset(event.target.value));
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          onCommit(asPositionOffset(draft));
        }}
        onKeyDown={(event) => {
          const stepped = stepSizeKey(event);
          if (stepped !== undefined) {
            setDraft(stepped);
            onLive(asPositionOffset(stepped));
          }
        }}
      />
    </VariableConnect>
  );
}

// A typed offset as written: a bare number is a percentage, anything else (a
// unit, a keyword, a var()) passes through, and blank stays blank.
export function asPositionOffset(typed: string): string {
  const text = typed.trim();
  if (text === '') {
    return '';
  }
  return /^-?[\d.]+$/.test(text) ? `${text}%` : text;
}

// Popup shell over the panel — the same darkening backdrop the transform / shadow
// editors use; closes on backdrop click or Escape.
export function PositionModal({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  return (
    <PanelSheet className="embed-editor_bg-modal embed-editor_pos-modal u-surface-surface" label="Object position" onClose={onClose}>
      {children}
    </PanelSheet>
  );
}

export function ImageFitField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const fit = displayOf(read('object-fit'));
  const positionDisplay = displayOf(read('object-position'));
  const [positionOpen, setPositionOpen] = useState(false);
  const positionRaw = positionDisplay.present ? positionDisplay.value.trim() : '';
  const positionSet = positionRaw !== '' && positionRaw.toLowerCase() !== 'unset';

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel
          label="Image fit"
          prop="object-fit"
          display={fit}
          contributors={read('object-fit')?.contributors ?? []}
          busy={busy}
          onClear={() => clearProp('object-fit')}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <div className="embed-editor_imgfit-controls">
          <ObjectFitSelect fit={fit} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} />
          <ObjectPositionButton busy={busy} positionSet={positionSet} positionOpen={positionOpen} onToggle={() => setPositionOpen((open) => !open)} />
        </div>
      </div>
      {positionOpen ? (
        <PositionModal onClose={() => setPositionOpen(false)}>
          <ObjectPositionEditor
            positionRaw={positionRaw}
            positionSet={positionSet}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            liveSetProp={liveSetProp}
          />
        </PositionModal>
      ) : undefined}
    </>
  );
}

// The "…" button that opens the object-position popup, lit while a position is
// set, with a delayed hover tooltip (the same rich popup the segmented controls
// use).
export function ObjectPositionButton({
  busy,
  positionSet,
  positionOpen,
  onToggle,
}: {
  busy: boolean;
  positionSet: boolean;
  positionOpen: boolean;
  onToggle: () => void;
}) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const tip = useDelayedTip();
  return (
    <>
      <button
        ref={moreRef}
        type="button"
        className={'embed-editor_icon-btn embed-editor_imgfit-more ' + (positionSet ? 'is-active' : '')}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={positionOpen}
        aria-label="Object position settings"
        onClick={() => {
          tip.end();
          onToggle();
        }}
        onMouseEnter={tip.start}
        onMouseLeave={tip.end}
      >
        <DotsIcon />
      </button>
      {tip.open && moreRef.current && !positionOpen ? <HoverTooltip anchor={moreRef.current}>Object position settings</HoverTooltip> : undefined}
    </>
  );
}

// A tooltip that opens after a hover delay and closes the moment the pointer
// leaves (or the anchor is pressed).
export function useDelayedTip() {
  const [open, setOpen] = useState(false);
  const tipTimer = useRef<number | undefined>(undefined);
  const clearTip = () => {
    if (tipTimer.current !== undefined) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = undefined;
    }
  };
  useEffect(() => clearTip, []);
  const start = () => {
    clearTip();
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = undefined;
      setOpen(true);
    }, 400);
  };
  const end = () => {
    clearTip();
    setOpen(false);
  };
  return { open, start, end };
}

// The object-fit dropdown. "Custom" as the last option: seed `unset` and reveal
// a free-text field for any value (a var()/keyword/etc. Webflow doesn't offer in
// the preset list).
export function ObjectFitSelect({
  fit,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  fit: Display;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const [forceCustom, setForceCustom] = useState(false);
  const fitValue = fit.value.trim().toLowerCase();
  const knownFit = FIT_OPTIONS.some((option) => option.value === fitValue);
  // A flagged value opens the custom field, whose text shows `!important`.
  const fitCustom = forceCustom || (fit.present && fitValue !== '' && !knownFit) || fit.important;
  // Chosen from the menu, as opposed to a value the list can't show — the field
  // is the same either way, but only the first wants the caret.
  const askedForCustom = useRef(false);
  const pickFit = (choice: string) => {
    if (choice === FIT_CUSTOM) {
      setForceCustom(true);
      askedForCustom.current = true;
      setProp('object-fit', 'unset', false);
      return;
    }
    askedForCustom.current = false;
    setForceCustom(false);
    setProp('object-fit', choice, false);
  };
  return (
    <Select
      className="embed-editor_imgfit-select"
      value={fitCustom ? FIT_CUSTOM : fit.present ? fitValue : 'fill'}
      options={[...FIT_OPTIONS, { value: FIT_CUSTOM, label: 'Custom' }]}
      ariaLabel="Object fit"
      disabled={busy}
      onChange={pickFit}
      onPreview={(choice) => liveSetProp('object-fit', choice === FIT_CUSTOM ? undefined : (choice ?? undefined), false)}
      customInput={
        fitCustom ? (
          <RatioOtherInput
            value={fit.present ? withImportant(fit) : ''}
            busy={busy}
            prop="object-fit"
            autoFocus={askedForCustom.current}
            ariaLabel="Object fit value"
            onCommit={(value, important) => setProp('object-fit', value, important)}
            onLiveCommit={(value, important) => liveSetProp('object-fit', value, important)}
            onClear={() => {
              setForceCustom(false);
              clearProp('object-fit');
            }}
          />
        ) : undefined
      }
    />
  );
}

// The object-position popup: a 3×3 preset grid beside Left / Top offset fields.
export function ObjectPositionEditor({
  positionRaw,
  positionSet,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  positionRaw: string;
  positionSet: boolean;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const positionParts = splitTopLevelSpaces(positionRaw).filter(Boolean);
  const left = positionParts[0] ?? '';
  const top = positionParts[1] ?? '';
  // A live write only previews a value; a commit of nothing clears the property.
  const writePosition = (value: string, mode: 'live' | 'commit') => {
    if (mode === 'live') {
      if (value) {
        liveSetProp('object-position', value, false);
      }
      return;
    }
    if (value) {
      setProp('object-position', value, false);
    } else {
      clearProp('object-position');
    }
  };
  return (
    <div className="embed-editor_imgfit-pos">
      <FieldLabel
        className="embed-editor_imgfit-pos-label"
        active={positionSet}
        disabled={busy}
        onReset={() => clearProp('object-position')}
        resetLabel="Clear"
        tooltip={<PropTip props={['object-position']} />}
      >
        Position
      </FieldLabel>
      <div className="embed-editor_bg-position">
        <ObjectPositionGrid
          activeColumn={objectPositionAxis(left)}
          activeRow={objectPositionAxis(top)}
          busy={busy}
          onPick={(value) => writePosition(value, 'commit')}
        />
        {/* Divs, not labels. The field these hold is the rich token editor with
          the real <input> hidden behind it — and a <label> hands a click to the
          control it wraps, so clicking into the editor focused that hidden input
          instead and the caret vanished the instant it appeared. The inputs carry
          their own aria-label. */}
        <ObjectPositionFields left={left} top={top} busy={busy} writePosition={writePosition} />
      </div>
    </div>
  );
}

// The Left / Top offset fields. A live edit previews both sides (a blank side as
// 50%); a commit writes both, or clears the position when both are blank.
export function ObjectPositionFields({
  left,
  top,
  busy,
  writePosition,
}: {
  left: string;
  top: string;
  busy: boolean;
  writePosition: (value: string, mode: 'live' | 'commit') => void;
}) {
  return (
    <div className="embed-editor_bg-posfields">
      <div className="embed-editor_bg-posfield">
        <span className="embed-editor_bg-posfield-cap">Left</span>
        <ObjectPositionInput
          value={left}
          busy={busy}
          label="Object position left"
          onLive={(value) => writePosition(`${value || '50%'} ${top || '50%'}`, 'live')}
          onCommit={(value) => writePosition(value || top ? `${value || '50%'} ${top || '50%'}` : '', 'commit')}
        />
      </div>
      <div className="embed-editor_bg-posfield">
        <span className="embed-editor_bg-posfield-cap">Top</span>
        <ObjectPositionInput
          value={top}
          busy={busy}
          label="Object position top"
          onLive={(value) => writePosition(`${left || '50%'} ${value || '50%'}`, 'live')}
          onCommit={(value) => writePosition(left || value ? `${left || '50%'} ${value || '50%'}` : '', 'commit')}
        />
      </div>
    </div>
  );
}

// The 3×3 preset grid: each cell pins the image to that column and row.
export function ObjectPositionGrid({
  activeColumn,
  activeRow,
  busy,
  onPick,
}: {
  activeColumn: number;
  activeRow: number;
  busy: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <div className="embed-editor_bg-posgrid" role="group" aria-label="Object position preset">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((column) => (
          <button
            key={`${row}-${column}`}
            type="button"
            className={'embed-editor_bg-poscell ' + (activeColumn === column && activeRow === row ? 'is-active' : '')}
            disabled={busy}
            aria-label={`${['Left', 'Center', 'Right'][column]} ` + `${['top', 'center', 'bottom'][row]}`}
            onClick={() => onPick(`${OBJECT_POSITION_PERCENTS[column]} ${OBJECT_POSITION_PERCENTS[row]}`)}
          />
        )),
      )}
    </div>
  );
}
