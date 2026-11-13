// Aspect ratio: the presets, a width/height pair, and Other, which asks for
// the caret only when it was picked (SizeSection.tsx).

import { useEffect, useRef, useState } from 'react';
import Select, { type SelectOption } from './components/Select';
import useScrub from './components/useScrub';
import VariableConnect from './VariableConnect';
import { commitInPlace } from './model/commitInPlace';
import { useDebouncedLive } from './model/fieldHooks';
import { displayOf, parseImportant } from './model/styleDisplay';
import { type SetProp, type ClearProp, type LiveSetProp, type Props, SizeLabel, withImportant, useFollowingDraft, stepSizeKey } from './SizeKit';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';

// ─────────────────────────── Aspect ratio ───────────────────────────

export const RATIO_PRESETS: ReadonlyArray<{ value: string; labelKey: MessageKey }> = [
  { value: '2.39 / 1', labelKey: 'style.aspectRatioField.anamorphic' },
  { value: '2 / 1', labelKey: 'style.aspectRatioField.univisium' },
  { value: '16 / 9', labelKey: 'style.aspectRatioField.widescreen' },
  { value: '3 / 2', labelKey: 'style.aspectRatioField.landscape' },
  { value: '2 / 3', labelKey: 'style.aspectRatioField.portrait' },
  { value: '1 / 1', labelKey: 'style.aspectRatioField.square' },
];

// Parse an aspect-ratio value into width/height numbers (single number → n/1).
export function parseRatio(value: string): { width: string; height: string } | undefined {
  const text = value.trim().toLowerCase();
  if (!text || text === 'auto') {
    return undefined;
  }
  if (text.includes('/')) {
    const [width, height] = text.split('/').map((part) => part.trim());
    if (width && /^[\d.]+$/.test(width) && (!height || /^[\d.]+$/.test(height))) {
      return { width, height: height || '1' };
    }
    return undefined;
  }
  return /^[\d.]+$/.test(text) ? { width: text, height: '1' } : undefined;
}

// Which dropdown option the value represents: 'auto', a preset value, 'custom'
// (a non-preset numeric ratio → the W:H pair) or 'other' (a free value like
// unset / var(--x) / calc(…) → the plain text field).
export function ratioKeyOf(value: string): string {
  const text = value.trim().toLowerCase();
  if (!text || text === 'auto') {
    return 'auto';
  }
  const parsed = parseRatio(value);
  if (!parsed) {
    return 'other';
  }
  const match = RATIO_PRESETS.find((preset) => preset.value === `${parsed.width} / ${parsed.height}`);
  return match ? match.value : 'custom';
}

