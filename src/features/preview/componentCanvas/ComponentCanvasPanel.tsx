// Frame settings, in the popover over the component canvas (ComponentCanvasFramePopup.tsx): the size, background and
// layout of what is selected on the canvas or in the Navigator. One "Apply to" at the top says which frames an edit
// reaches (CanvasScopeControl.tsx), and every one of them then shows it; it starts at this frame. Where the frames in
// scope differ, the field says so, its label is the Style panel's orange, and Reset gives them all one value. Layout
// arranges the groups the scope holds, or on the canvas root the page itself. Which props get their own frames and the
// frames' preview values are the Settings panel's (src/app/shell/canvasFrameSettings.tsx).
import { useEffect, useState, type ReactNode, type KeyboardEvent } from 'react';
import { assert } from '../../../../shared/core/assert';
import {
  levelArrangement,
  CANVAS_LEVEL,
  CANVAS_LIMITS,
  canvasRoot,
  type CanvasArrangement,
  frameBackground,
  sharedOverrides,
  resolveFrame,
  scopeHolds,
  settingMixed,
  type FrameLength,
  type SharedSetting,
} from '../../../../shared/properties/componentCanvas';
import { ArrowDownIcon, ArrowRightIcon, RowWrapIcon } from '../../../ui/Icons';
import InfoHint from '../../../ui/InfoHint';
import SegmentedControl from '../../../ui/SegmentedControl';
import { ResetLabel } from '../../../ui/ResetLabel';
import { ComponentFillIcon } from '../../../ui/Icons';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import ColorSwatch from '../../style/components/ColorSwatch';
import VariableConnect from '../../style/VariableConnect';
import { prettyComponentName } from './frameLabel';
import { canvasLevels, groupFrames, layoutTargets } from './canvasGroups';
import { CanvasSectionHeading } from './CanvasScopeControl';
import { COMPONENT_SCOPE, PROJECT_SCOPE, type CanvasOpen, type ComponentCanvasControl } from './componentCanvasSession';
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
      <section className="component-canvas-section component-canvas-scope-row">
        <CanvasSectionHeading canvas={canvas} state={state} section="frame" title={translate('componentCanvas.panel.scope.label')} />
      </section>
      {state.subject === 'root' ? <RootSection canvas={canvas} state={state} /> : <FrameSection canvas={canvas} state={state} />}
    </div>
  );
}

