import Popup from '../../ui/Popup';
import { useEffect, useRef, useState } from 'react';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';
import { ChevronIcon, MenuItem, tooltipArrowStyle } from './components/MenuParts';
import { parseImportant, withImportant } from './model/styleDisplay';

// The value editor for `display`. For values we can represent it shows a
// segmented bar (Block / Flex / Grid + a 4th slot for the inline set, None and
// Contents). For anything else (var(--x), unset, table-cell, …) it shows an
// editable text field. Both
// modes carry a dropdown arrow: from the bar you can jump to inline values or
// "Custom"; from a custom value you can jump back to any built-in.

const PRIMARY = ['block', 'flex', 'grid'] as const;
const INLINE = ['inline-block', 'inline-flex', 'inline-grid', 'inline'] as const;
// The two that leave no box of their own: `none` takes the element and its
// children off the page, `contents` takes only the box, so the children lay out
// as if the element weren't there. Grouped together in the menu because that is
// the question they answer — what happens to this element's own box.
const BOXLESS = ['none', 'contents'] as const;
// 4th-slot values (the inline set + the boxless pair), used to detect the bar's
// 4th segment.
const OTHER = [...INLINE, ...BOXLESS] as const;

const SUPPORTED: ReadonlySet<string> = new Set<string>([...PRIMARY, ...OTHER]);
export const DISPLAY_VALUES: readonly string[] = [...PRIMARY, ...OTHER];

// Compact labels for the bar's narrow 4th segment.
const SHORT: Record<string, string> = {
  none: 'None', // i18n-ignore: CSS display keyword, kept as designers write it.
  contents: 'Contents', // i18n-ignore: CSS display keyword, kept as designers write it.
  inline: 'Inline', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-block': 'In-block', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-flex': 'In-flex', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-grid': 'In-grid', // i18n-ignore: CSS display keyword, kept as designers write it.
};
// Full labels for the dropdown menu.
const FULL: Record<string, string> = {
  none: 'None', // i18n-ignore: CSS display keyword, kept as designers write it.
  contents: 'Contents', // i18n-ignore: CSS display keyword, kept as designers write it.
  inline: 'Inline', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-block': 'Inline-block', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-flex': 'Inline-flex', // i18n-ignore: CSS display keyword, kept as designers write it.
  'inline-grid': 'Inline-grid', // i18n-ignore: CSS display keyword, kept as designers write it.
};

// Delayed hover tooltips per display value (reuses the segmented-control tooltip CSS).
const TOOLTIP_DELAY_MS = 500;
const TOOLTIPS: Record<string, MessageKey> = {
  block: 'style.displayControl.tooltipBlock',
  flex: 'style.displayControl.tooltipFlex',
  grid: 'style.displayControl.tooltipGrid',
  none: 'style.displayControl.tooltipNone',
  contents: 'style.displayControl.tooltipContents',
  'inline-block': 'style.displayControl.tooltipInlineBlock',
  'inline-flex': 'style.displayControl.tooltipInlineFlex',
  'inline-grid': 'style.displayControl.tooltipInlineGrid',
  inline: 'style.displayControl.tooltipInline',
};

const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** True when the display value maps onto the segmented bar (not a free value). */
export function isDisplayValueSupported(value: string): boolean {
  return SUPPORTED.has(value.trim().toLowerCase());
}

// Editable text field for a custom display value, shown next to the arrow.
function CustomValueField({
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

  // Mirror external edits, but never clobber what the user is typing.
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
      aria-label={translate('style.displayControl.value')}
      placeholder={translate('style.displayControl.customValuePlaceholder')}
    />
  );
}

export default function DisplayControl({
  value,
  important,
  busy,
  onCommit,
}: {
  value: string;
  important: boolean;
  busy: boolean;
  onCommit: (value: string, important: boolean) => void;
}) {
  const translate = useTranslate();
  const current = value.trim().toLowerCase();
  // The bar only represents a supported token *without* !important. Anything else
  // — contents, unset, var(--x), or a supported token made !important — is custom.
  const segmented = isDisplayValueSupported(current) && !important;
  const customMode = !segmented;

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  const [open, setOpen] = useState(false);

  // After choosing Custom, focus (and select) the field once its `unset` write
  // settles — the input is disabled mid-save, so we wait for busy to clear.
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy]);

  // Pick a built-in value → the segmented bar. Button mode has no !important, so
  // committing without it also drops any prior !important (back to the buttons).
  const pick = (next: string) => {
    setOpen(false);
    if (next !== current || important) {
      onCommit(next, false);
    }
  };
  // Switch to a free value: default it to `unset`, then focus for typing.
  const enterCustom = () => {
    setOpen(false);
    wantFocus.current = true;
    onCommit('unset', false);
  };

  const tooltip = useSegmentTooltip(rootRef);

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={translate('style.displayControl.display')}>
      {customMode ? (
        <CustomValueField value={value} important={important} busy={busy} inputRef={inputRef} onCommit={onCommit} />
      ) : (
        <DisplaySegments current={current} busy={busy} tooltip={tooltip} pick={pick} />
      )}

      <MenuArrow open={open} busy={busy} onToggle={() => setOpen((value) => !value)} />
      {open ? <DisplayMenu onClose={() => setOpen(false)} customMode={customMode} current={current} pick={pick} enterCustom={enterCustom} /> : undefined}
      <SegmentTooltipBubble tooltip={tooltip} />
    </div>
  );
}

// The menu's open state, closed again on an outside click or Escape.
interface SegmentTooltip {
  readonly hoveredValue: string | undefined;
  readonly arrowRight: number;
  readonly startHover: (segmentValue: string, element: HTMLElement) => void;
  readonly endHover: () => void;
}

