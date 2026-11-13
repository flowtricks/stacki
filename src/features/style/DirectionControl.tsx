import { centralIcon } from '../../ui/central/CentralIcon';
import {
  arrowDown as centralArrowDown,
  arrowLeft as centralArrowLeft,
  arrowRight as centralArrowRight,
  arrowUp as centralArrowUp,
} from '../../ui/central/centralGeometry';
import Popup from '../../ui/Popup';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';
import { ChevronIcon, tooltipArrowStyle } from './components/MenuParts';
import { parseImportant, withImportant } from './model/styleDisplay';

// The flex Direction / flow control — shown only when `display` is flex. Two fixed
// segments (→ single row, ↓ single column) plus a third slot that shows whichever
// non-standard flow is selected. The chevron opens a grouped menu of every
// direction × wrap combination and a Custom escape hatch (unset / var(), like the
// Display control). Standard picks write the `flex-direction` + `flex-wrap`
// longhands; Custom writes a free `flex-direction` value.

// ─────────────────────────── Icons (from Webflow) ───────────────────────────

const ArrowRightIcon = centralIcon(centralArrowRight);
const ArrowDownIcon = centralIcon(centralArrowDown);
const ArrowLeftIcon = centralIcon(centralArrowLeft);
const ArrowUpIcon = centralIcon(centralArrowUp);
const ROW_WRAP_ICON_FIRST_PATH =
  'M14.207 11.5L10.8535 14.8535L10.1465 14.1465L12.293 12H3V11H12.293L10.1465 8.85352' + 'L10.8535 8.14648L14.207 11.5ZM11 4H3V3H11V4Z';

function RowWrapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ROW_WRAP_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M11 4.20703L4.20703 11H3V10.793L9.79297 4H11V4.20703Z" fill="currentColor" />
    </svg>
  );
}
const ROW_WRAP_REVERSE_ICON_FIRST_PATH =
  'M14.207 4.5L10.8535 1.14648L10.1465 1.85352L12.293 4L3 4L3 5L12.293 5L10.1465 7.14648' + 'L10.8535 7.85351L14.207 4.5ZM11 12L3 12L3 13L11 13L11 12Z';

function RowWrapReverseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ROW_WRAP_REVERSE_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M11 11.793L4.20703 5L3 5L3 5.20703L9.79297 12L11 12L11 11.793Z" fill="currentColor" />
    </svg>
  );
}
const ROW_REVERSE_WRAP_ICON_FIRST_PATH =
  'M1.79297 11.5L5.14648 14.8535L5.85352 14.1465L3.70703 12H13V11H3.70703L5.85352 8.85352' + 'L5.14648 8.14648L1.79297 11.5ZM5 4H13V3H5V4Z';

function RowReverseWrapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ROW_REVERSE_WRAP_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M5 4.20703L11.793 11H13V10.793L6.20703 4H5V4.20703Z" fill="currentColor" />
    </svg>
  );
}
const ROW_REVERSE_WRAP_REVERSE_ICON_FIRST_PATH =
  'M1.79297 4.5L5.14648 1.14649L5.85351 1.85352L3.70703 4L13 4L13 5L3.70703 5L5.85352 7.14648' + 'L5.14648 7.85352L1.79297 4.5ZM5 12L13 12L13 13L5 13L5 12Z';

function RowReverseWrapReverseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={ROW_REVERSE_WRAP_REVERSE_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M5 11.793L11.793 5L13 5L13 5.20703L6.20703 12L5 12L5 11.793Z" fill="currentColor" />
    </svg>
  );
}
const COLUMN_WRAP_ICON_FIRST_PATH =
  'M11.5 14.207L14.8535 10.8535L14.1465 10.1465L12 12.293L12 3L11 3L11 12.293L8.85352 10.1465' + 'L8.14648 10.8535L11.5 14.207ZM4 11L4 3L3 3L3 11L4 11Z';

function ColumnWrapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={COLUMN_WRAP_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M4.20703 11L11 4.20703L11 3L10.793 3L4 9.79297L4 11L4.20703 11Z" fill="currentColor" />
    </svg>
  );
}
const COLUMN_WRAP_REVERSE_ICON_FIRST_PATH =
  'M4.5 14.207L1.14648 10.8535L1.85352 10.1465L4 12.293L4 3L5 3L5 12.293L7.14648 10.1465' + 'L7.85352 10.8535L4.5 14.207ZM12 11L12 3L13 3L13 11L12 11Z';

function ColumnWrapReverseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={COLUMN_WRAP_REVERSE_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M11.793 11L5 4.20703L5 3L5.20703 3L12 9.79297L12 11L11.793 11Z" fill="currentColor" />
    </svg>
  );
}
const COLUMN_REVERSE_WRAP_ICON_FIRST_PATH =
  'M11.5 1.79297L14.8535 5.14648L14.1465 5.85352L12 3.70703L12 13L11 13L11 3.70703' + 'L8.85352 5.85352L8.14648 5.14648L11.5 1.79297ZM4 5L4 13L3 13L3 5L4 5Z';

function ColumnReverseWrapIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={COLUMN_REVERSE_WRAP_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M4.20703 5L11 11.793L11 13L10.793 13L4 6.20703L4 5L4.20703 5Z" fill="currentColor" />
    </svg>
  );
}
const COLUMN_REVERSE_WRAP_REVERSE_ICON_FIRST_PATH =
  'M4.5 1.79297L1.14648 5.14648L1.85352 5.85352L4 3.70703L4 13L5 13L5 3.70703L7.14648 5.85352' + 'L7.85352 5.14648L4.5 1.79297ZM12 5L12 13L13 13L13 5L12 5Z';

function ColumnReverseWrapReverseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={COLUMN_REVERSE_WRAP_REVERSE_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" d="M11.793 5L5 11.793L5 13L5.20703 13L12 6.20703L12 5L11.793 5Z" fill="currentColor" />
    </svg>
  );
}

// ─────────────────────────── Flow model ───────────────────────────

const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];

type Flow = {
  /** Normalized `<direction> [wrap]` key — matches the parent's current-state string. */
  value: string;
  direction: string;
  wrap: string;
  icon: ReactNode;
  /** Menu-item label within its group. */
  labelKey: MessageKey;
  /** The lowercase wrap name used inside the tooltip sentence. */
  tipKey: MessageKey;
  /** A single-row / single-column primary — shown as a fixed segment, and only
   *  listed in the menu while in custom mode (so you can return to it). */
  primary?: boolean;
};

const directionPhraseKey: Record<string, MessageKey> = {
  row: 'style.directionControl.phraseLeftToRight',
  'row-reverse': 'style.directionControl.phraseRightToLeft',
  column: 'style.directionControl.phraseTopToBottom',
  'column-reverse': 'style.directionControl.phraseBottomToTop',
};
const WRAP_NAMES = {
  singleRow: { labelKey: 'style.directionControl.singleRow', tipKey: 'style.directionControl.tipSingleRow' },
  singleColumn: { labelKey: 'style.directionControl.singleColumn', tipKey: 'style.directionControl.tipSingleColumn' },
  wrapDown: { labelKey: 'style.directionControl.wrapDown', tipKey: 'style.directionControl.tipWrapDown' },
  wrapUp: { labelKey: 'style.directionControl.wrapUp', tipKey: 'style.directionControl.tipWrapUp' },
  wrapRight: { labelKey: 'style.directionControl.wrapRight', tipKey: 'style.directionControl.tipWrapRight' },
  wrapLeft: { labelKey: 'style.directionControl.wrapLeft', tipKey: 'style.directionControl.tipWrapLeft' },
} as const satisfies Record<string, { labelKey: MessageKey; tipKey: MessageKey }>;
const flow = (direction: string, wrap: string, icon: ReactNode, name: keyof typeof WRAP_NAMES, primary = false): Flow => ({
  value: wrap === 'nowrap' ? direction : `${direction} ${wrap}`,
  direction,
  wrap,
  icon,
  labelKey: WRAP_NAMES[name].labelKey,
  tipKey: WRAP_NAMES[name].tipKey,
  primary,
});
const tipFor = (option: Flow, translate: Translator) =>
  translate('style.directionControl.stackTip', {
    direction: translate(directionPhraseKey[option.direction] ?? 'style.directionControl.phraseLeftToRight'),
    wrap: translate(option.tipKey),
  });

// The chevron menu, grouped by primary direction. The two `primary` rows double as
// the fixed → / ↓ segments.
const GROUPS: ReadonlyArray<{ headerKey: MessageKey; options: Flow[] }> = [
  {
    headerKey: 'style.directionControl.headerLeftToRight',
    options: [
      flow('row', 'nowrap', <ArrowRightIcon />, 'singleRow', true),
      flow('row', 'wrap', <RowWrapIcon />, 'wrapDown'),
      flow('row', 'wrap-reverse', <RowWrapReverseIcon />, 'wrapUp'),
    ],
  },
  {
    headerKey: 'style.directionControl.headerRightToLeft',
    options: [
      flow('row-reverse', 'nowrap', <ArrowLeftIcon />, 'singleRow'),
      flow('row-reverse', 'wrap', <RowReverseWrapIcon />, 'wrapDown'),
      flow('row-reverse', 'wrap-reverse', <RowReverseWrapReverseIcon />, 'wrapUp'),
    ],
  },
  {
    headerKey: 'style.directionControl.headerTopToBottom',
    options: [
      flow('column', 'nowrap', <ArrowDownIcon />, 'singleColumn', true),
      flow('column', 'wrap', <ColumnWrapIcon />, 'wrapRight'),
      flow('column', 'wrap-reverse', <ColumnWrapReverseIcon />, 'wrapLeft'),
    ],
  },
  {
    headerKey: 'style.directionControl.headerBottomToTop',
    options: [
      flow('column-reverse', 'nowrap', <ArrowUpIcon />, 'singleColumn'),
      flow('column-reverse', 'wrap', <ColumnReverseWrapIcon />, 'wrapRight'),
      flow('column-reverse', 'wrap-reverse', <ColumnReverseWrapReverseIcon />, 'wrapLeft'),
    ],
  },
];
const ALL = GROUPS.flatMap((group) => group.options);
function requiredFlow(value: string): Flow {
  const result = ALL.find((candidate) => candidate.value === value);
  if (result === undefined) {
    throw new Error(`Missing direction flow: ${value}`);
  }
  return result;
}
const ROW = requiredFlow('row');
const COLUMN = requiredFlow('column');
const NONSTANDARD = ALL.filter((option) => !option.primary);
const DEFAULT_THIRD = requiredFlow('row wrap');