// A number-only field (no unit) that live-updates as you type and on ↑/↓.
export function RatioNumberInput({
  value,
  busy,
  ariaLabel,
  onLive,
  onCommit,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const sanitize = (raw: string) => raw.replace(/[^\d.]/g, '');
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: onLive,
    onCommit: commitScrub,
  });

  return (
    <input
      {...scrub.input}
      className="u-input embed-editor_ratio-input"
      value={draft}
      inputMode="decimal"
      onChange={(event) => {
        const next = sanitize(event.target.value);
        setDraft(next);
        onLive(next);
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onCommit(draft);
      }}
      onKeyDown={(event) => {
        const stepped = stepSizeKey(event);
        if (stepped !== undefined) {
          setDraft(stepped);
          onLive(stepped);
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label={ariaLabel}
    />
  );
}

// Free-text value field for the Ratio "Other" mode — mirrors the Display/Overflow
// custom fields. Any value (unset, var(--x), calc(…), …) live-updates as you type
// and commits on blur; emptying it clears the property. Focuses itself when the
// mode is first entered (once the seeding write clears `busy`) — and only then.
export type RatioOtherInputProps = {
  value: string;
  busy: boolean;
  /** The CSS property being edited — filters the variable list to what fits it. */
  prop: string;
  /** Take the caret — true only when this mode was just chosen from the menu. */
  autoFocus?: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
  ariaLabel?: string;
  placeholder?: string;
};

const FREE_VALUE_PLACEHOLDER = 'unset, var(--x)…'; // i18n-ignore: CSS keyword and variable syntax.

export function RatioOtherInput({
  value,
  busy,
  prop,
  autoFocus = false,
  onCommit,
  onLiveCommit,
  onClear,
  ariaLabel,
  placeholder = FREE_VALUE_PLACEHOLDER,
}: RatioOtherInputProps) {
  const translate = useTranslate();
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const { cancelLive, scheduleLive } = useDebouncedLive(onLiveCommit);
  const inputRef = useRef<HTMLInputElement>(null);
  const didFocus = useRef(false);
  const shownLabel = ariaLabel ?? translate('style.aspectRatioField.ratioValue');

  // Only when this field was ASKED for — picking "Other" from the menu, where
  // the next thing anyone does is type. It used to focus on mount whatever
  // brought it here, and the other thing that brings it here is selecting an
  // element whose ratio is already a free value (`var(--_visual-ratio)`): the
  // field appeared, took the caret, and selected its text, so clicking an
  // element on the canvas left you typing into the style panel.
  useEffect(() => {
    if (!autoFocus || didFocus.current || busy) {
      return;
    }
    didFocus.current = true;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [autoFocus, busy]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      onClear();
      return;
    }
    const parsed = parseImportant(trimmed);
    onCommit(parsed.value, parsed.important);
  };

  // Wrapped like every other field in the panel: a `var(--x)` in here is the
  // same thing it is in Width or Gap, and it should read as the same chip. This
  // one was a bare <input>, so the one place a variable is MOST likely to be —
  // the field you land in precisely because the value is not a plain one — was
  // the one place it was shown as raw text.
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.aspectRatioField.connect', { name: shownLabel })}
      disabled={busy}
      prop={prop}
      onPick={(binding) => onCommit(binding, false)}
    >
      <input
        ref={inputRef}
        className="u-select-custom-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          scheduleLive(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          cancelLive();
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={shownLabel}
      />
    </VariableConnect>
  );
}

export const ratioOptions = (translate: Translator): SelectOption<string>[] => [
  { value: 'auto', label: translate('style.aspectRatioField.auto') },
  ...RATIO_PRESETS.map((preset) => ({ value: preset.value, label: translate(preset.labelKey) })),
  { value: 'custom', label: translate('style.aspectRatioField.custom') },
  { value: 'other', label: translate('style.aspectRatioField.other') },
];

export function AspectRatioField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const translate = useTranslate();
  const display = displayOf(read('aspect-ratio'));
  const current = display.present ? display.value : '';
  // A flagged ratio opens the free field ("other"), whose text shows `!important`
  // — the convention of every preset control in the panel.
  const derivedKey = display.important ? 'other' : display.present ? ratioKeyOf(current) : 'auto';
  const { key, askedForOther, onSelect, clear } = useRatioMode({
    current,
    derivedKey,
    setProp,
    clearProp,
  });

  return (
    <>
      <div className="embed-editor_size-row">
        <SizeLabel
          label={translate('style.aspectRatioField.ratio')}
          prop="aspect-ratio"
          display={{ ...display, value: current }}
          contributors={read('aspect-ratio')?.contributors ?? []}
          busy={busy}
          onClear={clear}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <Select
          className="embed-editor_ratio-select"
          value={key}
          options={ratioOptions(translate)}
          ariaLabel={translate('style.aspectRatioField.aspectRatio')}
          disabled={busy}
          onChange={onSelect}
          onPreview={(choice) => liveSetProp('aspect-ratio', choice === 'custom' || choice === 'other' ? undefined : (choice ?? undefined), false)}
          customInput={
            key === 'other' ? (
              <RatioOtherInput
                value={display.present ? withImportant({ ...display, value: current }) : ''}
                busy={busy}
                prop="aspect-ratio"
                autoFocus={askedForOther.current}
                onCommit={(value, important) => setProp('aspect-ratio', value, important)}
                onLiveCommit={(value, important) => liveSetProp('aspect-ratio', value, important)}
                onClear={clear}
              />
            ) : undefined
          }
        />
      </div>
      {key === 'custom' ? <RatioPair current={current} busy={busy} setProp={setProp} liveSetProp={liveSetProp} /> : undefined}
    </>
  );
}

