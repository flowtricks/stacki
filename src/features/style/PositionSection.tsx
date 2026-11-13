import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import Select from './components/Select';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import { useHighlight } from './model/computedStyle';
import useScrub from './components/useScrub';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import { SpacingFill, useSpacingBox } from './SpacingBox';
import { handleArrowStep } from './model/numberStep';
import type { ResolvedProp } from './model/resolved';
import { commitInPlace } from './model/commitInPlace';
import { displayText, keepImportant, parseImportant, withImportant } from './model/styleDisplay';
import { CloseIcon, RelativeIcon, AbsoluteIcon, FixedIcon, StickyIcon } from './PositionIcons';
import { type SetProp, type ClearProp, type LiveSetProp, type Read, type Props, SegmentedIconControl, floatSegments, clearSegments } from './PositionSegments';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';

// The Position section: a position-type dropdown (with a Custom escape hatch), an
// inset box (top/right/bottom/left, like the spacing box), a z-index field, and
// Float + Clear segmented controls (each with a chevron menu → Custom). All controls
// read the resolved model and write the picked selector, live as you type.

// ─────────────────────────── Helpers ───────────────────────────

type Display = { present: boolean; value: string; important: boolean };
function displayOf(resolved: ResolvedProp | undefined): Display {
  if (!resolved) {
    return { present: false, value: '', important: false };
  }
  const source = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return { present: true, value: source.value, important: source.important };
}
const effectiveValue = (read: Read, prop: string) => displayOf(read(prop)).value.trim().toLowerCase();
// What a Float / Clear bar compares against its segments: the value with its
// flag, so a flagged value matches none and the bar opens its custom field,
// which shows `!important` (the convention of every segmented bar here).
const effectiveText = (read: Read, prop: string) =>
  displayText(displayOf(read(prop)))
    .trim()
    .toLowerCase();

// ─────────────────────────── Live text field ───────────────────────────

// A plain inline input that live-updates as you type/step and commits (or clears) on
// blur — shared by the inset sides and z-index.
function LiveField({
  prop,
  placeholder,
  ariaLabel,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  placeholder: string;
  ariaLabel: string;
} & Props) {
  const translate = useTranslate();
  const display = displayOf(read(prop));
  const external = display.present ? withImportant(display) : '';
  const field = useLiveFieldEditing({ prop, external, busy, setProp, clearProp, liveSetProp });
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.positionSection.connect', { name: ariaLabel })}
      disabled={busy}
      prop={prop}
      onPick={(binding) => {
        const kept = keepImportant(binding, display);
        setProp(prop, kept.value, kept.important);
      }}
    >
      <input
        {...field.scrub.input}
        className="u-input embed-editor_position-input"
        value={field.draft}
        placeholder={placeholder}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => field.change(event.target.value)}
        onFocus={field.focus}
        onBlur={field.blur}
        onKeyDown={field.keyDown}
        aria-label={ariaLabel}
      />
    </VariableConnect>
  );
}

// The live field's editing state: a draft that follows the model while nobody
// is typing, live writes while someone is, and the commit (or clear) on blur.
function useLiveFieldEditing({
  prop,
  external,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  external: string;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
}) {
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(external);
    }
  }, [external]);
  const { cancel, liveNow, live } = useDebouncedLiveWrite(prop, liveSetProp);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => {
      setDraft(text);
      commit(text);
    },
  });
  return {
    draft,
    scrub,
    change: (text: string) => {
      setDraft(text);
      live(text);
    },
    focus: () => {
      focused.current = true;
    },
    blur: () => {
      focused.current = false;
      cancel();
      commit();
    },
    keyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      const stepped = stepLiveFieldKey(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        live(stepped);
      }
    },
  };
}

// Live writes of typed text on a debounce; `liveNow` is the undelayed write for
// the scrub, which throttles its own — see useScrub.
function useDebouncedLiveWrite(prop: string, liveSetProp: LiveSetProp) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => cancel, []);
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    const parsed = parseImportant(trimmed);
    liveSetProp(prop, parsed.value, parsed.important);
  };
  const live = (text: string) => {
    cancel();
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      liveNow(text);
    }, 100);
  };
  return { cancel, liveNow, live };
}

// Enter commits in place; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepLiveFieldKey(event: ReactKeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    commitInPlace(event.currentTarget);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// ─────────────────────────── Position dropdown ───────────────────────────

