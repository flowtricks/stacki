// Frame settings, in the popover over the component canvas (ComponentCanvasFramePopup.tsx): the size and background of
// the frame selected on the canvas or in the Navigator. Each section's heading ends in where its edits go
// (CanvasScopeControl.tsx): the size starts at all frames, the background at this frame, and a narrower scope's own
// setting wins over a wider one. Where frames a section reaches keep a value of their own, its label is the Style
// panel's orange, and Reset gives them all the value shown. Which props get their own frames and the frames' preview
// values are the Settings panel's (src/app/shell/canvasFrameSettings.tsx).
import { useEffect, useState, type ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import {
  CANVAS_LIMITS,
  canvasRoot,
  frameBackground,
  overridesIn,
  resolveFrame,
  type FrameLength,
  type FrameSetting,
} from '../../../../shared/properties/componentCanvas';
import InfoHint from '../../../ui/InfoHint';
import SegmentedControl from '../../../ui/SegmentedControl';
import { ResetLabel } from '../../../ui/ResetLabel';
import { ComponentFillIcon } from '../../../ui/Icons';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import ColorSwatch from '../../style/components/ColorSwatch';
import VariableConnect from '../../style/VariableConnect';
import { prettyComponentName } from './frameLabel';
import { CanvasSectionHeading } from './CanvasScopeControl';
import { COMPONENT_SCOPE, PROJECT_SCOPE, type CanvasOpen, type CanvasSection, type ComponentCanvasControl } from './componentCanvasSession';
import './componentCanvas.css';
import { CAPTION_LABEL_FOR } from '../../../ui/captionLabel';
import { stepSizeKey } from '../../style/SizeKit';

// The size a frame takes when it stops hugging before the canvas has said how large the selected frame is drawn.
const FIXED_WIDTH_PX = 400;
const FIXED_HEIGHT_PX = 300;

// Turned Fixed, a side starts at what the selected frame shows now, so nothing jumps; bounded as every size is.
function fixedStart(canvas: ComponentCanvasControl, state: CanvasOpen, side: 'width' | 'height'): number {
  const drawn = canvas.drawnSize(state.frame)?.[side];
  const pixels = drawn === undefined || drawn === 0 ? (side === 'width' ? FIXED_WIDTH_PX : FIXED_HEIGHT_PX) : Math.round(drawn);
  return Math.min(Math.max(pixels, CANVAS_LIMITS.sizePxMin), CANVAS_LIMITS.sizePxMax);
}

export function ComponentCanvasPanel({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const frame = state.layout.frames.find((candidate) => candidate.key === state.frame) ?? state.layout.frames[0];
  assert(frame !== undefined, 'An open canvas has a frame');
  return (
    <div className="component-canvas-panel" data-testid="component-canvas-panel">
      <div className="props-title">
        <ComponentFillIcon size={16} />
        <span className="component-canvas-panel-name">{prettyComponentName(state.component.name)}</span>
        <span className="badge">{translate('componentCanvas.panel.frames', { count: state.layout.frames.length })}</span>
      </div>
      {state.subject === 'root' ? <RootSection canvas={canvas} state={state} /> : <FrameSection canvas={canvas} state={state} />}
    </div>
  );
}

function FrameSection({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  return (
    <>
      <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.size')}>
        <CanvasSectionHeading canvas={canvas} state={state} section="size" title={translate('componentCanvas.panel.size')} />
        <LengthField side="width" canvas={canvas} state={state} />
        <LengthField side="height" canvas={canvas} state={state} />
      </section>
      <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.background')}>
        <CanvasSectionHeading canvas={canvas} state={state} section="background" title={translate('componentCanvas.panel.background')} />
        <BackgroundField canvas={canvas} state={state} />
      </section>
    </>
  );
}

// The canvas itself, while its root (the page's <html>) is selected: its background, the surface every frame sits on,
// for this component's canvas or every component's. Its classes are the Settings panel's class field
// (canvasFrameSettings.tsx), at the same choice.
function RootSection({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  return (
    <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.root.title')}>
      <CanvasSectionHeading
        canvas={canvas}
        state={state}
        section="background"
        title={translate('componentCanvas.panel.root.title')}
        extra={<InfoHint text={translate('componentCanvas.panel.root.about')} />}
      />
      <BackgroundField canvas={canvas} state={state} />
    </section>
  );
}

// The frames a section's scope reaches that keep a value of their own for `setting`, said in the label's tip.
function overridden(state: CanvasOpen, section: CanvasSection, setting: FrameSetting, translate: Translator): string | undefined {
  const scope = state.scopes[section];
  if (scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE) {
    return undefined;
  }
  const frames = state.layout.frames.map((candidate) => candidate.key);
  const found = overridesIn(state.settings.components[state.component.file], frames, scope, setting);
  if (found.length === 0) {
    return undefined;
  }
  const count = translate('componentCanvas.level.overrides', { count: found.length });
  // The selected frame among them is why it does not change: said first.
  return found.some((entry) => entry.frame === state.frame) ? `${translate('componentCanvas.level.frame')}. ${count}` : count;
}

function LengthField({ side, canvas, state }: { readonly side: 'width' | 'height'; readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const label = translate(side === 'width' ? 'componentCanvas.panel.width' : 'componentCanvas.panel.height');
  const scope = state.scopes.size;
  const settings = state.settings.components[state.component.file];
  // What the scope itself gives: its own value, else a wider one's, else hug; while the selected frame is being resized
  // on the canvas, the size the pointer gives it.
  const dragged = state.resizing?.frame === state.frame ? state.resizing[side] : undefined;
  const value = dragged ?? resolveFrame(settings, scope)[side];
  const own = settings?.frames?.[scope]?.[side] !== undefined;
  const tip = overridden(state, 'size', side, translate);
  // Hug over all frames is what no setting says, so it is written as no setting rather than as "hug".
  const set = (next: FrameLength) => canvas.edit({ kind: 'field', field: side, value: next === 'hug' && scope === '' ? undefined : next });
  return (
    <div className="props-field">
      <FieldTitle>
        <ResetLabel
          label={label}
          active={own || tip !== undefined}
          tone={tip === undefined ? undefined : 'overridden'}
          tip={tip}
          onReset={() => (tip === undefined ? canvas.edit({ kind: 'field', field: side, value: undefined }) : canvas.resetOverrides('size', side))}
        />
      </FieldTitle>
      <div className="component-canvas-length">
        <SegmentedControl
          ariaLabel={label}
          value={value === 'hug' ? 'hug' : 'fixed'}
          options={[
            { value: 'hug', label: translate('componentCanvas.panel.hug') },
            { value: 'fixed', label: translate('componentCanvas.panel.fixed') },
          ]}
          onChange={(mode) => set(mode === 'hug' ? 'hug' : fixedStart(canvas, state, side))}
        />
        {value !== 'hug' && (
          <CommitInput
            ariaLabel={translate('componentCanvas.panel.pixels', { side: label })}
            value={String(value)}
            suffix="px"
            stepMin={CANVAS_LIMITS.sizePxMin}
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

// The background at the section's scope: the scope's own, a wider scope's, the component's, or the project's canvas
// background. A value set here is the blue label (reset clears it); one that comes from a wider level is the orange,
// inherited label, as the Style panel shows an inherited value; frames in scope that keep their own make it orange
// with a reset that gives them this one.
function BackgroundField({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const scope = state.scopes.background;
  // At a root scope the field is the canvas surface: the component's own, else the project's (inherited at the component).
  const rootScope = scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE;
  const root = canvasRoot(state.settings, state.component.file);
  const settings = state.settings.components[state.component.file];
  const rootOwn = scope === PROJECT_SCOPE ? state.settings.background : settings?.root?.background;
  const shown = rootScope
    ? { value: rootOwn ?? (scope === COMPONENT_SCOPE ? root.background : undefined) }
    : frameBackground(state.settings, resolveFrame(settings, scope), state.component.file);
  const own = rootScope ? rootOwn !== undefined : settings?.frames?.[scope]?.background !== undefined;
  const tip = overridden(state, 'background', 'background', translate);
  const inherited = !own && shown.value !== undefined && tip === undefined;
  const value = shown.value;
  const label = translate('componentCanvas.panel.background');
  assert(rootScope || state.subject === 'frame', 'The canvas root’s background is set at a root scope');
  const commit = (color: string) => {
    const trimmed = color.trim();
    // Transparent over every frame is what no setting says; for the project it is a setting of its own (no canvas grey).
    const clear = trimmed === '' || (trimmed === 'transparent' && scope === '');
    canvas.edit({ kind: 'background', value: clear ? undefined : trimmed });
  };
  return (
    <div className="props-field">
      <FieldTitle>
        {inherited ? (
          <span className="prop-label embed-editor_prop-orange component-canvas-inherited">{label}</span>
        ) : (
          <ResetLabel
            label={label}
            active={own || tip !== undefined}
            tone={tip === undefined ? undefined : 'overridden'}
            tip={tip}
            onReset={() => (tip === undefined ? canvas.edit({ kind: 'background', value: undefined }) : canvas.resetOverrides('background', 'background'))}
          />
        )}
      </FieldTitle>
      <div className="component-canvas-color">
        <ColorSwatch
          value={value ?? 'transparent'}
          ariaLabel={label}
          onChange={(color, live) => {
            // Dragging paints the frames at once and saves nothing; letting go saves once. A value let go of that is
            // what was there (a cancel) takes the paint back; any other stays until the saved one replaces it.
            if (live) {
              canvas.paintBackground(color);
            } else {
              canvas.paintBackground(undefined, color.trim() === (value ?? 'transparent').trim() ? 'restore' : 'keep');
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
  stepMin,
  onCommit,
}: {
  readonly value: string;
  readonly ariaLabel: string;
  readonly placeholder?: string;
  readonly suffix?: string;
  readonly disabled?: boolean;
  /**
   * A number field: Up and Down step the number under the caret as the Style panel's size fields do (Shift by 10,
   * Option by a tenth), never below this, and each step applies at once, the caret staying where it was.
   */
  readonly stepMin?: number;
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
          } else if (stepMin !== undefined) {
            // The Style panel's own stepping: it writes the stepped text into the field and puts the caret back.
            const stepped = stepSizeKey(event);
            if (stepped !== undefined) {
              const pixels = Math.round(Number(stepped));
              const text = Number.isFinite(pixels) && pixels < stepMin ? String(stepMin) : stepped;
              // Under the least size, the field shows the least size it was given.
              const input: HTMLInputElement = event.currentTarget;
              input.value = text;
              setDraft(text);
              onCommit(text);
            }
          }
        }}
      />
      {suffix !== undefined && <span className="component-canvas-suffix">{suffix}</span>}
    </span>
  );
}