const TOOLTIP_DELAY_MS = 500;

// ─────────────────────────── Custom value helpers ───────────────────────────

function CustomField({
  value,
  important,
  busy,
  inputRef,
  onCommit,
}: {
  value: string;
  important: boolean;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onCommit: (value: string, important: boolean) => void;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(withImportant({ value, important }));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(withImportant({ value, important }));
    }
  }, [value, important]);
  const commit = () => {
    const parsed = parseImportant(draft);
    if (parsed.value && (parsed.value !== value.trim() || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important);
    }
  };
  return (
    <input
      ref={inputRef}
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label={translate('style.directionControl.directionValue')}
      placeholder={translate('style.directionControl.customValuePlaceholder')}
    />
  );
}

// ─────────────────────────── Control ───────────────────────────

export default function DirectionControl({
  value,
  rawDirection,
  important,
  busy,
  onCommit,
  onCommitCustom,
}: {
  /** Normalized `<direction> [wrap]` string (standard highlighting). */
  value: string;
  /** Raw `flex-direction` value — a free value (var()/unset/…) triggers custom mode. */
  rawDirection: string;
  important: boolean;
  busy: boolean;
  onCommit: (direction: string, wrap: string) => void;
  onCommitCustom: (value: string, important: boolean) => void;
}) {
  const translate = useTranslate();
  const current = value.trim().toLowerCase() || 'row';
  const direction = rawDirection.trim().toLowerCase();
  // Custom whenever flex-direction is a free value, or carries !important.
  const customMode = important || (direction !== '' && !FLEX_DIRECTIONS.includes(direction));

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestFocus = useFocusOnceReady({ customMode, busy, inputRef });

  const pick = (next: Flow) => {
    setOpen(false);
    if (customMode || next.value !== current) {
      onCommit(next.direction, next.wrap);
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    onCommitCustom('unset', false);
  };
  const tip = useSegmentTip(rootRef);

  return (
    <div
      ref={rootRef}
      className={`embed-editor_display ${customMode ? 'is-custom' : ''}`}
      role="group"
      aria-label={translate('style.directionControl.direction')}
    >
      {customMode ? (
        <CustomField value={rawDirection} important={important} busy={busy} inputRef={inputRef} onCommit={onCommitCustom} />
      ) : (
        <FlowSegments current={current} busy={busy} tip={tip} pick={pick} />
      )}
      <MenuArrow open={open} busy={busy} onToggle={() => setOpen((value) => !value)} />

      {open ? <DirectionMenu onClose={() => setOpen(false)} customMode={customMode} current={current} pick={pick} enterCustom={enterCustom} /> : undefined}
      <SegmentTipBubble tip={tip.shown} />
    </div>
  );
}

function MenuArrow({ open, busy, onToggle }: { open: boolean; busy: boolean; onToggle: () => void }) {
  const translate = useTranslate();
  return (
    <button
      type="button"
      className="embed-editor_display-arrow"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={translate('style.directionControl.moreOptions')}
      disabled={busy}
      onClick={onToggle}
    >
      <ChevronIcon />
    </button>
  );
}

// Focus the custom field once its `unset` write settles (input is disabled mid-save).
// Returns the request to make when entering custom mode.
function useFocusOnceReady({ customMode, busy, inputRef }: { customMode: boolean; busy: boolean; inputRef: React.RefObject<HTMLInputElement> }) {
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy, inputRef]);
  return () => {
    wantFocus.current = true;
  };
}

interface ShownTip {
  readonly text: string;
  readonly arrowRight: number;
}
interface SegmentTip {
  readonly shown: ShownTip | undefined;
  readonly startTip: (text: string, element: HTMLElement) => void;
  readonly endTip: () => void;
}