// Which option the ratio dropdown shows. Custom (W:H pair) and Other (free text)
// stick once chosen — even when the value happens to match a preset (1 / 1 vs
// Square) — until a preset/Auto is picked. Everything else derives straight from
// the value.
export function useRatioMode({ current, derivedKey, setProp, clearProp }: { current: string; derivedKey: string; setProp: SetProp; clearProp: ClearProp }) {
  const [forced, setForced] = useState<'custom' | 'other' | undefined>(undefined);
  // Whether "Other" was just chosen here, as opposed to the value simply being
  // one the bar can't show. Only the first of those wants the caret.
  const askedForOther = useRef(false);
  const onSelect = (choice: string) => {
    // "Auto" writes the explicit `aspect-ratio: auto` (the CSS initial value);
    // removing the property is the label's Clear action, not this.
    askedForOther.current = false;
    if (choice === 'auto') {
      setForced(undefined);
      setProp('aspect-ratio', 'auto', false);
      return;
    }
    if (choice === 'custom') {
      setForced('custom');
      const ratio = parseRatio(current);
      setProp('aspect-ratio', ratio ? `${ratio.width} / ${ratio.height}` : '1 / 1', false);
      return;
    }
    if (choice === 'other') {
      setForced('other');
      askedForOther.current = true;
      // Keep an existing free value; otherwise seed with `unset` to type over.
      if (ratioKeyOf(current) !== 'other') {
        setProp('aspect-ratio', 'unset', false);
      }
      return;
    }
    setForced(undefined);
    setProp('aspect-ratio', choice, false);
  };
  const clear = () => {
    setForced(undefined);
    clearProp('aspect-ratio');
  };
  return { key: forced ?? derivedKey, askedForOther, onSelect, clear };
}

// The Custom W:H pair: two number fields that write `W / H` (a blank side as 0).
export function RatioPair({ current, busy, setProp, liveSetProp }: { current: string; busy: boolean; setProp: SetProp; liveSetProp: LiveSetProp }) {
  const translate = useTranslate();
  const parsed = parseRatio(current) ?? { width: '1', height: '1' };
  const write = (width: string, height: string, mode: 'live' | 'commit') => {
    const value = `${width || '0'} / ${height || '0'}`;
    if (mode === 'live') {
      liveSetProp('aspect-ratio', value, false);
    } else {
      setProp('aspect-ratio', value, false);
    }
  };
  return (
    <div className="embed-editor_ratio-custom">
      <div className="embed-editor_ratio-pair">
        <div className="embed-editor_ratio-cell">
          <RatioNumberInput
            value={parsed.width}
            busy={busy}
            ariaLabel={translate('style.aspectRatioField.ratioWidth')}
            onLive={(width) => write(width, parsed.height, 'live')}
            onCommit={(width) => write(width, parsed.height, 'commit')}
          />
          <span className="embed-editor_ratio-caption">{translate('style.aspectRatioField.width')}</span>
        </div>
        <span className="embed-editor_ratio-colon">:</span>
        <div className="embed-editor_ratio-cell">
          <RatioNumberInput
            value={parsed.height}
            busy={busy}
            ariaLabel={translate('style.aspectRatioField.ratioHeight')}
            onLive={(height) => write(parsed.width, height, 'live')}
            onCommit={(height) => write(parsed.width, height, 'commit')}
          />
          <span className="embed-editor_ratio-caption">{translate('style.aspectRatioField.height')}</span>
        </div>
      </div>
    </div>
  );
}
