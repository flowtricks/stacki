// The right panel while a frame of the component canvas is selected and no element in it is: which props get their
// own frames, the frame's size and background, and the preview values it renders with. Every edit goes to the scope
// "Apply to" names (this frame, every frame of one split value, or every frame); a frame's own setting wins over a
// wider one. Preview values stay on the canvas: nothing here writes the component or its instances.
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../../shared/core/assert';
import { CANVAS_LIMITS, frameKey, type FrameEntry, type FrameLength } from '../../../../shared/properties/componentCanvas';
import type { PropField } from '../../../../shared/properties/propSchema';
import type { DefaultValue } from '../../../../shared/properties/componentDefaults';
import Dropdown from '../../../ui/Dropdown';
import InfoHint from '../../../ui/InfoHint';
import FittedTooltip from '../../../ui/FittedTooltip';
import SegmentedControl from '../../../ui/SegmentedControl';
import { Switch } from '../../../ui/Switch';
import { ResetLabel } from '../../../ui/ResetLabel';
import { ComponentFillIcon } from '../../../ui/Icons';
import { useDelayedTooltip } from '../../../ui/delayedTooltip';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import ColorSwatch from '../../style/components/ColorSwatch';
import { fieldControl, frameTakes, shownValue, splitPartOf, type ModelFrame } from './canvasModel';
import { frameLabel, partLabel, prettyComponentName } from './frameLabel';
import type { CanvasOpen, ComponentCanvasControl } from './componentCanvasSession';
import './componentCanvas.css';

// The width a frame takes when it stops hugging and nothing wider sets one.
const FIXED_WIDTH_PX = 400;
const FIXED_HEIGHT_PX = 300;
// A value the choice menu uses for "not set": no option of a prop can be this, since prop options are printable text.
const UNSET_OPTION = '\u0000unset';

export function ComponentCanvasPanel({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const frame = state.layout.frames.find((candidate) => candidate.key === state.frame) ?? state.layout.frames[0];
  assert(frame !== undefined, 'An open canvas has a frame');
  const entry = state.settings.components[state.component.file]?.frames?.[state.scope];
  return (
    <div className="component-canvas-panel" data-testid="component-canvas-panel">
      <div className="props-title">
        <ComponentFillIcon size={16} />
        <span className="component-canvas-panel-name">{prettyComponentName(state.component.name)}</span>
        <span className="badge">{translate('componentCanvas.panel.frames', { count: state.layout.frames.length })}</span>
      </div>
      <SplitSection canvas={canvas} state={state} />
      <FrameSection canvas={canvas} state={state} frame={frame} entry={entry} />
      <PropsSection canvas={canvas} state={state} frame={frame} entry={entry} />
    </div>
  );
}

function Heading({ title, hint }: { readonly title: string; readonly hint: string }) {
  return (
    <div className="component-canvas-heading">
      <span>{title}</span>
      <InfoHint text={hint} />
    </div>
  );
}

function SplitSection({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  if (state.layout.candidates.length === 0) {
    return undefined;
  }
  const full = state.layout.split.length >= CANVAS_LIMITS.splitPropsMax;
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.split.title')}>
      <Heading title={translate('componentCanvas.panel.split.title')} hint={translate('componentCanvas.panel.split.hint')} />
      {state.layout.candidates.map((candidate) => {
        const on = state.layout.split.includes(candidate.name);
        return (
          <label key={candidate.name} className="component-canvas-switch-row">
            <span className="component-canvas-switch-name">{candidate.name}</span>
            <span className="component-canvas-switch-count">{translate('componentCanvas.panel.values', { count: candidate.values.length })}</span>
            <Switch
              label={translate('componentCanvas.panel.split.toggle', { name: candidate.name })}
              checked={on}
              disabled={!on && full}
              onToggle={() => canvas.setSplit(on ? state.layout.split.filter((name) => name !== candidate.name) : [...state.layout.split, candidate.name])}
            />
          </label>
        );
      })}
    </section>
  );
}

function FrameSection({
  canvas,
  state,
  frame,
  entry,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly frame: ModelFrame;
  readonly entry: FrameEntry | undefined;
}) {
  const translate = useTranslate();
  const scopes = [
    { value: frame.key, label: translate('componentCanvas.panel.scope.frame') },
    ...frame.parts.map((part) => ({ value: frameKey([part]), label: translate('componentCanvas.panel.scope.part', { part: partLabel(part, translate) }) })),
    { value: '', label: translate('componentCanvas.panel.scope.all') },
  ].filter((option, index, all) => all.findIndex((other) => other.value === option.value) === index);
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.frame.title')}>
      <Heading title={translate('componentCanvas.panel.frame.title')} hint={translate('componentCanvas.panel.frame.hint')} />
      {state.layout.frames.length > 1 && (
        <div className="props-field">
          <label>{translate('componentCanvas.panel.frame.pick')}</label>
          <Dropdown
            ariaLabel={translate('componentCanvas.panel.frame.pick')}
            value={frame.key}
            options={state.layout.frames.map((candidate) => ({ value: candidate.key, label: frameLabel(candidate, state.component, translate) }))}
            onChange={canvas.selectFrame}
          />
        </div>
      )}
      <div className="props-field">
        <label>
          {translate('componentCanvas.panel.scope.label')}
          <InfoHint text={translate('componentCanvas.panel.scope.hint')} />
        </label>
        <Dropdown ariaLabel={translate('componentCanvas.panel.scope.label')} value={state.scope} options={scopes} onChange={canvas.setScope} />
      </div>
      <LengthField side="width" canvas={canvas} state={state} value={frame.resolved.width} entry={entry} />
      <LengthField side="height" canvas={canvas} state={state} value={frame.resolved.height} entry={entry} />
      <BackgroundField canvas={canvas} state={state} value={frame.resolved.background} entry={entry} />
    </section>
  );
}

