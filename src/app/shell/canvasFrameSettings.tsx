// The ordinary Navigator and Settings panel on the component canvas's page (useDesktopComponentCanvas.ts). The page is
// generated from the canvas settings, so neither panel may write it: the Navigator lists each frame's instance under
// its frame's name, and the Settings panel shows the selected frame's preview values (src/app/model/canvasPanelValues.ts)
// with every writer it has replaced by one that goes to `.stacki/component-canvas.json`: a writer left as the page's
// would be refused, since the page is never edited. Beside each prop that can be split
// into frames, next to its {} button, a toggle gives each of its values a frame of its own; a prop that is split is
// the frame's own and is greyed out, since each of its values already has a frame.
//
// Here in the app layer because it joins three features: the props panel's row extras (features/props), the canvas
// (features/preview) and the navigator's tree (features/structure).
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { toNodeId, type NodeId } from '../../../shared/core/brand';
import { can } from '../../../shared/properties/projectRoles';
import {
  CANVAS_LIMITS,
  canvasContent,
  canvasRoot,
  frameKey,
  keyPairs,
  resolveFrame,
  settingLevel,
  type ComponentCanvas,
  type FrameEdit,
  type FrameSetting,
} from '../../../shared/properties/componentCanvas';
import type { Attr } from '../../../shared/page/pageNodeTypes';
import { nodeAtPath } from '../../editor/editorTree';
import type { EditorNode } from '../../editor/pageView';
import { trailOf } from '../model/pageGestures';
import {
  canvasInstanceOf,
  COMPONENT_SCOPE,
  isCanvasRoot,
  isComponentCanvasPage,
  PROJECT_SCOPE,
  type CanvasOpen,
  type ComponentCanvasControl,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { splitPartOf, type ModelFrame } from '../../features/preview/componentCanvas/canvasModel';
import { contentFieldNodes, contentHTML, frameEditOf, framePickEdit, framePanelValues } from '../model/canvasPanelValues';
import type { PropValues } from '../../features/props/propRules';
import type { PropsPanelProps } from '../../features/props/propsPanelTypes';
import { richTextNodes, richTextView } from '../../features/props/richTextContent';
import { groupFrames, type CanvasTreeItem } from '../../features/preview/componentCanvas/canvasGroups';
import { frameLabel, partLabel } from '../../features/preview/componentCanvas/frameLabel';
import type { PropFieldAction, PropFieldExtras, PropFieldProvenance } from '../../features/props/propFieldExtras';
import { CanvasIcon } from '../../ui/Icons';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ShellView } from '../App';
import type { StructurePageState } from '../../features/structure/structureModel';

/**
 * The Navigator on the canvas page: the canvas root (the page's <html>), and under it the canvas as it is grouped, one
 * row per box and one per frame (its instance), each named with what the rows above it do not say. A box row folds;
 * it is not an element, so it selects nothing (`groups`).
 */
export interface CanvasNavigatorView {
  readonly pageState: StructurePageState;
  readonly rowLabels: ReadonlyMap<string, string>;
  readonly groups: ReadonlySet<string>;
}

