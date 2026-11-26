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
import { schemaFor, trailOf } from '../model/pageGestures';
import {
  canvasBoxOf,
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
import { CANVAS_FRAME_TAG, CANVAS_GROUP_TAG, canvasBoxLabel } from '../../features/preview/componentCanvas/canvasPage';
import { partLabel } from '../../features/preview/componentCanvas/frameLabel';
import type { PropFieldAction, PropFieldExtras, PropFieldProvenance } from '../../features/props/propFieldExtras';
import { CanvasIcon } from '../../ui/Icons';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { ShellView } from '../App';
import type { StructurePageState } from '../../features/structure/structureModel';

/**
 * The Navigator on the canvas page: the canvas root (the page's <html>), and under it the boxes the canvas draws, as
 * the page holds them: a div per group, named with its heading, and a div per frame, named with its caption, holding the
 * frame's instance (closed, under the component's own name). The rows are the page's own nodes, so selecting, hovering,
 * the arrow keys and revealing work on them as on any page; only the page's scaffolding (its <body>, its styles and
 * script) is left out, and the boxes are listed as the divs they stand for.
 */
export interface CanvasNavigatorView {
  readonly pageState: StructurePageState;
  readonly rowLabels: ReadonlyMap<string, string>;
  /** The boxes' node ids: their captions are drawn with ::before, which is the canvas's, not a layer of theirs. */
  readonly boxIds: ReadonlySet<string>;
}

export function canvasNavigatorView(app: ShellView, canvas: ComponentCanvasControl | undefined): CanvasNavigatorView | undefined {
  const state = canvas?.state;
  const pageState = app.pageState;
  if (state?.kind !== 'open' || pageState?.editable !== true || !atCanvasPage(app)) {
    return undefined;
  }
  const labels = new Map<string, string>();
  const boxIds = new Set<string>();
  const rows = (children: readonly EditorNode[], depth: number): EditorNode[] => {
    assert(depth <= CANVAS_LIMITS.splitPropsMax, 'The canvas Navigator nests no deeper than the split');
    return children.flatMap((child): EditorNode[] => {
      if (child.kind !== 'element' || (child.name !== CANVAS_GROUP_TAG && child.name !== CANVAS_FRAME_TAG)) {
        return [];
      }
      labels.set(child.id, canvasBoxLabel(child));
      boxIds.add(child.id);
      // Closed, as an instance on a page is: what is inside it is opened from the row, not edited in the canvas page.
      const held: EditorNode[] =
        child.name === CANVAS_GROUP_TAG
          ? rows(child.children ?? [], depth + 1)
          : (child.children ?? []).flatMap((node): EditorNode[] => (node.kind === 'component' ? [{ ...node, children: undefined }] : []));
      // Listed as the div it stands for: its generated attributes (key, label, size) are the canvas's, not words to search.
      return [{ ...child, name: 'div', props: {}, attrOrder: [], children: held }];
    });
  };
  const root = nodeAtPath(pageState.model.nodes, trailOf(state.root));
  assert(root?.kind === 'element', 'The canvas root is the page’s <html> element');
  const body = (root.children ?? []).find((node) => node.kind === 'element' && node.name === 'body');
  assert(body?.kind === 'element', 'The canvas page has a <body>');
  labels.set(root.id, 'html'); // i18n-ignore: the element's own tag name, as every element row is named.
  const nodes = rows(body.children ?? [], 0);
  assert(nodes.length > 0, 'The canvas Navigator lists the canvas’s boxes');
  return { pageState: { ...pageState, model: { ...pageState.model, nodes: [{ ...root, children: nodes }] } }, rowLabels: labels, boxIds };
}

/**
 * What the Settings panel does differently on the canvas page: for a frame's instance, its values and writers are the
 * frame's preview values; for the canvas root (<html>), its one field is class, the root's classes at the root's scope.
 */
export type CanvasInstanceSettings =
  | {
      readonly kind: 'instance';
      /** The frame's instance on the page: what the panel shows, whether the instance, its box or a group is selected. */
      readonly node: EditorNode;
      readonly extras: PropFieldExtras;
      readonly panel: CanvasFramePanel;
    }
  | {
      readonly kind: 'root';
      /** The classes the root draws with at its "Apply to" choice: that choice's own, or every component's under it. */
      readonly classes: readonly string[];
      /** Where they come from: the choice itself (a blue label), every component's (orange), or nowhere (none shown). */
      readonly extras: PropFieldExtras;
      readonly onSetProp: (name: string, value: Attr | undefined) => void;
    };

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
    return rootSettings(canvas, state, translate);
  }
  const frame = selectedFrame(state, path);
  const instance = frame === undefined ? undefined : state.instances.find((candidate) => candidate.key === frame.key);
  const node = instance === undefined ? undefined : nodeAtPath(app.model?.nodes ?? [], trailOf(instance.path));
  if (frame === undefined || node?.kind !== 'component') {
    return undefined;
  }
  // Splitting changes the canvas settings everyone shares, which only a role that may edit components does.
  const mayEdit = can(role, 'component:edit');
  return {
    kind: 'instance',
    node,
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
  const scope = state.scopes.props;
  assert(scope !== PROJECT_SCOPE, 'Props are never previewed at the project’s scope');
  assert(scope !== COMPONENT_SCOPE, 'Props are never previewed at the canvas root’s scope');
  const id = panelNodeId(`${state.id}|${frame.key}|${scope}`);
  const values = framePanelValues({
    // The component's own fields, whether its instance, its box or a group around it is selected.
    schema: schemaFor(app.scan.components.find((entry) => entry.path.replaceAll('\\', '/').endsWith('/' + state.component.file))),
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
      // Emptied while typing in it: the field stays empty under the caret (the value the frame is given comes back when
      // the field is left); emptied any other way (Reset), the given value shows at once.
      if (edit.kind === 'inherit' && typingInPanel()) {
        drafts.empty({ id, name });
      }
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
    props: withDrafts(values.props, drafts, id),
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
  const scope = state.scopes.props;
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
  /** A field emptied while it is typed in, shown empty until focus leaves it. */
  readonly emptied: { readonly id: string; readonly name: string } | undefined;
  readonly empty: (field: { readonly id: string; readonly name: string }) => void;
}

// The panel's values with what is being typed: unfinished code in its field, an emptied field empty.
function withDrafts(props: Readonly<Record<string, Attr>>, drafts: UnfinishedCode, id: string): Readonly<Record<string, Attr>> {
  const held = drafts.held?.id === id ? { ...props, [drafts.held.name]: drafts.held.value } : props;
  const emptied = drafts.emptied?.id === id ? drafts.emptied.name : undefined;
  return emptied === undefined ? held : Object.fromEntries(Object.entries(held).filter(([name]) => name !== emptied));
}

// Whether a text field of the Settings panel has the keyboard: an emptying write then comes from typing.
function typingInPanel(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.closest('.props-field') !== null && (active.matches('input, textarea') || active.isContentEditable);
}

// How long typed code may stay unfinished before the field is told it has no preview value.
const UNFINISHED_CODE_MS = 2_500;

// What is typed in a field's code view and stores nothing yet: shown in the field until it becomes a value, and said
// once when typing stops there.
function useUnfinishedCode(onRefused: (name: string) => void): UnfinishedCode {
  const [held, setHeld] = useState<Unfinished | undefined>(undefined);
  const [emptied, setEmptied] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Leaving the emptied field shows what the frame is given again.
  useEffect(() => {
    if (emptied === undefined) {
      return undefined;
    }
    const leave = (): void => setEmptied(undefined);
    window.addEventListener('focusout', leave, true);
    return () => window.removeEventListener('focusout', leave, true);
  }, [emptied]);
  return {
    held,
    emptied,
    empty: (field) => setEmptied((current) => (current?.id === field.id && current.name === field.name ? current : field)),
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
      setEmptied(undefined);
    },
  };
}

// The canvas root's class field: the classes the root draws with, written to the root's "Apply to" scope (Frame
// settings). Cleared, the scope's own list goes and a wider one shows; names a class cannot have are refused there.
function rootSettings(canvas: ComponentCanvasControl, state: CanvasOpen, translate: Translator): CanvasInstanceSettings {
  const project = state.settings.classes ?? [];
  const own = state.scopes.background === PROJECT_SCOPE ? project : (state.settings.components[state.component.file]?.root?.classes ?? []);
  // At this component's choice with none of its own, every component's classes show, inherited.
  const inherited = own.length === 0 && state.scopes.background === COMPONENT_SCOPE && project.length > 0;
  const classes = inherited ? project : own;
  assert(classes.length <= CANVAS_LIMITS.rootClassesMax, 'The canvas root carries a bounded number of classes');
  return {
    kind: 'root',
    classes,
    extras: (name) =>
      name === 'class' && inherited ? { provenance: { tone: 'inherited', tip: translate('componentCanvas.panel.scope.project') } } : undefined,
    onSetProp: (name, value) => {
      if (name !== 'class') {
        return; // The root's only field: anything else is the generated page's and is never written.
      }
      const text = value?.type === 'string' ? value.value.trim() : '';
      canvas.editRootClasses(text === '' ? undefined : [...new Set(text.split(/\s+/))]);
    },
  };
}

// The frame the Settings panel shows for a selection on the canvas page, read from the selection itself so the panel
// changes in the same render as the selection: an instance's frame, a frame box's own, or for a group box the selected
// frame when it is in the group (else the group's first).
function selectedFrame(state: CanvasOpen, path: string | undefined): ModelFrame | undefined {
  const box = canvasBoxOf(path);
  const key = box === undefined ? canvasInstanceOf(path)?.key : box.kind === 'frame' ? box.key : groupFrame(state, box.key);
  return key === undefined ? undefined : state.layout.frames.find((candidate) => candidate.key === key);
}

function groupFrame(state: CanvasOpen, group: string): string | undefined {
  const pairs = keyPairs(group);
  const holds = (key: string): boolean => pairs.every((pair) => keyPairs(key).includes(pair));
  return holds(state.frame) ? state.frame : state.layout.frames.find((candidate) => holds(candidate.key))?.key;
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
