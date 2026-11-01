import { ErrorToast } from '../../ui/ErrorToast';
import type { GuidePersistence } from './guidePersistence';
import { useCallback, useRef, useState, type ReactElement } from 'react';
import { GuideIcon } from '../../ui/Icons';
import LayerPopover from '../style/LayerPopover';
import ColorSwatch from '../style/components/ColorSwatch';
import FieldLabel from '../style/components/FieldLabel';
import DragSlider from '../style/components/DragSlider';
import useScrub from '../style/components/useScrub';
import { stepSizeKey, useFollowingDraft } from '../style/SizeKit';
import VariableConnect from '../style/VariableConnect';
import {
  GUIDE_DEFAULTS,
  GUIDE_LENGTH_DEFAULTS,
  GUIDE_LIMITS,
  GUIDE_PROJECT_VARIABLES,
  clampGuideOpacity,
  guideLengthText,
  type GuideLength,
  guideSizeText,
  guideColumnText,
  parseGuideColumnSetting,
  isGuideColumnPick,
  parseGuideSize,
  type GuideMetrics,
  type GuideSettings,
  type GuideSize,
  type GuideValue,
  type ResolvedGuide,
} from './guideModel';
import { parseGuideColor, type GuideUpdate } from './guideSettings';
import './guide.css';

// The preview toolbar's column-guide button and the menu it opens. Every row
// is a control from the style panel, so the menu reads and behaves like the
// panel: the same labels, fields, slider, swatch and switch.

const MENU_WIDTH_PX = 280;
const MENU_EDGE_PX = 8;
const { columnPickMax, columnPickMin } = GUIDE_LIMITS;
const COUNT_RANGE = `A whole number from ${columnPickMin} to ${columnPickMax}.`;
const COUNT_SPAN = `${columnPickMin}–${columnPickMax}`;

export interface GuideMenuProps {
  readonly persistence?: GuidePersistence;
  readonly settings: GuideSettings;
  readonly update: GuideUpdate;
  /** What the frame measured; undefined until it reports. */
  readonly metrics: GuideMetrics | undefined;
  readonly guide: ResolvedGuide | undefined;
  /** Canvas mode draws no overlays, so the guide has nowhere to show. */
  readonly available: boolean;
}