export function canvasNavigatorView(app: ShellView, canvas: ComponentCanvasControl | undefined, translate: Translator): CanvasNavigatorView | undefined {
  const state = canvas?.state;
  const pageState = app.pageState;
  if (state?.kind !== 'open' || pageState?.editable !== true || !atCanvasPage(app)) {
    return undefined;
  }
  const labels = new Map<string, string>();
  const groups = new Set<string>();
  const paths = new Map(state.instances.map((instance) => [instance.key, instance.path]));
  const rows = (items: readonly CanvasTreeItem[], depth: number): EditorNode[] => {
    assert(depth <= CANVAS_LIMITS.splitPropsMax, 'The canvas Navigator nests no deeper than the split');
    return items.flatMap((item): EditorNode[] => {
      if (item.kind === 'group') {
        const children = rows(item.children, depth + 1);
        const id = panelNodeId(`${state.component.file}|group|${item.key}`);
        labels.set(id, frameLabel({ parts: item.header }, state.component, translate));
        groups.add(id);
        return [{ kind: 'element', id, name: 'div', props: {}, children }];
      }
      const path = paths.get(item.key);
      const node = path === undefined ? undefined : nodeAtPath(pageState.model.nodes, trailOf(path));
      if (node?.kind !== 'component') {
        return [];
      }
      labels.set(node.id, frameLabel({ parts: item.caption }, state.component, translate));
      // Closed, as an instance on a page is: what is inside it is opened from the row, not edited in the canvas page.
      return [{ ...node, children: undefined }];
    });
  };
  const nodes = rows(groupFrames(state.layout.frames), 0);
  const root = nodeAtPath(pageState.model.nodes, trailOf(state.root));
  assert(root?.kind === 'element', 'The canvas root is the page’s <html> element');
  // The root's own children are the canvas's chrome; in the Navigator they are the boxes and frames.
  labels.set(root.id, 'html'); // i18n-ignore: the element's own tag name, as every element row is named.
  return { pageState: { ...pageState, model: { ...pageState.model, nodes: [{ ...root, children: nodes }] } }, rowLabels: labels, groups };
}

/**
 * What the Settings panel does differently on the canvas page: for a frame's instance, its values and writers are the
 * frame's preview values; for the canvas root (<html>), its one field is class, the root's classes at the root's scope.
 */
export type CanvasInstanceSettings =
  | { readonly kind: 'instance'; readonly extras: PropFieldExtras; readonly panel: CanvasFramePanel }
  | { readonly kind: 'root'; readonly classes: readonly string[]; readonly onSetProp: (name: string, value: Attr | undefined) => void };

/** The settings panel's values and writers for a frame, in the panel's own props (propsPanelTypes.ts). */
export type CanvasFramePanel = Pick<
  PropsPanelProps,
  'schema' | 'onSetProp' | 'onSetProps' | 'onReplaceProps' | 'onSetAssetProp' | 'onSetInline' | 'onSetContentSource' | 'contentValue' | 'offersStyle'
> & {
  /** Names the instance by its frame and scope, so a field holds nothing over from another one. */
  readonly id: NodeId;
  readonly props: Readonly<Record<string, Attr>>;
  readonly frontmatterSource: string;
  readonly contentSource: string;
};

export function useCanvasInstanceSettings(app: ShellView, canvas: ComponentCanvasControl | undefined): CanvasInstanceSettings | undefined {
  const translate = useTranslate();
  const role = useCurrentRole();
  const drafts = useUnfinishedCode((name) => app.showToast(translate('componentCanvas.error.previewValue', { name }), 'info'));
  const state = canvas?.state;
  const path = app.pathFor(app.selectedId);
  if (canvas === undefined || state?.kind !== 'open' || !atCanvasPage(app)) {
    return undefined;
  }
  if (isCanvasRoot(path)) {
    return rootSettings(canvas, state);
  }
  const instance = canvasInstanceOf(path);
  const frame = instance === undefined ? undefined : state.layout.frames.find((candidate) => candidate.key === instance.key);
  if (frame === undefined) {
    return undefined;
  }
  // Splitting changes the canvas settings everyone shares, which only a role that may edit components does.
  const mayEdit = can(role, 'component:edit');
  return {
    kind: 'instance',
    extras: (name) => {
      const candidate = state.layout.candidates.find((entry) => entry.name === name);
      const split = splitPartOf(frame, name) !== undefined;
      return {
        ...(candidate === undefined || !mayEdit
          ? {}
          : {
              action: splitAction(state, { name, count: candidate.values.length }, { canvas, translate, onRefused: (text) => app.showToast(text, 'info') }),
            }),
        ...(split ? { lockedReason: translate('componentCanvas.split.locked', { name }) } : provenanceExtra(state, frame, `prop:${name}`, translate)),
      };
    },
    panel: framePanel({ app, canvas, state, frame, drafts, translate }),
  };
}

