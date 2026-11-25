// The ordinary Navigator and Settings panel on the component canvas's page (useDesktopComponentCanvas.ts). The page is
// generated from the canvas settings, so neither panel may write it: the Navigator lists each frame's instance under
// its frame's name, and the Settings panel shows the selected instance's props as the frame renders them, with every
// change going to that frame's preview values in `.stacki/component-canvas.json`. Beside each prop that can be split
// into frames, next to its {} button, a toggle gives each of its values a frame of its own; a prop that is split is
// the frame's own and is greyed out, since each of its values already has a frame.
//
// Here in the app layer because it joins three features: the props panel's row extras (features/props), the canvas
// (features/preview) and the navigator's tree (features/structure).
import { assert } from '../../../shared/core/assert';
import { can } from '../../../shared/properties/projectRoles';
import { CANVAS_LIMITS } from '../../../shared/properties/componentCanvas';
import type { Attr } from '../../../shared/page/pageNodeTypes';
import { nodeAtPath } from '../../editor/editorTree';
import { trailOf } from '../model/pageGestures';
import {
  canvasInstanceOf,
  isComponentCanvasPage,
  PROJECT_SCOPE,
  type CanvasOpen,
  type ComponentCanvasControl,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { previewValue, splitPartOf } from '../../features/preview/componentCanvas/canvasModel';
import { frameLabel } from '../../features/preview/componentCanvas/frameLabel';
import type { PropFieldAction, PropFieldExtras } from '../../features/props/propFieldExtras';
import { CanvasIcon } from '../../ui/Icons';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ShellView } from '../App';
import type { StructurePageState } from '../../features/structure/structureModel';

/** The Navigator on the canvas page: one row per frame, its instance, named as the frame is. */
export interface CanvasNavigatorView {
  readonly pageState: StructurePageState;
  readonly rowLabels: ReadonlyMap<string, string>;
}

export function canvasNavigatorView(app: ShellView, canvas: ComponentCanvasControl | undefined, translate: Translator): CanvasNavigatorView | undefined {
  const state = canvas?.state;
  const pageState = app.pageState;
  if (state?.kind !== 'open' || pageState?.editable !== true || !atCanvasPage(app)) {
    return undefined;
  }
  const labels = new Map<string, string>();
  const nodes = state.instances.flatMap((instance) => {
    const node = nodeAtPath(pageState.model.nodes, trailOf(instance.path));
    const frame = state.layout.frames.find((candidate) => candidate.key === instance.key);
    if (node?.kind !== 'component' || frame === undefined) {
      return [];
    }
    labels.set(node.id, frameLabel(frame, state.component, translate));
    // Closed, as an instance on a page is: what is inside it is opened from the row, not edited in the canvas page.
    return [{ ...node, children: undefined }];
  });
  assert(nodes.length <= CANVAS_LIMITS.framesMax, 'The canvas Navigator lists a bounded number of frames');
  return { pageState: { ...pageState, model: { ...pageState.model, nodes } }, rowLabels: labels };
}

/** What the Settings panel does differently while a frame's instance is selected on the canvas page. */
export interface CanvasInstanceSettings {
  readonly extras: PropFieldExtras;
  readonly onSetProp: (name: string, value: Attr | undefined) => void;
}

export function useCanvasInstanceSettings(app: ShellView, canvas: ComponentCanvasControl | undefined): CanvasInstanceSettings | undefined {
  const translate = useTranslate();
  const role = useCurrentRole();
  const state = canvas?.state;
  const path = app.pathFor(app.selectedId);
  if (canvas === undefined || state?.kind !== 'open' || !atCanvasPage(app)) {
    return undefined;
  }
  const instance = canvasInstanceOf(path);
  const frame = instance === undefined ? undefined : state.layout.frames.find((candidate) => candidate.key === instance.key);
  if (frame === undefined) {
    return undefined;
  }
  // Splitting changes the canvas settings everyone shares, which only a role that may edit components does.
  const mayEdit = can(role, 'component:edit');
  return {
    extras: (name) => {
      const candidate = state.layout.candidates.find((entry) => entry.name === name);
      const split = splitPartOf(frame, name) !== undefined;
      return {
        ...(candidate === undefined || !mayEdit
          ? {}
          : {
              action: splitAction(state, { name, count: candidate.values.length }, { canvas, translate, onRefused: (text) => app.showToast(text, 'info') }),
            }),
        ...(split ? { lockedReason: translate('componentCanvas.split.locked', { name }) } : {}),
      };
    },
    onSetProp: (name, value) => {
      if (splitPartOf(frame, name) !== undefined) {
        return; // A split prop is the frame's own: greyed out, and refused here as well.
      }
      if (value === undefined) {
        // Cleared: back to what a wider scope or the insertion defaults give, or, set nowhere wider, not given at all.
        const scope = state.scope === PROJECT_SCOPE ? state.frame : state.scope;
        const own = state.settings.components[state.component.file]?.frames?.[scope]?.props?.[name] !== undefined;
        canvas.editProp(own ? { kind: 'inherit', name } : { kind: 'unset', name });
        return;
      }
      const preview = previewValue(value);
      if (preview === undefined) {
        app.showToast(translate('componentCanvas.error.previewValue', { name }), 'info');
        return;
      }
      canvas.editProp({ kind: 'prop', name, value: preview });
    },
  };
}

// Whether the open file is the component canvas's page itself, not an instance opened inside it.
function atCanvasPage(app: ShellView): boolean {
  return isComponentCanvasPage(app.currentPage?.path) && app.editStack.length <= 1;
}

// The own-frames toggle beside a prop's {}: drawn by the props row as the {} is (PropFieldLabel.tsx), pressed while
// the prop is split. At the limit it stays pressable and says why in a toast.
function splitAction(
  state: CanvasOpen,
  field: { readonly name: string; readonly count: number },
  context: { readonly canvas: ComponentCanvasControl; readonly translate: Translator; readonly onRefused: (text: string) => void },
): PropFieldAction {
  const { name, count } = field;
  const { canvas, translate, onRefused } = context;
  const split = state.layout.split;
  const on = split.includes(name);
  const full = !on && split.length >= CANVAS_LIMITS.splitPropsMax;
  assert(split.length <= CANVAS_LIMITS.splitPropsMax, 'The split stays inside its bound');
  const label = on
    ? translate('componentCanvas.split.on', { name })
    : full
      ? translate('componentCanvas.split.full', { max: CANVAS_LIMITS.splitPropsMax })
      : translate('componentCanvas.split.off', { name, count });
  return {
    icon: <CanvasIcon size={12} />,
    label,
    pressed: on,
    refused: full,
    onPress: () => {
      if (full) {
        onRefused(label);
      } else {
        canvas.setSplit(on ? split.filter((entry) => entry !== name) : [...split, name]);
      }
    },
  };
}