function LengthField({
  side,
  canvas,
  state,
  value,
  entry,
}: {
  readonly side: 'width' | 'height';
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly value: FrameLength;
  readonly entry: FrameEntry | undefined;
}) {
  const translate = useTranslate();
  const label = translate(side === 'width' ? 'componentCanvas.panel.width' : 'componentCanvas.panel.height');
  // Hug over all frames is what no setting says, so it is written as no setting rather than as "hug".
  const set = (next: FrameLength) => canvas.edit({ kind: 'field', field: side, value: next === 'hug' && state.scope === '' ? undefined : next });
  return (
    <div className="props-field">
      <ResetLabel label={label} active={entry?.[side] !== undefined} onReset={() => canvas.edit({ kind: 'field', field: side, value: undefined })} />
      <div className="component-canvas-length">
        <SegmentedControl
          ariaLabel={label}
          value={value === 'hug' ? 'hug' : 'fixed'}
          options={[
            { value: 'hug', label: translate('componentCanvas.panel.hug') },
            { value: 'fixed', label: translate('componentCanvas.panel.fixed') },
          ]}
          onChange={(mode) => set(mode === 'hug' ? 'hug' : side === 'width' ? FIXED_WIDTH_PX : FIXED_HEIGHT_PX)}
        />
        {value !== 'hug' && (
          <CommitInput
            ariaLabel={translate('componentCanvas.panel.pixels', { side: label })}
            value={String(value)}
            suffix="px"
            onCommit={(text) => {
              const pixels = Math.round(Number(text));
              if (Number.isFinite(pixels)) {
                set(Math.min(Math.max(pixels, CANVAS_LIMITS.sizePxMin), CANVAS_LIMITS.sizePxMax));
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

function BackgroundField({
  canvas,
  state,
  value,
  entry,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly value: string | undefined;
  readonly entry: FrameEntry | undefined;
}) {
  const translate = useTranslate();
  const commit = (color: string) => {
    const trimmed = color.trim();
    const clear = trimmed === '' || (trimmed === 'transparent' && state.scope === '');
    canvas.edit({ kind: 'background', value: clear ? undefined : trimmed });
  };
  return (
    <div className="props-field">
      <ResetLabel
        label={translate('componentCanvas.panel.background')}
        active={entry?.background !== undefined}
        onReset={() => canvas.edit({ kind: 'background', value: undefined })}
      />
      <div className="component-canvas-color">
        <ColorSwatch
          value={value ?? 'transparent'}
          ariaLabel={translate('componentCanvas.panel.background')}
          onChange={(color, live) => {
            if (!live) {
              commit(color);
            }
          }}
        />
        <CommitInput
          ariaLabel={translate('componentCanvas.panel.background')}
          value={value ?? ''}
          placeholder={translate('componentCanvas.panel.transparent')}
          onCommit={commit}
        />
      </div>
    </div>
  );
}

function PropsSection({
  canvas,
  state,
  frame,
  entry,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly frame: ModelFrame;
  readonly entry: FrameEntry | undefined;
}) {
  const translate = useTranslate();
  const fields = state.component.schema.filter((field) => fieldControl(field) !== undefined);
  if (fields.length === 0) {
    return undefined;
  }
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.props.title')}>
      <Heading title={translate('componentCanvas.panel.props.title')} hint={translate('componentCanvas.panel.props.hint')} />
      {fields.map((field) => {
        const split = splitPartOf(frame, field.name) !== undefined;
        const taken = frameTakes(state.component, frame, field.name);
        const reason = split
          ? translate('componentCanvas.panel.props.split', { name: field.name })
          : taken
            ? undefined
            : translate('componentCanvas.panel.props.unused', { name: field.name });
        const active = entry?.props?.[field.name] !== undefined || entry?.unset?.includes(field.name) === true;
        return (
          <div key={field.name} className={`props-field component-canvas-prop${reason === undefined ? '' : ' is-disabled'}`}>
            <ResetLabel label={field.name} active={active && reason === undefined} onReset={() => canvas.edit({ kind: 'inherit', name: field.name })} />
            <DisabledTip reason={reason}>
              <PropControl canvas={canvas} field={field} frame={frame} defaults={state.defaults} disabled={reason !== undefined} />
            </DisabledTip>
          </div>
        );
      })}
    </section>
  );
}

function PropControl({
  canvas,
  field,
  frame,
  defaults,
  disabled,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly field: PropField;
  readonly frame: ModelFrame;
  readonly defaults: Readonly<Record<string, DefaultValue>>;
  readonly disabled: boolean;
}) {
  const translate = useTranslate();
  const control = fieldControl(field);
  assert(control !== undefined, 'Only editable props get a control');
  const shown = shownValue(field, frame, defaults);
  const set = (value: DefaultValue) => canvas.edit({ kind: 'prop', name: field.name, value });
  switch (control.kind) {
    case 'choice': {
      const unset = frame.omitted.has(field.name) || shown === undefined;
      const options = [
        ...control.options.map((option) => ({ value: option, label: option })),
        ...(field.optional ? [{ value: UNSET_OPTION, label: translate('componentCanvas.panel.props.none') }] : []),
      ];
      return (
        <Dropdown
          ariaLabel={field.name}
          disabled={disabled}
          value={unset ? UNSET_OPTION : String(shown)}
          options={options}
          onChange={(value) => (value === UNSET_OPTION ? canvas.edit({ kind: 'unset', name: field.name }) : set(value))}
        />
      );
    }
    case 'switch':
      return (
        <div className="component-canvas-switch">
          <Switch label={field.name} checked={shown === true} disabled={disabled} onToggle={() => set(shown !== true)} />
        </div>
      );
    case 'number':
      return (
        <CommitInput
          ariaLabel={field.name}
          disabled={disabled}
          value={shown === undefined ? '' : String(shown)}
          onCommit={(text) => {
            const number = Number(text);
            if (text.trim() === '') {
              canvas.edit({ kind: 'inherit', name: field.name });
            } else if (Number.isFinite(number)) {
              set(number);
            }
          }}
        />
      );
    case 'text':
      return (
        <CommitInput
          ariaLabel={field.name}
          disabled={disabled}
          value={typeof shown === 'string' ? shown : shown === undefined ? '' : String(shown)}
          onCommit={(text) => (text === '' && field.optional ? canvas.edit({ kind: 'unset', name: field.name }) : set(text))}
        />
      );
    default: {
      const exhaustive: never = control;
      return exhaustive;
    }
  }
}

// Why a control is greyed out, in the app's own tooltip, on hover.
function DisabledTip({ reason, children }: { readonly reason: string | undefined; readonly children: ReactNode }) {
  const tip = useDelayedTooltip();
  if (reason === undefined) {
    return children;
  }
  return (
    <div className="component-canvas-disabled" onMouseEnter={tip.show} onMouseLeave={tip.hide}>
      {children}
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip anchor={tip.value} role="tooltip">
            {reason}
          </FittedTooltip>,
          document.body,
        )}
    </div>
  );
}

// A text box that changes nothing while typed: Enter or leaving the field commits, Escape puts the value back.
function CommitInput({
  value,
  ariaLabel,
  placeholder,
  suffix,
  disabled,
  onCommit,
}: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly suffix?: string;
  readonly disabled?: boolean;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) {
      onCommit(draft);
    }
  };
  return (
    <span className="component-canvas-input">
      <input
        className="u-input"
        value={draft}
        aria-label={ariaLabel}
        spellCheck={false}
        disabled={disabled ?? false}
        {...(placeholder === undefined ? {} : { placeholder })}
        maxLength={CANVAS_LIMITS.valueCharsMax}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          } else if (event.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
      {suffix !== undefined && <span className="component-canvas-suffix">{suffix}</span>}
    </span>
  );
}