const POSITION_PRESETS: ReadonlyArray<{ value: string; label: string; icon: ReactNode }> = [
  // The labels are the CSS position keywords, which designers read untranslated.
  { value: 'static', label: 'Static', icon: <CloseIcon /> }, // i18n-ignore: CSS keyword.
  { value: 'relative', label: 'Relative', icon: <RelativeIcon /> }, // i18n-ignore: CSS keyword.
  { value: 'absolute', label: 'Absolute', icon: <AbsoluteIcon /> }, // i18n-ignore: CSS keyword.
  { value: 'fixed', label: 'Fixed', icon: <FixedIcon /> }, // i18n-ignore: CSS keyword.
  { value: 'sticky', label: 'Sticky', icon: <StickyIcon /> }, // i18n-ignore: CSS keyword.
];
const POSITION_PRESET_VALUES = new Set(POSITION_PRESETS.map((preset) => preset.value));
const CUSTOM = '__custom__';

// The editable field shown inside the position dropdown's trigger in custom mode.
function PositionCustomField({ read, busy, setProp }: { read: Read; busy: boolean; setProp: SetProp }) {
  const translate = useTranslate();
  const display = displayOf(read('position'));
  const external = display.present ? withImportant(display) : '';
  const [draft, setDraft] = useState(external);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(external);
    }
  }, [external]);
  const commit = () => {
    const parsed = parseImportant(draft);
    const changed = parsed.value !== display.value.trim() || parsed.important !== display.important;
    if (parsed.value && changed) {
      setProp('position', parsed.value, parsed.important);
    }
  };
  return (
    <VariableConnect
      ariaLabel={translate('style.positionSection.connectPosition')}
      disabled={busy}
      prop="position"
      onPick={(binding) => {
        const kept = keepImportant(binding, display);
        setProp('position', kept.value, kept.important);
      }}
    >
      <input
        className="embed-editor_value-input embed-editor_display-input"
        value={draft}
        placeholder={translate('style.positionSection.customValuePlaceholder')}
        spellCheck={false}
        disabled={busy}
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
        aria-label={translate('style.positionSection.positionValue')}
      />
    </VariableConnect>
  );
}

function PositionControl({ read, busy, setProp, liveSetProp }: { read: Read; busy: boolean; setProp: SetProp; liveSetProp: LiveSetProp }) {
  const translate = useTranslate();
  const current = effectiveValue(read, 'position');
  const isPreset = POSITION_PRESET_VALUES.has(current);
  // Unset → what the page computes (a `*` rule the panel can't see, a UA default),
  // then `static`.
  const shownPosition = useHighlight(
    current,
    'position',
    POSITION_PRESETS.map((preset) => preset.value),
    'static',
  );
  // Custom whenever position is a free value (var()/unset/…) or !important, or the user
  // explicitly entered custom (kept until a preset is picked).
  const [forceCustom, setForceCustom] = useState(false);
  // …or until the property goes away. Picking Custom seeds `unset`, so custom mode
  // survives on that value; clearing it from the row label leaves nothing for the
  // free-value field to be about, and it read as "custom value" over an empty field.
  useEffect(() => {
    if (!current) {
      setForceCustom(false);
    }
  }, [current]);
  const custom = forceCustom || (!!current && !isPreset) || displayOf(read('position')).important;
  return (
    <Select
      className="embed-editor_position-select"
      value={custom ? CUSTOM : shownPosition}
      options={[
        ...POSITION_PRESETS.map((preset) => ({
          value: preset.value,
          label: preset.label,
          icon: preset.icon,
        })),
        { value: CUSTOM, label: translate('style.positionSection.custom') },
      ]}
      customInput={custom ? <PositionCustomField read={read} busy={busy} setProp={setProp} /> : undefined}
      disabled={busy}
      onChange={(next) => {
        if (next === CUSTOM) {
          setForceCustom(true);
          setProp('position', 'unset', false);
        } else {
          setForceCustom(false);
          setProp('position', next, false);
        }
      }}
      onPreview={(next) => liveSetProp('position', next === CUSTOM ? undefined : (next ?? undefined), false)}
      ariaLabel={translate('style.positionSection.position')}
    />
  );
}

// ─────────────────────────── Inset box (top/right/bottom/left) ───────────────────────────

// ─────────────────────────── Inset presets ───────────────────────────
//
// Pinning a positioned element to a corner, an edge, or the whole box is four
// declarations to write by hand and one to pick from here. Without them the
// inset box is the only way in, and it asks for each side separately — so
// "fill the parent" means typing 0 four times, and "stick to the bottom right"
// means knowing that the OTHER two sides have to be cleared or the element
// stretches instead of moving.
//
// Each preset is exactly that pair of facts: the sides it sets to 0, and the
// sides it clears. Everything else about the element is left alone.