export function GuideMenu(props: GuideMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const close = useCallback(() => setAnchor(undefined), []);
  const title = props.available ? 'Column guide — ⇧G' : 'Column guide — not shown in Canvas';
  return (
    <div className="device-btns guide-btns">
      <button
        ref={buttonRef}
        type="button"
        className={props.settings.visible && props.available ? 'on' : ''}
        data-tooltip={title}
        aria-label="Column guide"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        disabled={!props.available}
        onClick={() => setAnchor(anchor === undefined ? (buttonRef.current ?? undefined) : undefined)}
      >
        <GuideIcon size={13} />
      </button>
      {anchor !== undefined ? (
        <LayerPopover anchorEl={anchor} ariaLabel="Column guide" span={menuSpan(anchor)} onClose={close}>
          <GuideMenuRows {...props} />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

function GuideMenuRows({ settings, update, metrics, guide, persistence }: GuideMenuProps) {
  // The menu is portaled outside the style panel, so style-panel-surface gives
  // its controls the panel's own button and field rules instead of the app-wide
  // ones (see styles.css).
  return (
    <div className="guide-menu style-panel-surface">
      {persistence?.message && <ErrorToast message={persistence.message} />}
      <SwitchRow label="Guide" value={settings.visible} onChange={(visible) => update((previous) => ({ ...previous, visible }))} />
      <ColumnsRow settings={settings} update={update} metrics={metrics} />
      <ColorRow settings={settings} update={update} />
      <OpacityRow settings={settings} update={update} />
      <SwitchRow label="Numbers" value={settings.numbers} onChange={(numbers) => update((previous) => ({ ...previous, numbers }))} />
      <div className="embed-editor_display-menu-divider" />
      <SizeRow
        label="Margin"
        value={guide?.margin}
        setting={settings.margin}
        projectVariable={GUIDE_PROJECT_VARIABLES.margin}
        fallback={GUIDE_LENGTH_DEFAULTS.margin}
        onChange={(margin) => update((previous) => ({ ...previous, margin }))}
      />
      <SizeRow
        label="Gutter"
        value={guide?.gutter}
        setting={settings.gutter}
        projectVariable={GUIDE_PROJECT_VARIABLES.gutter}
        fallback={GUIDE_LENGTH_DEFAULTS.gutter}
        onChange={(gutter) => update((previous) => ({ ...previous, gutter }))}
      />
      <SizeRow
        label="Max width"
        value={guide?.widthMax}
        setting={settings.widthMax}
        projectVariable={GUIDE_PROJECT_VARIABLES.widthMax}
        fallback={GUIDE_LENGTH_DEFAULTS.widthMax}
        onChange={(widthMax) => update((previous) => ({ ...previous, widthMax }))}
      />
      <GuideMenuNotes settings={settings} guide={guide} metrics={metrics} />
    </div>
  );
}

// Show the automatic binding only when it supplies a usable count, so the
// field describes the overlay even on projects without layout variables.
function ColumnsRow({ settings, update, metrics }: Pick<GuideMenuProps, 'settings' | 'update' | 'metrics'>) {
  const reset = (): void => update((previous) => ({ ...previous, columns: GUIDE_DEFAULTS.columns }));
  const commit = (text: string): void => {
    if (text.trim() === '') {
      reset();
      return;
    }
    const columns = parseGuideColumnSetting(text);
    if (columns !== undefined) {
      update((previous) => ({ ...previous, columns }));
    }
  };
  const changed = settings.columns.kind !== 'automatic';
  return (
    <div className="embed-editor_size-row">
      <ResetLabel label="Columns" changed={changed} onReset={reset} />
      <div className="embed-editor_field">
        <GuideField
          value={guideColumnText(settings.columns, metrics)}
          ariaLabel="Column count"
          title={`${COUNT_RANGE} Or connect a project variable.`}
          variables="Connect the column count to a variable"
          variableProperty="column-count"
          onCommit={commit}
        />
      </div>
    </div>
  );
}

function ColorRow({ settings, update }: Pick<GuideMenuProps, 'settings' | 'update'>) {
  const commit = (text: string): void => {
    const color = parseGuideColor(text);
    if (color !== undefined) {
      update((previous) => ({ ...previous, color }));
    }
  };
  return (
    <div className="embed-editor_size-row">
      <ResetLabel
        label="Color"
        changed={settings.color !== GUIDE_DEFAULTS.color}
        onReset={() => update((previous) => ({ ...previous, color: GUIDE_DEFAULTS.color }))}
      />
      <div className="embed-editor_type-field">
        <ColorSwatch value={settings.color} ariaLabel="Guide color" onChange={commit} />
        <GuideField value={settings.color} ariaLabel="Guide color" onCommit={commit} />
      </div>
    </div>
  );
}

function OpacityRow({ settings, update }: Pick<GuideMenuProps, 'settings' | 'update'>) {
  const commit = (value: number): void => update((previous) => ({ ...previous, opacity: clampGuideOpacity(value) }));
  return (
    <div className="embed-editor_size-row">
      <ResetLabel
        label="Opacity"
        changed={settings.opacity !== GUIDE_DEFAULTS.opacity}
        onReset={() => update((previous) => ({ ...previous, opacity: GUIDE_DEFAULTS.opacity }))}
      />
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={settings.opacity}
          min={GUIDE_LIMITS.opacityMin}
          max={GUIDE_LIMITS.opacityMax}
          step={GUIDE_LIMITS.opacityStep}
          ariaLabel="Guide opacity"
          onInput={commit}
          onCommit={commit}
        />
        <div className="embed-editor_field embed-editor_grad-num embed-editor_opacity-num">
          <GuideField
            value={String(settings.opacity)}
            ariaLabel="Guide opacity"
            inputMode="decimal"
            onCommit={(text) => {
              const value = Number.parseFloat(text);
              if (Number.isFinite(value)) {
                commit(value);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

// The panel's clearable caption: dim at the default, a blue pill once changed,
// whose menu (or an Option-click) puts the default back.
function ResetLabel({ label, changed, onReset }: { readonly label: string; readonly changed: boolean; readonly onReset: () => void }) {
  return (
    <FieldLabel className="embed-editor_size-label" active={changed} onReset={onReset}>
      {label}
    </FieldLabel>
  );
}

function SwitchRow({ label, value, onChange }: { readonly label: string; readonly value: boolean; readonly onChange: (value: boolean) => void }) {
  return (
    <div className="embed-editor_size-row">
      <span className="u-field-label embed-editor_size-label">{label}</span>
      <button type="button" className={`cms-toggle ${value ? 'on' : ''}`} aria-pressed={value} aria-label={label} onClick={() => onChange(!value)}>
        <span className="cms-toggle-knob" />
        <span className="cms-toggle-label">{value ? 'On' : 'Off'}</span>
      </button>
    </div>
  );
}

// A margin, gutter or maximum width: a length in px or rem, or a variable of
// the project's own, picked from the panel's variable list or typed. Untouched,
// it shows the default it draws with: the project's Lumos variable as a chip,
// or the fixed rem value. Emptied or reset, it goes back to
// that default. Like every field in the panel, it is always editable: the
// guide only draws, so changing it never touches the project.
function SizeRow({
  label,
  value,
  setting,
  projectVariable,
  fallback,
  onChange,
}: {
  readonly label: string;
  readonly value: GuideValue | undefined;
  readonly setting: GuideSize | undefined;
  readonly projectVariable: string;
  readonly fallback: GuideLength;
  readonly onChange: (size: GuideSize | undefined) => void;
}) {
  const commit = (text: string): void => {
    if (text.trim() === '') {
      onChange(undefined);
      return;
    }
    const size = parseGuideSize(text);
    if (size !== undefined) {
      onChange(size);
    }
  };
  return (
    <div className="embed-editor_size-row">
      <ResetLabel label={label} changed={setting !== undefined} onReset={() => onChange(undefined)} />
      <div className="embed-editor_field">
        <GuideField
          value={sizeShown(value, setting, projectVariable, fallback)}
          ariaLabel={label}
          title={sizeTitle(value, setting, projectVariable)}
          variables={`Connect ${label} to a variable`}
          onCommit={commit}
        />
      </div>
    </div>
  );
}

// The notes under the menu: which of the menu's variables the page does not
// declare, so the field's text is not what the guide draws with. The column
// variable must also hold a whole number.
function GuideMenuNotes({ settings, guide, metrics }: Pick<GuideMenuProps, 'settings' | 'guide' | 'metrics'>) {
  const missing = guide === undefined ? [] : missingVariables(settings, guide);
  const countNotes = metrics === undefined ? [] : columnCountNotes(settings, metrics);
  return (
    <>
      {missing.map((name) => (
        <ErrorToast key={name} message={`${name} is not declared on this page, so its default is used.`} />
      ))}
      {countNotes.map((note) => (
        <ErrorToast key={note} message={note} />
      ))}
    </>
  );
}

// Automatic defaults need no warning; explain when an explicit connection falls back.
function columnCountNotes(settings: GuideSettings, metrics: GuideMetrics): readonly string[] {
  if (settings.columns.kind !== 'variable') {
    return [];
  }
  const name = settings.columns.name;
  const note = columnCountNote(name, metrics.variableCounts[name]);
  return note === undefined ? [] : [note];
}

function columnCountNote(name: string, declared: number | undefined): string | undefined {
  if (declared === undefined) {
    return `${name} is not declared on this page, or is not a whole number, so its default is ` + 'used.';
  }
  if (isGuideColumnPick(declared)) {
    return undefined;
  }
  return `${name} is outside ${COUNT_SPAN}, so its default is used.`;
}

// The panel's text field: follows its value while not focused, steps numbers
// with the arrow keys, scrubs with a drag, and commits on blur or Enter. Given
// `variables`, it also carries the panel's variable button, as the style
// panel's own fields do (LiveInput.tsx): the visible sign that a variable is
// accepted, and the list of the ones the project defines.
function GuideField({
  value,
  ariaLabel,
  placeholder,
  title,
  inputMode,
  variables,
  variableProperty = 'width',
  onCommit,
}: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly title?: string;
  readonly inputMode?: 'decimal';
  /** The variable button's label; absent, the field takes no variable. */
  readonly variables?: string;
  /** The CSS property the variable list is filtered for. */
  readonly variableProperty?: string;
  readonly onCommit: (text: string) => void;
}) {
  const { draft, setDraft, focused } = useFollowingDraft(value);
  const scrub = useScrub({
    value: draft,
    disabled: false,
    onPreview: setDraft,
    onInput: () => undefined,
    onCommit: (text: string) => {
      setDraft(text);
      onCommit(text);
    },
  });
  const input = (
    <input
      {...scrub.input}
      className="u-input embed-editor_size-input"
      value={draft}
      spellCheck={false}
      aria-label={ariaLabel}
      {...(placeholder === undefined ? {} : { placeholder })}
      {...(title === undefined ? {} : { title })}
      {...(inputMode === undefined ? {} : { inputMode })}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        if (draft === value) {
          return;
        }
        onCommit(draft);
        setDraft(value);
      }}
      onKeyDown={(event) => {
        const stepped = stepSizeKey(event);
        if (stepped !== undefined) {
          setDraft(stepped);
        }
      }}
    />
  );
  if (variables === undefined) {
    return input;
  }
  return withVariables(input, { label: variables, property: variableProperty }, (binding) => {
    setDraft(binding);
    onCommit(binding);
  });
}

// A picked variable replaces the value and is committed at once, as in the
// panel. The property narrows the list to the variables that fit it.
function withVariables(input: ReactElement, button: { readonly label: string; readonly property: string }, onPick: (binding: string) => void) {
  return (
    <VariableConnect code className="is-fill" ariaLabel={button.label} prop={button.property} onPick={onPick}>
      {input}
    </VariableConnect>
  );
}

// The field's text: the menu's own value, else the project's variable it
// defaults to (shown as a chip), else the fixed rem default.
function sizeShown(value: GuideValue | undefined, setting: GuideSize | undefined, projectVariable: string, fallback: GuideLength): string {
  if (setting !== undefined) {
    return guideSizeText(setting);
  }
  return value?.source === 'project' ? `var(${projectVariable})` : guideLengthText(fallback);
}

// The field's tooltip: where the value comes from, what it is at this width,
// and what the field takes.
function sizeTitle(value: GuideValue | undefined, setting: GuideSize | undefined, projectVariable: string): string {
  const accepts = 'A length (32px, 2rem) or a project variable (--name).';
  if (value === undefined) {
    return accepts;
  }
  const px = `${Math.round(value.px)}px at this width`;
  switch (value.source) {
    case 'project':
      return `From the project's ${projectVariable}: ${px}.\n${accepts}`;
    case 'variable':
      return `${setting?.kind === 'variable' ? setting.name : 'Variable'}: ${px}.\n${accepts}`;
    case 'fixed':
      return `${px}.\n${accepts}`;
    case 'default':
      return `Default: ${px}.\n${accepts}`;
    default: {
      const exhaustive: never = value.source;
      return exhaustive;
    }
  }
}

// The menu's variables the page does not declare: set, but not what was used.
function missingVariables(settings: GuideSettings, guide: ResolvedGuide): readonly string[] {
  const pairs = [
    [settings.margin, guide.margin],
    [settings.gutter, guide.gutter],
    [settings.widthMax, guide.widthMax],
  ] as const;
  const names = new Set<string>();
  for (const [setting, value] of pairs) {
    if (setting?.kind === 'variable') {
      if (value?.source !== 'variable') {
        names.add(setting.name);
      }
    }
  }
  return [...names];
}

// Below the button, as wide as the menu, kept inside the window.
function menuSpan(anchor: HTMLElement): { readonly left: number; readonly width: number } {
  const rect = anchor.getBoundingClientRect();
  const leftMax = window.innerWidth - MENU_WIDTH_PX - MENU_EDGE_PX;
  return { left: Math.max(MENU_EDGE_PX, Math.min(rect.left, leftMax)), width: MENU_WIDTH_PX };
}