// Delayed segment tooltip (right-anchored, arrow pointing to the hovered button).
function useSegmentTip(rootRef: React.RefObject<HTMLDivElement>): SegmentTip {
  const [shown, setShown] = useState<ShownTip | undefined>(undefined);
  const tipTimer = useRef<number | undefined>(undefined);
  const clearTipTimer = () => {
    if (tipTimer.current !== undefined) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = undefined;
    }
  };
  useEffect(() => clearTipTimer, []);
  const startTip = (text: string, element: HTMLElement) => {
    clearTipTimer();
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = undefined;
      const root = rootRef.current;
      if (!root) {
        return;
      }
      const track = root.getBoundingClientRect();
      const button = element.getBoundingClientRect();
      setShown({ text, arrowRight: track.right - (button.left + button.width / 2) });
    }, TOOLTIP_DELAY_MS);
  };
  const endTip = () => {
    clearTipTimer();
    setShown(undefined);
  };
  return { shown, startTip, endTip };
}

function SegmentTipBubble({ tip }: { tip: ShownTip | undefined }) {
  if (tip === undefined) {
    return undefined;
  }
  return (
    <div className="u-segmented-tooltip" role="tooltip" style={tooltipArrowStyle(tip.arrowRight)}>
      {tip.text}
      <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
    </div>
  );
}

// The two fixed segments (→ single row, ↓ single column) and the third slot.
function FlowSegments({ current, busy, tip, pick }: { current: string; busy: boolean; tip: SegmentTip; pick: (next: Flow) => void }) {
  const translate = useTranslate();
  const thirdMatch = NONSTANDARD.find((option) => option.value === current);
  const third = thirdMatch ?? DEFAULT_THIRD;
  const segment = (option: Flow, selection: { readonly active: boolean }) => (
    <button
      type="button"
      role="radio"
      aria-checked={selection.active}
      className={`embed-editor_display-seg ${selection.active ? 'is-selected' : ''}`}
      disabled={busy}
      aria-label={tipFor(option, translate)}
      onClick={() => {
        tip.endTip();
        pick(option);
      }}
      onMouseEnter={(event) => tip.startTip(tipFor(option, translate), event.currentTarget)}
      onMouseLeave={tip.endTip}
    >
      {option.icon}
    </button>
  );
  return (
    <>
      <SegmentPill />
      {segment(ROW, { active: current === ROW.value })}
      {segment(COLUMN, { active: current === COLUMN.value })}
      {segment(third, { active: !!thirdMatch })}
    </>
  );
}

// The grouped menu. It mounts only while open, so the hovered option (the footer's
// subject) starts empty each time it opens.
function DirectionMenu(props: Parameters<typeof DirectionMenuContent>[0]) {
  return (
    <Popup mode="popover" portal={false} role="menu" className="embed-editor_direction-menu" onClose={props.onClose}>
      <DirectionMenuContent {...props} />
    </Popup>
  );
}

function DirectionMenuContent({
  customMode,
  current,
  pick,
  enterCustom,
}: {
  customMode: boolean;
  current: string;
  pick: (next: Flow) => void;
  enterCustom: () => void;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const [hovered, setHovered] = useState<Flow | undefined>(undefined);
  return (
    <>
      {GROUPS.map((group) => {
        // Primaries (single row / single column) live on the segments; only surface
        // them in the menu while in custom mode, so there's a way back to them.
        const options = customMode ? group.options : group.options.filter((option) => !option.primary);
        return (
          <div className="embed-editor_direction-group" key={group.headerKey}>
            <div className="embed-editor_direction-header">{translate(group.headerKey)}</div>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={!customMode && current === option.value}
                className={'embed-editor_direction-item ' + (!customMode && current === option.value ? 'is-selected' : '')}
                onClick={() => pick(option)}
                onMouseEnter={() => setHovered(option)}
                onMouseLeave={() => setHovered(undefined)}
              >
                <span className="embed-editor_direction-item-icon">{option.icon}</span>
                <span>{translate(option.labelKey)}</span>
              </button>
            ))}
          </div>
        );
      })}
      <div className="embed-editor_direction-group">
        <button
          type="button"
          role="menuitemradio"
          aria-checked={customMode}
          className={`embed-editor_direction-item ${customMode ? 'is-selected' : ''}`}
          onClick={enterCustom}
          onMouseEnter={() => setHovered(undefined)}
        >
          <span className="embed-editor_direction-item-icon" />
          <span>{translate('style.directionControl.custom')}</span>
        </button>
      </div>
      <div className="embed-editor_direction-footer">
        {hovered ? (
          <>
            <code>flex-direction: {hovered.direction}</code>
            <code>flex-wrap: {hovered.wrap}</code>
          </>
        ) : (
          translate('style.directionControl.hoverHint')
        )}
      </div>
    </>
  );
}