const AUTO_KEYWORD = 'Auto'; // i18n-ignore: the CSS keyword `auto`, shown as the field's empty value.
const INSET_SIDES = ['top', 'right', 'bottom', 'left'] as const;
type InsetSide = (typeof INSET_SIDES)[number];

// A hint of the element's box, and the part of it being pinned.
function InsetIcon({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" rx="1.5" stroke="currentColor" opacity="0.4" />
      <rect x={x} y={y} width={width} height={height} rx="0.75" fill="currentColor" />
    </svg>
  );
}

const INSET_PRESETS: ReadonlyArray<{
  value: string;
  labelKey: MessageKey;
  sides: readonly InsetSide[];
  icon: ReactNode;
}> = [
  {
    value: 'top-left',
    labelKey: 'style.positionSection.topLeft',
    sides: ['top', 'left'],
    icon: <InsetIcon x={3.5} y={3.5} width={4} height={4} />,
  },
  {
    value: 'top-right',
    labelKey: 'style.positionSection.topRight',
    sides: ['top', 'right'],
    icon: <InsetIcon x={8.5} y={3.5} width={4} height={4} />,
  },
  {
    value: 'bottom-left',
    labelKey: 'style.positionSection.bottomLeft',
    sides: ['bottom', 'left'],
    icon: <InsetIcon x={3.5} y={8.5} width={4} height={4} />,
  },
  {
    value: 'bottom-right',
    labelKey: 'style.positionSection.bottomRight',
    sides: ['bottom', 'right'],
    icon: <InsetIcon x={8.5} y={8.5} width={4} height={4} />,
  },
  {
    value: 'left',
    labelKey: 'style.positionSection.leftEdge',
    sides: ['top', 'bottom', 'left'],
    icon: <InsetIcon x={3.5} y={3.5} width={3} height={9} />,
  },
  {
    value: 'right',
    labelKey: 'style.positionSection.rightEdge',
    sides: ['top', 'bottom', 'right'],
    icon: <InsetIcon x={9.5} y={3.5} width={3} height={9} />,
  },
  {
    value: 'bottom',
    labelKey: 'style.positionSection.bottomEdge',
    sides: ['left', 'right', 'bottom'],
    icon: <InsetIcon x={3.5} y={9.5} width={9} height={3} />,
  },
  {
    value: 'top',
    labelKey: 'style.positionSection.topEdge',
    sides: ['left', 'right', 'top'],
    icon: <InsetIcon x={3.5} y={3.5} width={9} height={3} />,
  },
  {
    value: 'full',
    labelKey: 'style.positionSection.fill',
    sides: ['top', 'right', 'bottom', 'left'],
    icon: <InsetIcon x={3.5} y={3.5} width={9} height={9} />,
  },
];

function InsetPresets({ read, busy, setProp, clearProp }: Props) {
  const translate = useTranslate();
  // Which sides are pinned right now — by whether they are SET at all, not by
  // whether they are still 0. Nudging a corner to `12px` has not stopped it
  // being pinned to that corner, and the row should go on saying so.
  const pinned = INSET_SIDES.filter((side) => {
    const value = (effectiveValue(read, side) || '').trim().toLowerCase();
    return value !== '' && value !== 'auto';
  });
  const current = INSET_PRESETS.find((preset) => preset.sides.length === pinned.length && preset.sides.every((side) => pinned.includes(side)))?.value ?? '';

  const apply = (preset: (typeof INSET_PRESETS)[number]) => {
    // Clear the others FIRST: an element that has `left` set and then gains
    // `right` stretches between them rather than moving, so a preset that only
    // added sides would give a different result from the one its icon shows.
    const others = INSET_SIDES.filter((side) => !preset.sides.includes(side));
    if (others.length) {
      clearProp([...others]);
    }
    preset.sides.forEach((side) => setProp(side, '0', false));
  };

  return (
    <div className="embed-editor_inset-presets" role="radiogroup" aria-label={translate('style.positionSection.pinTo')}>
      {INSET_PRESETS.map((preset) => (
        <button
          key={preset.value}
          type="button"
          role="radio"
          aria-checked={current === preset.value}
          className={`embed-editor_inset-preset ${current === preset.value ? 'is-selected' : ''}`}
          disabled={busy}
          title={translate(preset.labelKey)}
          aria-label={translate(preset.labelKey)}
          onClick={() => apply(preset)}
        >
          {preset.icon}
        </button>
      ))}
    </div>
  );
}

