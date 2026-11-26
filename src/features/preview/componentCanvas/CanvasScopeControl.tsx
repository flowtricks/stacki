// Where a section's next edit goes, as one compact dropdown at the end of the section's heading row: "This frame",
// "All play frames" for each value the selected frame shares with others, a group's values when a group is selected,
// and "All frames", each with how many frames it reaches. A choice that would reach exactly the frames another reaches
// is left out. Each section keeps its own choice (useDesktopComponentCanvas.ts): props start at this frame, sizes at all
// frames, the background at this frame; on the canvas root the background and classes choose between this
// component's canvas and every component's. Pointing at a choice outlines on the canvas exactly the frames it changes.
import type { ReactNode } from 'react';
import { CANVAS_LIMITS, frameKey, keyPairs, scopeHolds } from '../../../../shared/properties/componentCanvas';
import { assert } from '../../../../shared/core/assert';
import Dropdown, { type DropdownOption } from '../../../ui/Dropdown';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import { COMPONENT_SCOPE, PROJECT_SCOPE, type CanvasOpen, type CanvasSection, type ComponentCanvasControl } from './componentCanvasSession';
import type { ModelFrame } from './canvasModel';
import { partLabel } from './frameLabel';
import './componentCanvas.css';

export interface CanvasScope {
  readonly value: string;
  readonly label: string;
  /** How many frames it reaches, quiet beside the label. */
  readonly hint: string;
  /** The whole of what it covers (`variant: play`), where the label shortens it. */
  readonly title?: string;
  /** The frames it reaches, for the canvas outline while it is pointed at. */
  readonly frames: readonly string[];
}

/**
 * The scopes a frame's edits can go to, narrowest first. `group` is the key of a group box selected around the frame
 * (several split values at once), offered after the frame's own. A scope reaching the same frames as one before it is
 * left out, so every row changes something different.
 */
export function frameScopes(frame: ModelFrame, frames: readonly string[], translate: Translator, group?: string): readonly CanvasScope[] {
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas has a bounded number of frames');
  const reach = (scope: string): readonly string[] => frames.filter((key) => scopeHolds(scope, key));
  const count = (scope: string): string => translate('componentCanvas.panel.frames', { count: reach(scope).length });
  const valueOf = (part: ModelFrame['parts'][number]): string =>
    part.value.kind === 'unset' ? translate('componentCanvas.frame.unset') : String(part.value.value);
  const grouped = group === undefined ? [] : frame.parts.filter((part) => keyPairs(group).includes(frameKey([part])));
  const candidates: readonly Omit<CanvasScope, 'hint' | 'frames'>[] = [
    { value: frame.key, label: translate('componentCanvas.panel.scope.frame') },
    ...(group === undefined || grouped.length < 2
      ? []
      : [
          {
            value: group,
            label: translate('componentCanvas.scope.valueFrames', { value: grouped.map(valueOf).join(' · ') }),
            title: grouped.map((part) => partLabel(part, translate)).join(' · '),
          },
        ]),
    ...frame.parts.map((part) => ({
      value: frameKey([part]),
      label: translate('componentCanvas.scope.valueFrames', { value: valueOf(part) }),
      title: partLabel(part, translate),
    })),
    { value: '', label: translate('componentCanvas.panel.scope.all') },
  ];
  // The frames each reaches, as a set: a row that reaches what an earlier one does is the same choice twice. All
  // frames is kept over a value that every frame shows, since that is what it is.
  const seen = new Set<string>();
  const distinct: CanvasScope[] = [];
  for (const candidate of candidates) {
    const reached = reach(candidate.value);
    const signature = reached.join('\n');
    const allToo = candidate.value !== '' && reached.length === frames.length && candidate.value !== frame.key;
    if (!seen.has(signature) && !allToo) {
      seen.add(signature);
      distinct.push({ ...candidate, hint: count(candidate.value), frames: reached });
    }
  }
  assert(distinct.length > 0, 'A frame has a scope of its own');
  return distinct;
}

/** The canvas root's scopes: this component's canvas, or every component's. */
function rootScopes(translate: Translator, frames: readonly string[]): readonly CanvasScope[] {
  return [
    { value: COMPONENT_SCOPE, label: translate('componentCanvas.panel.scope.component'), hint: '', frames },
    { value: PROJECT_SCOPE, label: translate('componentCanvas.panel.scope.project'), hint: '', frames },
  ];
}

/** The scopes a section offers now; the section's own value is always one of them. */
export function sectionScopes(state: CanvasOpen, section: CanvasSection, translate: Translator): readonly CanvasScope[] {
  const frames = state.layout.frames.map((candidate) => candidate.key);
  if (state.subject === 'root' && section === 'background') {
    return rootScopes(translate, frames);
  }
  const frame = state.layout.frames.find((candidate) => candidate.key === state.frame);
  if (frame === undefined) {
    return [];
  }
  return frameScopes(frame, frames, translate, state.picked.kind === 'group' && state.subject === 'frame' ? state.picked.key : undefined);
}

/** A section's heading row: its title, and the dropdown choosing where its edits go, at the row's end. */
export function CanvasSectionHeading({
  canvas,
  state,
  section,
  title,
  extra,
}: {
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly section: CanvasSection;
  readonly title: string;
  /** Beside the title (an info hint). */
  readonly extra?: ReactNode;
}) {
  const translate = useTranslate();
  const scopes = sectionScopes(state, section, translate);
  const value = state.scopes[section];
  const options: readonly DropdownOption[] = scopes.map((scope) => ({
    value: scope.value,
    label: scope.label,
    ...(scope.hint === '' ? {} : { hint: scope.hint }),
    ...(scope.title === undefined ? {} : { title: scope.title }),
  }));
  const framesOf = (scope: string | undefined): readonly string[] | undefined => scopes.find((candidate) => candidate.value === scope)?.frames;
  return (
    <div className="component-canvas-heading-row">
      <span className="component-canvas-heading-title">
        {title}
        {extra}
      </span>
      {scopes.length > 1 && scopes.some((scope) => scope.value === value) && (
        <Dropdown
          className="component-canvas-scope"
          menuClassName="component-canvas-scope-menu"
          ariaLabel={translate('componentCanvas.panel.scope.label')}
          value={value}
          options={options}
          menuWidthMin={200}
          // The rows pointed at or arrowed to outline their frames; none once the menu closes or the pointer leaves the rows.
          onHighlight={(scope) => canvas.showTargets(scope === undefined ? undefined : framesOf(scope))}
          onChange={(scope) => {
            canvas.showTargets(undefined);
            canvas.setScope(section, scope);
          }}
        />
      )}
    </div>
  );
}
