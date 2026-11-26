// Frame settings, in the popover over the component canvas (ComponentCanvasFramePopup.tsx): the selected frame's size
// and background. Every edit goes to the scope "Apply to" names (this frame, every frame of one split value, every
// frame, or the canvas background of every component); a frame's own setting wins over a wider one. Which props get
// their own frames and the frames' preview values are the Settings panel's (src/app/shell/canvasFrameSettings.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { CANVAS_LIMITS, canvasRoot, frameBackground, type FrameEntry, type FrameLength } from '../../../../shared/properties/componentCanvas';
import Dropdown from '../../../ui/Dropdown';
import InfoHint from '../../../ui/InfoHint';
import SegmentedControl from '../../../ui/SegmentedControl';
import { ResetLabel } from '../../../ui/ResetLabel';
import { ComponentFillIcon } from '../../../ui/Icons';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import ColorSwatch from '../../style/components/ColorSwatch';
import VariableConnect from '../../style/VariableConnect';
import type { ModelFrame } from './canvasModel';
import { frameLabel, prettyComponentName } from './frameLabel';
import { CanvasScopeControl } from './CanvasScopeControl';
import { COMPONENT_SCOPE, PROJECT_SCOPE, type CanvasOpen, type ComponentCanvasControl } from './componentCanvasSession';
import './componentCanvas.css';
import { CAPTION_LABEL_FOR } from '../../../ui/captionLabel';

// The width a frame takes when it stops hugging and nothing wider sets one.
const FIXED_WIDTH_PX = 400;
const FIXED_HEIGHT_PX = 300;

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
      {state.subject === 'root' ? (
        <RootSection canvas={canvas} state={state} frame={frame} />
      ) : (
        <FrameSection canvas={canvas} state={state} frame={frame} entry={entry} />
      )}
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
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.frame.title')}>
      <Heading title={translate('componentCanvas.panel.frame.title')} hint={translate('componentCanvas.panel.frame.about')} />
      {state.layout.frames.length > 1 && (
        <div className="props-field">
          <label htmlFor={CAPTION_LABEL_FOR}>{translate('componentCanvas.panel.frame.pick')}</label>
          <Dropdown
            ariaLabel={translate('componentCanvas.panel.frame.pick')}
            value={frame.key}
            options={state.layout.frames.map((candidate) => ({ value: candidate.key, label: frameLabel(candidate, state.component, translate) }))}
            onChange={canvas.selectFrame}
          />
        </div>
      )}
      <CanvasScopeControl canvas={canvas} state={state} />
      <LengthField side="width" canvas={canvas} state={state} value={frame.resolved.width} entry={entry} />
      <LengthField side="height" canvas={canvas} state={state} value={frame.resolved.height} entry={entry} />
      <BackgroundField canvas={canvas} state={state} frame={frame} entry={entry} />
    </section>
  );
}