// Delayed hover tooltip for the segments (reuses the segmented-control tooltip,
// right-anchored with a down-arrow to the hovered segment).
function useSegmentTooltip(rootRef: React.RefObject<HTMLDivElement>): SegmentTooltip {
  const [hoveredValue, setHoveredValue] = useState<string | undefined>(undefined);
  const [arrowRight, setArrowRight] = useState(0);
  const hoverTimer = useRef<number | undefined>(undefined);
  const clearHoverTimer = () => {
    if (hoverTimer.current !== undefined) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = undefined;
    }
  };
  useEffect(() => clearHoverTimer, []);
  const startHover = (segmentValue: string, element: HTMLElement) => {
    if (!TOOLTIPS[segmentValue]) {
      return;
    }
    clearHoverTimer();
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = undefined;
      const root = rootRef.current;
      if (root) {
        const trackRect = root.getBoundingClientRect();
        const buttonRect = element.getBoundingClientRect();
        setArrowRight(trackRect.right - (buttonRect.left + buttonRect.width / 2));
      }
      setHoveredValue(segmentValue);
    }, TOOLTIP_DELAY_MS);
  };
  const endHover = () => {
    clearHoverTimer();
    setHoveredValue(undefined);
  };
  return { hoveredValue, arrowRight, startHover, endHover };
}

function MenuArrow({ open, busy, onToggle }: { open: boolean; busy: boolean; onToggle: () => void }) {
  const translate = useTranslate();
  return (
    <button
      type="button"
      className="embed-editor_display-arrow"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={translate('style.displayControl.moreOptions')}
      disabled={busy}
      onClick={onToggle}
    >
      <ChevronIcon />
    </button>
  );
}

function SegmentTooltipBubble({ tooltip }: { tooltip: SegmentTooltip }) {
  const translateRich = useTranslateRich();
  if (tooltip.hoveredValue === undefined) {
    return undefined;
  }
  const tooltipKey = TOOLTIPS[tooltip.hoveredValue];
  if (!tooltipKey) {
    return undefined;
  }
  const text = translateRich(tooltipKey, { strong: (content) => <strong>{content}</strong> });
  return (
    <div className="u-segmented-tooltip" role="tooltip" style={tooltipArrowStyle(tooltip.arrowRight)}>
      {text}
      <span className="u-segmented-tooltip-arrow" aria-hidden="true" />
    </div>
  );
}

// The bar: Block / Flex / Grid, then the 4th slot.
function DisplaySegments({ current, busy, tooltip, pick }: { current: string; busy: boolean; tooltip: SegmentTooltip; pick: (next: string) => void }) {
  const isPrimary = PRIMARY.some((value) => value === current);
  // The 4th segment shows the chosen inline/none value, or None as the default.
  const fourth = isPrimary ? 'none' : current;
  return (
    <>
      <SegmentPill />
      {PRIMARY.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={current === option}
          className={`embed-editor_display-seg ${current === option ? 'is-selected' : ''}`}
          disabled={busy}
          onClick={() => {
            tooltip.endHover();
            pick(option);
          }}
          onMouseEnter={(event) => tooltip.startHover(option, event.currentTarget)}
          onMouseLeave={tooltip.endHover}
        >
          {cap(option)}
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={!isPrimary}
        className={`embed-editor_display-seg ${!isPrimary ? 'is-selected' : ''}`}
        disabled={busy}
        onClick={() => {
          tooltip.endHover();
          pick(fourth);
        }}
        onMouseEnter={(event) => tooltip.startHover(fourth, event.currentTarget)}
        onMouseLeave={tooltip.endHover}
      >
        {SHORT[fourth]}
      </button>
    </>
  );
}

function DisplayMenu(props: Parameters<typeof DisplayMenuContent>[0]) {
  return (
    <Popup mode="popover" portal={false} role="menu" className="embed-editor_display-menu" onClose={props.onClose}>
      <DisplayMenuContent {...props} />
    </Popup>
  );
}

function DisplayMenuContent({
  customMode,
  current,
  pick,
  enterCustom,
}: {
  customMode: boolean;
  current: string;
  pick: (next: string) => void;
  enterCustom: () => void;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  return (
    <>
      {customMode ? (
        // From a custom value: offer every built-in to switch back to the bar.
        <>
          {PRIMARY.map((option) => (
            <MenuItem key={option} label={cap(option)} selected={current === option} onClick={() => pick(option)} />
          ))}
          <div className="embed-editor_display-menu-divider" />
          {INLINE.map((option) => (
            <MenuItem key={option} label={FULL[option] ?? cap(option)} selected={current === option} onClick={() => pick(option)} />
          ))}
          <div className="embed-editor_display-menu-divider" />
          {BOXLESS.map((option) => (
            <MenuItem key={option} label={FULL[option] ?? cap(option)} selected={current === option} onClick={() => pick(option)} />
          ))}
        </>
      ) : (
        // From the bar: inline values, None, and an escape hatch to Custom.
        <>
          {INLINE.map((option) => (
            <MenuItem key={option} label={FULL[option] ?? cap(option)} selected={current === option} onClick={() => pick(option)} />
          ))}
          <div className="embed-editor_display-menu-divider" />
          {BOXLESS.map((option) => (
            <MenuItem key={option} label={FULL[option] ?? cap(option)} selected={current === option} onClick={() => pick(option)} />
          ))}
          <div className="embed-editor_display-menu-divider" />
          <MenuItem label={translate('style.displayControl.custom')} selected={false} onClick={enterCustom} />
        </>
      )}
    </>
  );
}