interface FrameWriting {
  readonly app: ShellView;
  readonly canvas: ComponentCanvasControl;
  readonly state: CanvasOpen;
  readonly frame: ModelFrame;
  readonly drafts: UnfinishedCode;
  readonly translate: Translator;
}

function framePanel(writing: FrameWriting): CanvasFramePanel {
  const { app, canvas, state, frame, drafts, translate } = writing;
  // A root scope belongs to the canvas root; a frame's fields then write to the frame.
  const scope = state.scope === PROJECT_SCOPE || state.scope === COMPONENT_SCOPE ? frame.key : state.scope;
  const id = panelNodeId(`${state.id}|${frame.key}|${scope}`);
  const values = framePanelValues({
    schema: app.selectedSchema,
    rest: state.component.rest === true,
    settings: state.settings.components[state.component.file],
    frame,
    scope,
    defaults: state.defaults,
  });
  const refuse = (name: string): void => {
    app.showToast(translate('componentCanvas.error.previewValue', { name }), 'info');
  };
  const write = (edits: readonly FrameEdit[]): void => canvas.editValues(scope, edits);
  // A split prop is the frame's own: greyed out, and refused here as well.
  const editsOf = (patch: PropValues): readonly FrameEdit[] =>
    Object.entries(patch).flatMap(([name, value]) => {
      if (splitPartOf(frame, name) !== undefined) {
        return [];
      }
      const edit = frameEditOf(name, value, values.bindings);
      if (edit === undefined) {
        refuse(name);
        return [];
      }
      return [edit];
    });
  const setProp: PropsPanelProps['onSetProp'] = (name, value, immediate) => {
    if (splitPartOf(frame, name) !== undefined) {
      return;
    }
    const edit = frameEditOf(name, value, values.bindings);
    if (edit !== undefined) {
      drafts.drop();
      write([edit]);
    } else if (value !== undefined) {
      // Code on its way to being a value (a quote not yet closed) is held in its field, not refused at each key.
      drafts.hold({ id, name, value }, immediate === true ? 'now' : 'later');
    }
  };
  const writeContent = (html: string): void => {
    if (html === values.content.html) {
      return;
    }
    try {
      canvasContent(html);
    } catch {
      refuse(translate('props.element.content'));
      return;
    }
    write([{ kind: 'content', value: html }]);
  };
  return {
    id,
    props: drafts.held?.id === id ? { ...values.props, [drafts.held.name]: drafts.held.value } : values.props,
    schema: values.schema,
    frontmatterSource: values.imports,
    offersStyle: state.component.rest === true,
    onSetProp: setProp,
    onSetProps: (_nodeId: string, patch: PropValues) => write(editsOf(patch)),
    onReplaceProps: (_nodeId: string, props: Readonly<Record<string, Attr>>) => write(editsOf(props)),
    onSetAssetProp: (_nodeId, name, picked, reference, also) => {
      const edit = framePickEdit(name, picked, reference);
      if (edit === undefined) {
        refuse(name);
      } else {
        write([edit, ...editsOf(also ?? {})]);
      }
    },
    onSetInline: (nodes) => writeContent(contentHTML(nodes)),
    onSetContentSource: (source) => {
      const view = richTextView(source, document);
      // Expressions and components are code the canvas never runs; every other markup is shown as written.
      if (view.view === 'code' && (view.reason === 'expression' || view.reason === 'component')) {
        refuse(translate('props.element.content'));
      } else {
        writeContent(source);
      }
    },
    contentSource: values.content.html,
    contentValue: {
      nodes: contentFieldNodes(richTextNodes(values.content.html, document)),
      own: values.content.own,
      ...provenanceExtra(state, frame, 'content', translate),
      onReset: () => write([{ kind: 'content', value: undefined }]),
    },
  };
}