// The inset box: Webflow's position frame (a single band, no nesting) driven by the
// shared SpacingBox — draggable side handles, click-to-edit labels, and a popover
// editor, exactly like the margin/padding box. Each side maps to the plain
// top/right/bottom/left property; unset reads "Auto".
function InsetBox(props: Props) {
  const { label, fillHandlers, editor } = useSpacingBox(props, { emptyLabel: 'Auto' }); // i18n-ignore: the CSS keyword `auto`.
  return (
    <div className="embed-editor_spacing">
      <div className="embed-editor_position-inset">
        <SpacingFill
          frame="position"
          propFor={(side) => side}
          read={props.read}
          busy={props.busy}
          setProp={props.setProp}
          liveSetProp={props.liveSetProp}
          {...fillHandlers}
        />
        {label('top', 'top')}
        {label('right', 'right')}
        {label('bottom', 'bottom')}
        {label('left', 'left')}
        <div className="embed-editor_spacing-content" />
      </div>
      {editor}
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

// A row's label, driven by the resolved model like the Size/Layout labels: blue +
// clearable when the picked selector sets the prop, orange when another selector does,
// dim when unset. Reuses the shared size-label styling.
function RowLabel({
  label,
  prop,
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  read: Read;
  busy: boolean;
  clearProp: ClearProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const resolved = read(prop);
  const isSelected = resolved?.source === 'selected';
  const contributors = resolved?.contributors ?? [];
  // Set by ANOTHER selector → orange, click opens the provenance popover.
  if (resolved && !isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  // Blue (picked selector sets it) or dim (unset). The clear menu also lists every
  // selector that sets this property and which one wins — click a row to jump to it.
  return (
    <FieldLabel
      className="embed-editor_size-label"
      active={!!isSelected}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel={translate('style.positionSection.clear')}
      tooltip={<PropTip props={[prop]} />}
      menuNote={
        contributors.length
          ? (close) => (
              <ProvenanceList
                contributors={contributors}
                prop={prop}
                onSelect={(selector, selectorProp) => {
                  onSelectSelector(selector, selectorProp);
                  close();
                }}
              />
            )
          : undefined
      }
    >
      {label}
    </FieldLabel>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="embed-editor_position-row">
      {label}
      {children}
    </div>
  );
}

export default function PositionSection(props: Props) {
  const { read } = props;
  const translate = useTranslate();

  const rowLabel = (label: string, prop: string) => (
    <RowLabel
      label={label}
      prop={prop}
      read={read}
      busy={props.busy}
      clearProp={props.clearProp}
      onProvenance={props.onProvenance}
      onSelectSelector={props.onSelectSelector}
    />
  );

  return (
    <div className="embed-editor_position">
      <Row label={rowLabel(translate('style.positionSection.position'), 'position')}>
        <PositionControl read={read} busy={props.busy} setProp={props.setProp} liveSetProp={props.liveSetProp} />
      </Row>

      {/* Always there, whatever `position` says — the same reasoning as the
          inset box below it, which has never hidden either. A row that comes
          and goes as the dropdown changes is a row you have to find again, and
          picking a pin is a perfectly good way to say what you were going to
          set the position to anyway. */}
      <InsetPresets {...props} />

      <InsetBox {...props} />

      {/* Always shown, like the presets and the inset box above it. It used to
          appear only once the element was positioned, which meant the field
          moved in and out of the panel as the dropdown changed — and reading
          "Auto" from a field that is there is clearer than inferring it from a
          field that isn't. */}
      <Row label={rowLabel('z-index', 'z-index')}>
        <LiveField prop="z-index" placeholder={AUTO_KEYWORD} ariaLabel="z-index" {...props} />
      </Row>

      <Row label={rowLabel(translate('style.positionSection.float'), 'float')}>
        <SegmentedIconControl
          prop="float"
          ariaLabel={translate('style.positionSection.float')}
          segments={floatSegments(translate)}
          current={effectiveText(read, 'float') || 'none'}
          {...props}
        />
      </Row>
      <Row label={rowLabel(translate('style.positionSection.clearProperty'), 'clear')}>
        <SegmentedIconControl
          prop="clear"
          ariaLabel={translate('style.positionSection.clearProperty')}
          segments={clearSegments(translate)}
          current={effectiveText(read, 'clear') || 'none'}
          {...props}
        />
      </Row>
    </div>
  );
}
