// Where the next edit of a frame goes: this frame, every frame of one split value, or every frame. One setting, drawn
// at the top of the Settings panel and in Frame settings (the same state, so the two always agree): prop values, slot
// content, size and background all follow it. Selecting another frame, or opening a canvas, puts it back on the frame.
import { frameKey, keyPairs } from '../../../../shared/properties/componentCanvas';
import { assert } from '../../../../shared/core/assert';
import SegmentedControl from '../../../ui/SegmentedControl';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import type { CanvasOpen, ComponentCanvasControl } from './componentCanvasSession';
import type { ModelFrame } from './canvasModel';
import { partLabel } from './frameLabel';
import './componentCanvas.css';

export interface CanvasScope {
  readonly value: string;
  readonly label: string;
  /** What the choice covers, where its label alone does not say it. */
  readonly about?: string;
}

/**
 * The scopes a frame's edits can go to, narrowest first; a frame that is also every frame has one. `group` is the key of
 * a group box selected around the frame (several split values at once), offered after the frame's own.
 */
export function frameScopes(frame: ModelFrame, translate: Translator, group?: string): readonly CanvasScope[] {
  const pairs = group === undefined ? [] : keyPairs(group);
  const grouped = frame.parts.filter((part) => pairs.includes(frameKey([part])));
  const scopes: readonly CanvasScope[] = [
    { value: frame.key, label: translate('componentCanvas.panel.scope.frame') },
    ...(group === undefined || grouped.length < 2 || group === frame.key
      ? []
      : [
          {
            value: group,
            label: grouped.map((part) => (part.value.kind === 'unset' ? translate('componentCanvas.frame.unset') : String(part.value.value))).join(' · '),
            about: translate('componentCanvas.panel.scope.part', { part: grouped.map((part) => partLabel(part, translate)).join(' · ') }),
          },
        ]),
    ...frame.parts.map((part) => ({
      value: frameKey([part]),
      // The value alone fits the panel beside the other choices; the tooltip says the whole of it.
      label: part.value.kind === 'unset' ? translate('componentCanvas.frame.unset') : String(part.value.value),
      about: translate('componentCanvas.panel.scope.part', { part: partLabel(part, translate) }),
    })),
    { value: '', label: translate('componentCanvas.panel.scope.all') },
  ];
  const distinct = scopes.filter((option, index) => scopes.findIndex((other) => other.value === option.value) === index);
  assert(distinct.length > 0, 'A frame has a scope of its own');
  return distinct;
}

export function CanvasScopeControl({ canvas, state }: { readonly canvas: ComponentCanvasControl; readonly state: CanvasOpen }) {
  const translate = useTranslate();
  const frame = state.layout.frames.find((candidate) => candidate.key === state.frame);
  if (frame === undefined) {
    return undefined;
  }
  const scopes = frameScopes(frame, translate, state.subject === 'frame' && state.picked.kind === 'group' ? state.picked.key : undefined);
  if (scopes.length < 2) {
    return undefined;
  }
  return (
    <div className="component-canvas-scope">
      <SegmentedControl
        ariaLabel={translate('componentCanvas.panel.scope.label')}
        widthMode="hug"
        value={state.scope}
        options={scopes.map((scope) => ({
          value: scope.value,
          label: <span className="component-canvas-scope-name">{scope.label}</span>,
          ...(scope.about === undefined ? {} : { tooltip: scope.about }),
        }))}
        onChange={canvas.setScope}
      />
    </div>
  );
}