function FrameSection({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const reached = new Set(framesInScope(state));
  const targets = layoutTargets(groupFrames(state.layout.frames), reached);
  return (
    <>
      <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.size')}>
        <SectionTitle title={translate('componentCanvas.panel.size')} />
        <LengthField side="width" canvas={canvas} state={state} />
        <LengthField side="height" canvas={canvas} state={state} />
      </section>
      <section className="component-canvas-section" aria-label={translate('componentCanvas.panel.background')}>
        <BackgroundField canvas={canvas} state={state} />
      </section>
      {/* Only a group of several has children to lay out: where the scope holds none, there is no Layout. */}
      {targets.length > 0 && <LayoutSection canvas={canvas} state={state} targets={targets} />}
    </>
  );
}

function SectionTitle({ title, extra }: { readonly title: string; readonly extra?: ReactNode }) {
  return (
    <div className="component-canvas-heading-row">
      <span className="component-canvas-heading-title">
        {title}
        {extra}
      </span>
    </div>
  );
}

// The frames Frame settings' scope reaches; none at a root scope.
function framesInScope(state: CanvasOpen): readonly string[] {
  const scope = state.scopes.frame;
  return state.layout.frames.map((candidate) => candidate.key).filter((key) => scopeHolds(scope, key));
}

// How the direct children of each level the control arranges are laid out: the canvas's own (while <html> is
// selected), or every group the scope holds. A level somebody chose is a set value (blue, with Reset back to the
// defaults); one nobody chose is plain; levels arranged differently show no choice, in orange, until one is made.
function LayoutSection({
  canvas,
  state,
  targets,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly targets: readonly string[];
}) {
  const translate = useTranslate();
  const title = translate('componentCanvas.panel.layout');
  const levels = canvasLevels(groupFrames(state.layout.frames), state.layout.frames);
  const found = targets.map((level) => levelArrangement(state.settings.components[state.component.file], level, levels));
  const shown = new Set(found.map((level) => level.value));
  const first = found[0];
  assert(first !== undefined, 'A Layout control arranges a level');
  const value: CanvasArrangement | 'mixed' = shown.size === 1 ? first.value : 'mixed';
  const chosen = found.some((level) => level.chosen);
  // Drawn with the Style panel's direction icons; each choice's words are its tooltip and accessible name.
  const option = (arrangement: CanvasArrangement, icon: ReactNode, name: string) => ({
    value: arrangement,
    label: icon,
    ariaLabel: name,
    tooltip: name,
  });
  const options = [
    option('row', <ArrowRightIcon />, translate('componentCanvas.panel.layout.row')),
    option('column', <ArrowDownIcon />, translate('componentCanvas.panel.layout.column')),
    option('wrap', <RowWrapIcon />, translate('componentCanvas.panel.layout.wrap')),
  ];
  return (
    <section className="component-canvas-section" aria-label={title}>
      <div className="component-canvas-heading-row">
        <span className="component-canvas-heading-title">
          <ResetLabel
            label={title}
            active={chosen}
            tone={value === 'mixed' ? 'overridden' : undefined}
            tip={value === 'mixed' ? translate('componentCanvas.level.mixedLayout') : undefined}
            onReset={() => canvas.setArrangement(targets, undefined)}
          />
        </span>
        {/* The layout is never shared: at All components it says whose it is. */}
        {state.scopes.frame === PROJECT_SCOPE && <span className="component-canvas-own">{translate('componentCanvas.panel.scope.component')}</span>}
      </div>
      <div className="props-field">
        <SegmentedControl<CanvasArrangement | 'mixed'>
          // Levels of their own: the highlight never slides over from the levels shown before.
          key={targets.join('\n')}
          className="component-canvas-arrangement"
          ariaLabel={title}
          value={value}
          options={options}
          onChange={(next) => {
            if (next !== value && next !== 'mixed') {
              canvas.setArrangement(targets, next);
            }
          }}
        />
      </div>
    </section>
  );
}

// The canvas itself, while its root (the page's <html>) is selected: its background, the surface every frame sits on,
// for this component's canvas or every component's, and how its top-level groups are laid out. Its classes are the
// Settings panel's class field (canvasFrameSettings.tsx), at the same choice.
function RootSection({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const title = translate('componentCanvas.panel.root.title');
  return (
    <>
      <section className="component-canvas-section" aria-label={title}>
        <SectionTitle title={title} extra={<InfoHint text={translate('componentCanvas.panel.root.about')} />} />
        <BackgroundField canvas={canvas} state={state} />
      </section>
      <LayoutSection canvas={canvas} state={state} targets={[CANVAS_LEVEL]} />
    </>
  );
}

interface Differences {
  /** Whether the frames in scope show different values: the field then says Mixed rather than one frame's value. */
  readonly mixed: boolean;
  /** What the label's tip says: that the frames differ, and which keep a value of their own. */
  readonly tip: string | undefined;
  /** How many frames in scope Reset would change. */
  readonly count: number;
}

// How the frames in scope stand for `setting`, said in the label's tip.
function differences(state: CanvasOpen, setting: SharedSetting, translate: Translator): Differences {
  const scope = state.scopes.frame;
  if (scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE) {
    return { mixed: false, tip: undefined, count: 0 };
  }
  const settings = state.settings.components[state.component.file];
  const frames = state.layout.frames.map((candidate) => candidate.key);
  const mixed = settingMixed(settings, frames, scope, setting);
  const found = sharedOverrides(settings, frames, scope, setting);
  const reached = framesInScope(state).length;
  assert(found.length <= reached, 'Only frames in scope keep their own value');
  const differ = mixed ? translate('componentCanvas.level.mixedShared', { count: reached }) : undefined;
  if (found.length === 0) {
    return { mixed, tip: differ, count: 0 };
  }
  const count = translate('componentCanvas.level.overrides', { count: found.length });
  // The selected frame among them is said first.
  const own = found.includes(state.frame) && reached > 1 ? `${translate('componentCanvas.level.frame')}. ${count}` : count;
  return { mixed, tip: differ === undefined ? own : `${differ} ${own}`, count: found.length };
}

// What the frames in scope show where they all show the same: any one of them speaks for all.
function sharedFrame(state: CanvasOpen) {
  const key = framesInScope(state)[0];
  assert(key !== undefined, 'A frame scope reaches a frame');
  return resolveFrame(state.settings.components[state.component.file], key);
}

function LengthField({ side, canvas, state }: { readonly side: 'width' | 'height'; readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const label = translate(side === 'width' ? 'componentCanvas.panel.width' : 'componentCanvas.panel.height');
  const scope = state.scopes.frame;
  const settings = state.settings.components[state.component.file];
  // What the frames in scope show; while the selected frame is being resized on the canvas, the size the pointer gives it.
  const dragged = state.resizing?.frame === state.frame ? state.resizing[side] : undefined;
  // Frames in scope that differ: hug and fixed together select neither; fixed sizes alone leave the pixels empty.
  const lengths = sideValues(state, side);
  const shownMixed = dragged === undefined && lengths.length > 1;
  const value = dragged ?? (shownMixed ? (lengths.every((length) => length !== 'hug') ? 'mixed' : 'unknown') : sharedFrame(state)[side]);
  const own = settings?.frames?.[scope]?.[side] !== undefined;
  const { tip, count } = differences(state, side, translate);
  // Hug over all frames is what no setting says, so it is written as no setting rather than as "hug".
  const set = (next: FrameLength) => canvas.edit({ kind: 'field', field: side, value: next === 'hug' && scope === '' ? undefined : next });
  return (
    <div className="props-field">
      <FieldTitle>
        <ResetLabel
          label={label}
          active={own || count > 0}
          tone={tip === undefined ? undefined : 'overridden'}
          tip={tip}
          onReset={() => (count === 0 ? canvas.edit({ kind: 'field', field: side, value: undefined }) : canvas.resetOverrides('frame', side))}
        />
      </FieldTitle>
      <div className="component-canvas-length">
        <SegmentedControl<'hug' | 'fixed' | 'unknown'>
          ariaLabel={label}
          value={value === 'hug' ? 'hug' : value === 'unknown' ? 'unknown' : 'fixed'}
          options={[
            { value: 'hug', label: translate('componentCanvas.panel.hug') },
            { value: 'fixed', label: translate('componentCanvas.panel.fixed') },
          ]}
          onChange={(mode) => set(mode === 'hug' ? 'hug' : fixedStart(canvas, state, side))}
        />
        {value !== 'hug' && value !== 'unknown' && (
          <CommitInput
            ariaLabel={translate('componentCanvas.panel.pixels', { side: label })}
            value={value === 'mixed' ? '' : String(value)}
            {...(value === 'mixed' ? { placeholder: translate('componentCanvas.panel.mixed') } : {})}
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

// The distinct sizes the frames in scope show for a side, so the field can tell when they differ.
function sideValues(state: CanvasOpen, side: 'width' | 'height'): readonly FrameLength[] {
  const settings = state.settings.components[state.component.file];
  const shown = new Set(framesInScope(state).map((key) => resolveFrame(settings, key)[side]));
  assert(shown.size <= state.layout.frames.length, 'Each frame shows one size for a side');
  return [...shown];
}

// The background the frames in scope show: their own, a wider scope's, the component's, or the project's canvas
// background. A value set here is the blue label (reset clears it); one that comes from a wider level is the orange,
// inherited label, as the Style panel shows an inherited value; frames in scope that keep their own make it orange
// with a reset that gives them this one.
function BackgroundField({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const scope = state.scopes.frame;
  // At a root scope the field is the canvas surface: the component's own, else the project's (inherited at the component).
  const rootScope = scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE;
  const root = canvasRoot(state.settings, state.component.file);
  const settings = state.settings.components[state.component.file];
  const rootOwn = scope === PROJECT_SCOPE ? state.settings.background : settings?.root?.background;
  const shown = rootScope
    ? { value: rootOwn ?? (scope === COMPONENT_SCOPE ? root.background : undefined) }
    : frameBackground(state.settings, sharedFrame(state), state.component.file);
  const own = rootScope ? rootOwn !== undefined : settings?.frames?.[scope]?.background !== undefined;
  const { tip, count, mixed } = differences(state, 'background', translate);
  const inherited = !own && shown.value !== undefined && tip === undefined;
  // Frames in scope that differ show no one colour: the swatch is empty and the field says Mixed.
  const differ = !rootScope && mixed;
  const value = differ ? undefined : shown.value;
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
          <span
            className="prop-label embed-editor_prop-orange component-canvas-inherited"
            // The canvas root borrows only from every component's canvas, and says so.
            title={rootScope ? translate('componentCanvas.panel.scope.project') : undefined}
          >
            {label}
          </span>
        ) : (
          <ResetLabel
            label={label}
            active={own || count > 0}
            tone={tip === undefined ? undefined : 'overridden'}
            tip={tip}
            onReset={() => (count === 0 ? canvas.edit({ kind: 'background', value: undefined }) : canvas.resetOverrides('frame', 'background'))}
          />
        )}
      </FieldTitle>
      <div
        className="component-canvas-color"
        // A colour borrowed from every component's canvas shows only as the empty field's placeholder: Backspace or Delete
        // there removes it here (Transparent, the page's own background), as in the class field. Read on the row, since
        // what is typed into is the variable editor drawn over the input.
        onKeyDownCapture={(event) => {
          const borrowed = scope === COMPONENT_SCOPE && inherited;
          if (borrowed && !event.repeat && emptyTextField(event) && (event.key === 'Backspace' || event.key === 'Delete')) {
            event.preventDefault();
            commit('transparent');
          }
        }}
      >
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
          value={own && !differ ? (value ?? '') : ''}
          placeholder={differ ? translate('componentCanvas.panel.mixed') : inherited ? (value ?? '') : translate('componentCanvas.panel.transparent')}
          label={label}
          connectLabel={translate('componentCanvas.panel.backgroundVariable')}
          onCommit={commit}
        />
      </div>
    </div>
  );
}

// Whether a key landed in an empty text field of the row itself, not in a popover opened from it (a portal's events
// reach the row through React, from outside its element).
function emptyTextField(event: KeyboardEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element) || !event.currentTarget.contains(target)) {
    return false;
  }
  if (target instanceof HTMLInputElement) {
    return target.value === '';
  }
  return target.matches('[contenteditable="true"]') && target.textContent === '';
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