// A node id in the gesture form (shared/core/brand.ts), the same for the same words: four rounds of FNV-1a.
function panelNodeId(words: string): NodeId {
  let hex = '';
  for (let round = 0; round < 4; round++) {
    let hash = 0x811c9dc5 ^ round;
    for (let index = 0; index < words.length; index++) {
      hash = Math.imul(hash ^ words.charCodeAt(index), 0x01000193);
    }
    hex += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return toNodeId(`g${hex}`);
}

// Where a setting shown at the current scope comes from, when that is not the scope itself: a wider level that gives
// it, or a narrower one the selected frame has, which wins on that frame whatever is set here.
function provenanceExtra(state: CanvasOpen, frame: ModelFrame, setting: FrameSetting, translate: Translator): { readonly provenance?: PropFieldProvenance } {
  const scope = state.scope === PROJECT_SCOPE || state.scope === COMPONENT_SCOPE ? frame.key : state.scope;
  const settings = state.settings.components[state.component.file];
  const level = settingLevel(settings, frame.key, scope, setting);
  if (level.kind === 'own' || level.kind === 'none') {
    return {};
  }
  const source = level.kind === 'inherited' ? level.from : level.by;
  const tone = level.kind === 'overridden' && entryAt(settings, scope, setting) ? 'noted' : 'inherited';
  return { provenance: { tone, tip: levelTip(source, frame, translate) } };
}

// Whether the scope's own entry holds the setting.
function entryAt(settings: ComponentCanvas | undefined, scope: string, setting: FrameSetting): boolean {
  return resolveFrame(settings, scope).origins.get(setting) === scope;
}

// Who a value is set for, by the key of its entry as this frame meets it.
function levelTip(source: string, frame: ModelFrame, translate: Translator): string {
  if (source === frame.key && source !== '') {
    return translate('componentCanvas.level.frame');
  }
  if (source === '') {
    return translate('componentCanvas.level.all');
  }
  const named = frame.parts.filter((part) => keyPairs(source).includes(frameKey([part]))).map((part) => partLabel(part, translate));
  return translate('componentCanvas.level.part', { part: named.join(' · ') });
}

interface Unfinished {
  readonly id: string;
  readonly name: string;
  readonly value: Attr;
}

interface UnfinishedCode {
  readonly held: Unfinished | undefined;
  readonly hold: (draft: Unfinished, when: 'now' | 'later') => void;
  readonly drop: () => void;
}

// How long typed code may stay unfinished before the field is told it has no preview value.
const UNFINISHED_CODE_MS = 2_500;

// What is typed in a field's code view and stores nothing yet: shown in the field until it becomes a value, and said
// once when typing stops there.
function useUnfinishedCode(onRefused: (name: string) => void): UnfinishedCode {
  const [held, setHeld] = useState<Unfinished | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return {
    held,
    hold: (draft, when) => {
      clearTimeout(timer.current);
      setHeld(draft);
      if (when === 'now') {
        onRefused(draft.name);
      } else {
        timer.current = setTimeout(() => onRefused(draft.name), UNFINISHED_CODE_MS);
      }
    },
    drop: () => {
      clearTimeout(timer.current);
      setHeld(undefined);
    },
  };
}

// The canvas root's class field: the classes the root draws with, written to the root's "Apply to" scope (Frame
// settings). Cleared, the scope's own list goes and a wider one shows; names a class cannot have are refused there.
function rootSettings(canvas: ComponentCanvasControl, state: CanvasOpen): CanvasInstanceSettings {
  const classes = canvasRoot(state.settings, state.component.file).classes;
  assert(classes.length <= CANVAS_LIMITS.rootClassesMax, 'The canvas root carries a bounded number of classes');
  return {
    kind: 'root',
    classes,
    onSetProp: (name, value) => {
      if (name !== 'class') {
        return; // The root's only field: anything else is the generated page's and is never written.
      }
      const text = value?.type === 'string' ? value.value.trim() : '';
      canvas.editRootClasses(text === '' ? undefined : [...new Set(text.split(/\s+/))]);
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