// The canvas itself, while its root (the page's <html>) is selected: where its settings apply, and its background, the
// surface every frame sits on. Its classes are the Settings panel's class field (canvasFrameSettings.tsx).
function RootSection({ canvas, state, frame }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen; readonly frame: ModelFrame }) {
  const translate = useTranslate();
  const scopes = [
    { value: COMPONENT_SCOPE, label: translate('componentCanvas.panel.scope.component') },
    { value: PROJECT_SCOPE, label: translate('componentCanvas.panel.scope.project') },
  ];
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.root.title')}>
      <Heading title={translate('componentCanvas.panel.root.title')} hint={translate('componentCanvas.panel.root.about')} />
      <div className="props-field">
        <label htmlFor={CAPTION_LABEL_FOR}>
          {translate('componentCanvas.panel.scope.label')}
          <InfoHint text={translate('componentCanvas.panel.scope.hint')} />
        </label>
        <Dropdown ariaLabel={translate('componentCanvas.panel.scope.label')} value={state.scope} options={scopes} onChange={canvas.setScope} />
      </div>
      <BackgroundField canvas={canvas} state={state} frame={frame} entry={undefined} />
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
      <FieldTitle>
        <ResetLabel label={label} active={entry?.[side] !== undefined} onReset={() => canvas.edit({ kind: 'field', field: side, value: undefined })} />
      </FieldTitle>
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

// The background at the chosen scope: the frame's own, a wider scope's, the component's, or the project's canvas
// background. A value set here is the blue label (reset clears it); one that comes from a wider level is the orange,
// inherited label, as the Style panel shows an inherited value.
function BackgroundField({
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
  // At a root scope the field is the canvas surface: the component's own, else the project's (inherited at the component).
  const rootScope = state.scope === PROJECT_SCOPE || state.scope === COMPONENT_SCOPE;
  const root = canvasRoot(state.settings, state.component.file);
  const rootOwn = state.scope === PROJECT_SCOPE ? state.settings.background : state.settings.components[state.component.file]?.root?.background;
  const shown = rootScope
    ? { value: rootOwn ?? (state.scope === COMPONENT_SCOPE ? root.background : undefined) }
    : frameBackground(state.settings, frame.resolved, state.component.file);
  const own = rootScope ? rootOwn !== undefined : entry?.background !== undefined;
  const inherited = !own && shown.value !== undefined;
  const value = shown.value;
  const label = translate('componentCanvas.panel.background');
  const commit = (color: string) => {
    const trimmed = color.trim();
    // Transparent over every frame is what no setting says; for the project it is a setting of its own (no canvas grey).
    const clear = trimmed === '' || (trimmed === 'transparent' && state.scope === '');
    canvas.edit({ kind: 'background', value: clear ? undefined : trimmed });
  };
  return (
    <div className="props-field">
      <FieldTitle>
        {inherited ? (
          <span className="prop-label embed-editor_prop-orange component-canvas-inherited">{label}</span>
        ) : (
          <ResetLabel label={label} active={own} onReset={() => canvas.edit({ kind: 'background', value: undefined })} />
        )}
      </FieldTitle>
      <div className="component-canvas-color">
        <ColorSwatch
          value={value ?? 'transparent'}
          ariaLabel={label}
          onChange={(color, live) => {
            if (!live) {
              commit(color);
            }
          }}
        />
        <BackgroundInput
          value={own ? (value ?? '') : ''}
          placeholder={inherited ? (value ?? '') : translate('componentCanvas.panel.transparent')}
          label={label}
          connectLabel={translate('componentCanvas.panel.backgroundVariable')}
          onCommit={commit}
        />
      </div>
    </div>
  );
}

// The background's text, with the Style panel's variable button beside it: a picked variable is written as
// `var(--name)` at once, so the canvas follows the variable's later edits. Typed text commits on Enter or leaving.
function BackgroundInput({
  value,
  placeholder,
  label,
  connectLabel,
  onCommit,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly label: string;
  readonly connectLabel: string;
  readonly onCommit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <VariableConnect
      code
      className="is-fill"
      ariaLabel={connectLabel}
      prop="background-color"
      onPick={(binding) => {
        setDraft(binding);
        onCommit(binding);
      }}
    >
      <input
        className="u-input"
        value={draft}
        placeholder={placeholder}
        aria-label={label}
        spellCheck={false}
        maxLength={CANVAS_LIMITS.backgroundCharsMax}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) {
            onCommit(draft);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
    </VariableConnect>
  );
}

// A field's title in the props panel's own label (styles.css `.props-field label`): one size, colour and gap to its
// control for every field, whether the title is plain text or a label that resets its value. A press on it activates
// nothing, as the props panel's labels do not (PropFieldLabel.tsx).
function FieldTitle({ children }: { readonly children: ReactNode }) {
  return (
    <label htmlFor={CAPTION_LABEL_FOR} onClick={(event) => event.preventDefault()}>
      {children}
    </label>
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
