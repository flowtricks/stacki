// Desktop's component canvas: "Open in canvas" in a component's menu writes a temporary canvas page that renders the
// component once per frame (src/features/preview/componentCanvas/canvasPage.ts) and opens that page, the way any page
// is opened. Each frame's instance is closed, as a component on a page is: a click selects it (the Settings panel then
// shows that frame's preview values, which this hook writes to the canvas settings, never to the page), and a double
// click, the navigator or the tag's open button goes inside it to edit the component itself, so an edit reaches every
// frame at once. Escape and the breadcrumb step back out one level, as anywhere.
//
// Leaving goes back to the file and selection the canvas was opened from, in one step from any depth; navigating
// anywhere else leaves too. Frame settings are written to `.stacki/component-canvas.json` a moment after the last
// change, only when the text changes; the canvas page is rewritten whole when its frames change.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defaultsCanvasRoute } from '../../../shared/properties/defaultsCanvas';
import {
  EMPTY_CANVAS_FILE,
  parseComponentCanvasSource,
  canvasAssetUses,
  withFrameEdit,
  canvasRoot,
  PROJECT_ROOT,
  hasOwnCanvasRoot,
  withShownRootEdit,
  type RootTarget,
  withSplit,
  withArrangement,
  arrangementOf,
  CANVAS_LIMITS,
  keyPairs,
  resolveFrame,
  scopeHolds,
  type FrameLength,
  withoutOverrides,
  type ComponentCanvasFile,
  type FrameEdit,
} from '../../../shared/properties/componentCanvas';
import type { DefaultComponent, DefaultsSnapshot } from '../../../shared/properties/componentDefaults';
import type { ScanComponent, ScanResult } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { parsePageSource, readPage, writeText } from '../../ipc/bridge';
import { carriedParse, toEditorPageState } from '../../editor/pageState';
import { createDefaultsCanvas, onMetadataWrite, readMetadata, removeDefaultsCanvas, writeMetadata } from '../../ipc/projectMetadataBridge';
import { assetFileExists, defaultsSnapshot, missingAssetFiles, relativeComponentPath } from '../../features/componentDefaults/defaultsHost';
import { onAssetEntriesChanged } from '../../ipc/assetBridge';
import { buildCanvasLayout, type CanvasComponent } from '../../features/preview/componentCanvas/canvasModel';
import { groupFrames, type CanvasTreeItem } from '../../features/preview/componentCanvas/canvasGroups';
import { canvasPageSource, canvasTreeOf, frameDefaults, type CanvasPageItem, type CanvasTree } from '../../features/preview/componentCanvas/canvasPage';
import { CANVAS_MESSAGE, canvasMessage } from '../../features/preview/componentCanvas/canvasChrome';
import { frameLabel, prettyComponentName } from '../../features/preview/componentCanvas/frameLabel';
import {
  canvasBoxOf,
  canvasInstanceAt,
  canvasInstanceOf,
  canvasRootPath,
  canvasPageFile,
  COMPONENT_SCOPE,
  isCanvasRoot,
  noteComponentCanvas,
  PROJECT_SCOPE,
  registerCanvasInstanceOpener,
  type CanvasBox,
  type CanvasEditPace,
  type CanvasInstance,
  type CanvasOpen,
  type CanvasSection,
  type CanvasState,
  type CanvasZoom,
  type ComponentCanvasControl,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { cleanError } from '../../lib/cleanError';
import { canvasSettingsStore, type CanvasChange, type CanvasSettingsIo, type CanvasSettingsStore } from '../model/canvasSettingsStore';
import { nodeAtPath } from '../../editor/editorTree';
import { trailOf } from '../model/pageGestures';
import { resolveProjectImport } from '../../ipc/appBridge';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { OpenFile } from '../../editor/pageState';
import type { ShellView } from '../App';

const CANVAS_TIMING = {
  /** After the last change, how long the settings file waits to be written. */
  settingsDelayMs: 600,
  /** After the last live change (a drag whose end never came), how long the settings file waits to be written. */
  liveSettingsDelayMs: 10_000,
  /** After the last change, how long the canvas page waits to be rewritten: short, it is what the person watches. */
  pageDelayMs: 120,
} as const satisfies Record<string, number>;

interface Origin {
  readonly stack: readonly OpenFile[];
  readonly selectionPath: string | undefined;
  /** The preview device and custom width the canvas was opened at, given back on leaving. */
  readonly device: string;
  readonly customWidth: number | undefined;
}

interface Writes {
  /** The open canvas's settings and their one writer (canvasSettingsStore.ts). */
  store: CanvasSettingsStore | undefined;
  /** The canvas page's writes, one at a time, so an older page never lands over a newer one. */
  pageQueue: Promise<void>;
  /** The page text last written, so an unchanged page is never rewritten. */
  page: string;
  /** The canvas whose page may be written: cleared as it closes, so a write already under way never revives a retired page. */
  active: string | undefined;
  settingsTimer: ReturnType<typeof setTimeout> | undefined;
  pageTimer: ReturnType<typeof setTimeout> | undefined;
  /** A page rewrite is queued and has not started: changes meanwhile need no other, it reads the latest settings. */
  pageWaiting: boolean;
}

export function useDesktopComponentCanvas(app: ShellView): ComponentCanvasControl {
  const translate = useTranslate();
  const [state, setState] = useState<CanvasState>({ kind: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const origin = useRef<Origin>({ stack: [], selectionPath: undefined, device: 'desktop', customWidth: undefined });
  const writes = useRef<Writes>({
    store: undefined,
    pageQueue: Promise.resolve(),
    page: '',
    active: undefined,
    settingsTimer: undefined,
    pageTimer: undefined,
    pageWaiting: false,
  });
  const project = app.project.path;
  // The shell's latest view, for the control's actions: the control itself stays the same object between renders.
  const shell = useRef(app);
  shell.current = app;
  noteComponentCanvas(state);

  const saveSettings = useCallback(async (): Promise<void> => {
    const held = writes.current;
    clearTimeout(held.settingsTimer);
    held.settingsTimer = undefined;
    const store = held.store;
    if (store === undefined) {
      return;
    }
    try {
      await store.save();
    } catch (error: unknown) {
      app.showToast(translate('componentCanvas.error.save', { message: cleanError(error) }), 'error');
    }
  }, [app, translate]);

  // Ends one canvas without navigating: its settings are written and its page retired (projectMetadataHandlers.ts).
  const retire = useCallback(
    async (closing: CanvasState): Promise<void> => {
      if (closing.kind !== 'open') {
        return;
      }
      await saveSettings();
      clearTimeout(writes.current.pageTimer);
      writes.current.pageTimer = undefined;
      writes.current.active = undefined;
      await removeDefaultsCanvas(project, pageFileOf(closing.id)).catch((error: unknown) => console.warn('Could not retire the component canvas page:', error));
    },
    [project, saveSettings],
  );

  const finish = useCallback(
    async (restore: Origin | undefined): Promise<void> => {
      const current = stateRef.current;
      if (current.kind !== 'open') {
        return;
      }
      await saveSettings();
      clearTimeout(writes.current.pageTimer);
      writes.current.pageTimer = undefined;
      writes.current.active = undefined;
      setState({ kind: 'idle' });
      if (restore !== undefined) {
        await returnTo(app, restore, translate);
      }
      await removeDefaultsCanvas(project, pageFileOf(current.id)).catch((error: unknown) => console.warn('Could not remove the component canvas page:', error));
    },
    [app, project, saveSettings, translate],
  );

  const open = useCallback(
    (component: ScanComponent): void => {
      const current = stateRef.current;
      if (current.kind === 'opening') {
        return;
      }
      if (app.defaultsCanvas.state.kind !== 'idle') {
        app.showToast(translate('componentCanvas.error.busy'), 'info');
        return;
      }
      // From inside a canvas (Open in canvas on a component in a frame) the new canvas replaces it, and leaving the new
      // one still returns to where the first was opened from.
      const kept = current.kind === 'open' ? origin.current : undefined;
      setState({ kind: 'opening', component: component.path });
      void (kept === undefined ? Promise.resolve() : retire(current))
        .then(() => openCanvas(app, component, translate))
        .then(
          (opened) => {
            origin.current = kept ?? opened.origin;
            writes.current = {
              store: canvasSettingsStore(settingsIo(app.project.path), opened.base),
              pageQueue: writes.current.pageQueue,
              page: opened.page,
              active: opened.state.id,
              settingsTimer: undefined,
              pageTimer: undefined,
              pageWaiting: false,
            };
            setState(opened.state);
          },
          (error: unknown) => {
            setState({ kind: 'idle' });
            app.showToast(translate('componentCanvas.error.open', { message: cleanError(error) }), 'error');
          },
        );
    },
    [app, retire, translate],
  );

  const updatePaced = useCallback(
    (pace: CanvasEditPace, change: (current: CanvasOpen) => CanvasChange | undefined): void => {
      const current = stateRef.current;
      const store = writes.current.store;
      if (current.kind !== 'open' || store === undefined) {
        return;
      }
      // What the edit is (its scope, its component) is read now; what it applies to is the file as it is when applied.
      const edit = change(current);
      if (edit === undefined) {
        return;
      }
      let settings: ComponentCanvasFile;
      try {
        settings = store.change(edit);
      } catch (error: unknown) {
        app.showToast(translate('componentCanvas.error.save', { message: cleanError(error) }), 'error');
        return;
      }
      const next = withSettings(current, settings);
      // Two writes of one gesture can arrive before the next render: each builds on the one before.
      stateRef.current = next;
      setState(next);
      // A live change (a drag under way) is drawn now and saved when the drag ends: one save for the whole drag.
      clearTimeout(writes.current.settingsTimer);
      const delay = pace === 'live' ? CANVAS_TIMING.liveSettingsDelayMs : CANVAS_TIMING.settingsDelayMs;
      writes.current.settingsTimer = setTimeout(() => void saveSettings(), delay);
    },
    [app, saveSettings, translate],
  );
  const update = useCallback((change: (current: CanvasOpen) => CanvasChange | undefined): void => updatePaced('settled', change), [updatePaced]);

  const catalog = useRef<readonly DefaultComponent[]>([]);
  catalog.current = useMemo(() => catalogOf(project, app.scan), [project, app.scan]);
  // Stable across renders: the popover reports its cover once per placement, not on every canvas change.
  const cover = useRef(0);
  const coverRight = useCallback((pixels: number): void => {
    cover.current = pixels;
    const current = stateRef.current;
    if (current.kind === 'open') {
      postToCanvas(current.id, { command: 'inset', right: pixels / previewScale() });
    }
  }, []);
  useCanvasPageWrites(state, writes, catalog, { project, translate, shell, setState });
  // The frames' drawn sizes, as the page last told them: read when a size turns Fixed, never drawn from.
  const drawn = useRef<ReadonlyMap<string, { readonly width: number; readonly height: number }>>(new Map());
  const commitResize = useCallback(
    (resize: { readonly frame: string; readonly width: FrameLength | undefined; readonly height: FrameLength | undefined }) =>
      update((current) => (file) => resizeEdit(file, current, resize)),
    [update],
  );
  useCanvasMessages(state, setState, { cover, drawn, commitResize });
  useLiveSchema(state, app.scan, setState);
  useRelinkedSettings(state, writes, setState);
  useLeaveWhenAway(state, app, finish);
  useFrameFollowsEditor(state, app, setState);
  useNoDeviceKeys(state);
  useInstanceOpener(app, translate, open);
  useEffect(() => () => noteComponentCanvas({ kind: 'idle' }), []);

  return useMemo(
    (): ComponentCanvasControl => ({
      state,
      canOpen: (component) => component.origin?.kind !== 'package' && component.isLayout !== true && app.project.path.length > 0,
      open,
      exit: () => void finish(origin.current),
      setScope: (section, scope) => {
        const current = stateRef.current;
        if (current.kind === 'open' && scopeFits(section, scope, current)) {
          setState({ ...current, scopes: { ...current.scopes, [section]: scope } });
        }
      },
      edit: (edit: FrameEdit) => update((current) => frameSettingChange(current, edit)),
      resetOverrides: (section, setting) =>
        update((current) => {
          const scope = current.scopes[section];
          const component = current.component.file;
          return rootTarget(scope, current) === undefined ? (file) => withoutOverrides(file, component, scope, setting) : undefined;
        }),
      drawnSize: (frame) => drawn.current.get(frame),
      paintBackground: (color, end) => {
        const current = stateRef.current;
        if (current.kind !== 'open') {
          return;
        }
        const scope = current.scopes.background;
        const root = scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE;
        const frames = root ? [] : current.layout.frames.filter((frame) => scopeHolds(scope, frame.key)).map((frame) => frame.key);
        assert(frames.length <= CANVAS_LIMITS.framesMax, 'A paint reaches a bounded number of frames');
        postToCanvas(current.id, { command: 'paint', frames, root, value: color, restore: end === 'restore' });
      },
      showTargets: (frames) => {
        const current = stateRef.current;
        if (current.kind === 'open') {
          assert(frames === undefined || frames.length <= CANVAS_LIMITS.framesMax, 'A canvas outlines a bounded number of frames');
          postToCanvas(current.id, { command: 'targets', frames: frames ?? [] });
        }
      },
      editRootClasses: (classes) => update((current) => rootClassesChange(current, classes)),
      setSplit: (split) =>
        update((current) => {
          const component = current.component.file;
          return (file) => withSplit(file, component, split);
        }),
      setArrangement: (arrange) =>
        update((current) => {
          const component = current.component.file;
          return (file) => withArrangement(file, component, arrange);
        }),
      coverRight,
      showFramePanel: () => {
        const current = stateRef.current;
        if (current.kind === 'open') {
          rememberFramePanel('shown');
          setState({ ...current, framePanel: 'shown' });
        }
      },
      editValues: (scope, edits, pace) => {
        assert(edits.length <= LIMITS.attrsPerNodeMax, 'One write holds a bounded number of values');
        if (edits.length > 0) {
          updatePaced(pace ?? 'settled', (current) => valuesChange(current, scope, edits));
        }
      },
      hideFramePanel: () => {
        const current = stateRef.current;
        if (current.kind === 'open' && current.framePanel === 'shown') {
          rememberFramePanel('hidden');
          setState({ ...current, framePanel: 'hidden' });
        }
      },
      zoom: (action: CanvasZoom) => {
        const current = stateRef.current;
        if (current.kind === 'open') {
          // 100% is the component at its own size on screen, whatever the preview frame's own scale.
          postToCanvas(current.id, { command: 'zoom', action, unit: 1 / previewScale() });
        }
      },
    }),
    [app.project.path, coverRight, finish, open, state, update, updatePaced],
  );
}

function settingsIo(project: string): CanvasSettingsIo {
  return {
    read: async () => (await readMetadata(project, 'componentCanvas')).source,
    write: async (source, base) => {
      const saved = await writeMetadata(project, { kind: 'componentCanvas', source, ...(base === undefined ? {} : { base }) });
      return saved.source ?? source;
    },
  };
}

/**
 * What a size or background edit from Frame settings writes: the value at its section's scope and nothing else. A
 * narrower scope's own value (a frame's own width) survives it and still wins on its frames, which the field then says
 * (Mixed, orange, with Reset). A background at a root scope goes to the canvas root. Exported for its regression test.
 */
export function frameSettingChange(current: CanvasOpen, edit: FrameEdit): CanvasChange | undefined {
  const component = current.component.file;
  if (edit.kind === 'background') {
    const target = rootTarget(current.scopes.background, current);
    // A root scope holds the canvas root's background (and its classes, editRootClasses).
    return target === undefined
      ? (file) => withFrameEdit(file, component, current.scopes.background, edit)
      : (file) => withShownRootEdit(file, target, component, { kind: 'background', value: edit.value });
  }
  // Sizes go to the size scope; a frame's size is never set at a root scope.
  return edit.kind === 'field' ? (file) => withFrameEdit(file, component, current.scopes.size, edit) : undefined;
}

/** What the canvas root's class field writes, at the root scope chosen. Exported for its regression test. */
export function rootClassesChange(current: CanvasOpen, classes: readonly string[] | undefined): CanvasChange {
  const component = current.component.file;
  const target = rootTarget(current.scopes.background, current) ?? { kind: 'component' as const, file: component };
  return (file) => withShownRootEdit(file, target, component, { kind: 'classes', value: classes });
}

/** Preview values from the Settings panel, written at `scope` only: narrower values survive, as for sizes. Exported for its test. */
export function valuesChange(current: CanvasOpen, scope: string, edits: readonly FrameEdit[]): CanvasChange {
  assert(edits.length <= LIMITS.attrsPerNodeMax, 'One write holds a bounded number of values');
  const component = current.component.file;
  return (file) => edits.reduce((next, edit) => withFrameEdit(next, component, scope, edit), file);
}

/** The open canvas over new settings: its frames rebuilt, the selection and scopes kept where they still fit. Exported for its test. */
export function withSettings(current: CanvasOpen, settings: ComponentCanvasFile): CanvasOpen {
  const layout = buildCanvasLayout(current.component, settings.components[current.component.file]);
  const frame = layout.frames.some((candidate) => candidate.key === current.frame) ? current.frame : (layout.frames[0]?.key ?? '');
  const scopes = keptScopes(current, frame, layout);
  return { ...current, settings, layout, frame, scopes: { ...scopes, background: rootScopeOver(current, settings, scopes.background) } };
}

// The canvas root's settings started at This component for a value of its own (shownRootScope). Once the last of them is
// removed, what shows is every component's again, so the choice goes back there too: left at This component, that value
// would show as borrowed, and the next removal would only set this component apart from the others.
function rootScopeOver(current: CanvasOpen, settings: ComponentCanvasFile, scope: string): string {
  const file = current.component.file;
  const dropped = hasOwnCanvasRoot(current.settings, file) && !hasOwnCanvasRoot(settings, file);
  return dropped && current.subject === 'root' && scope === COMPONENT_SCOPE ? PROJECT_SCOPE : scope;
}

// The scopes kept over a new layout or frame: each that still reaches the frame, else its section's default.
function keptScopes(current: CanvasOpen, frame: string, layout: CanvasOpen['layout']): CanvasOpen['scopes'] {
  const next = { ...current, frame, layout };
  const keep = (section: CanvasSection, fallback: string): string => (scopeFits(section, current.scopes[section], next) ? current.scopes[section] : fallback);
  return { props: keep('props', frame), size: keep('size', ''), background: keep('background', current.subject === 'root' ? shownRootScope(next) : frame) };
}

// A resize let go of, as one change: each side it changed is written where a typed size goes (the size target), or,
// where the dragged frame keeps its own value for that side at a narrower level, to that level, so the frame keeps
// the size it was dragged to. Hug at all frames is no setting.
function resizeEdit(
  file: ComponentCanvasFile,
  current: CanvasOpen,
  resize: { readonly frame: string; readonly width: FrameLength | undefined; readonly height: FrameLength | undefined },
): ComponentCanvasFile {
  const component = current.component.file;
  const settings = file.components[component];
  const sides = [
    ['width', resize.width],
    ['height', resize.height],
  ] as const;
  assert(
    current.layout.frames.some((frame) => frame.key === resize.frame),
    'A resized frame is a frame of this canvas',
  );
  return sides.reduce((next, [side, value]) => {
    if (value === undefined) {
      return next;
    }
    const scope = current.scopes.size;
    const origin = resolveFrame(settings, resize.frame).origins.get(side);
    const target = origin !== undefined && origin !== scope && scopeHolds(scope, origin) ? origin : scopeHolds(scope, resize.frame) ? scope : resize.frame;
    return withFrameEdit(next, component, target, { kind: 'field', field: side, value: value === 'hug' && target === '' ? undefined : value });
  }, file);
}

// Where a canvas root setting goes at a scope: the project's default or this component's; undefined at a frame scope.
function rootTarget(scope: string, current: CanvasOpen): RootTarget | undefined {
  if (scope === PROJECT_SCOPE) {
    return PROJECT_ROOT;
  }
  return scope === COMPONENT_SCOPE ? { kind: 'component', file: current.component.file } : undefined;
}

// The scopes after a frame is selected. Another frame (or one after the canvas root or a group) starts each section at
// its default: props and background at the frame itself, so a wider choice is always made for the frame in front of
// you, and size at all frames, where a frame's size is usually wanted, unless the size scope chosen still reaches the
// new frame. The same frame selected again keeps every choice.
function scopesAfterSelect(current: CanvasOpen, key: string): CanvasOpen['scopes'] {
  const fresh = key !== current.frame || current.subject === 'root' || current.picked.kind === 'group';
  if (!fresh) {
    return current.scopes;
  }
  const size = current.subject === 'frame' && current.picked.kind !== 'group' && scopeHolds(current.scopes.size, key) ? current.scopes.size : '';
  return { props: key, size, background: key };
}

// A section's scope reaches the selected frame: the frame, all frames, any set of its split values (one value, or a
// group's); the background may also be a canvas root scope while the root is the subject.
function scopeFits(section: CanvasSection, scope: string, current: Pick<CanvasOpen, 'frame' | 'layout' | 'subject'>): boolean {
  if (scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE) {
    return section === 'background' && current.subject === 'root';
  }
  if (!current.layout.frames.some((candidate) => candidate.key === current.frame)) {
    return scope === '';
  }
  return scopeHolds(scope, current.frame);
}

function pageFileOf(id: string): string {
  return canvasPageFile(id);
}

// Whether the frame settings popover is open is remembered across canvases and launches: closed once, it stays closed
// until it is opened again. Browser storage may be unavailable (a private window); the popover then opens.
const FRAME_PANEL_KEY = 'stacki.componentCanvas.framePanel';
function rememberedFramePanel(): CanvasOpen['framePanel'] {
  try {
    return window.localStorage.getItem(FRAME_PANEL_KEY) === 'hidden' ? 'hidden' : 'shown';
  } catch {
    return 'shown';
  }
}
function rememberFramePanel(panel: CanvasOpen['framePanel']): void {
  try {
    window.localStorage.setItem(FRAME_PANEL_KEY, panel);
  } catch {
    // Nothing to remember it in: the next canvas opens it again.
  }
}

async function openCanvas(
  app: ShellView,
  scanComponent: ScanComponent,
  translate: Translator,
): Promise<{ readonly state: CanvasOpen; readonly origin: Origin; readonly base: string | undefined; readonly page: string }> {
  const project = app.project.path;
  await app.flushSave();
  const file = relativeComponentPath(project, scanComponent.path);
  const [components, stored] = await Promise.all([readMetadata(project, 'components'), readMetadata(project, 'componentCanvas')]);
  const parsed = stored.source === undefined ? { ok: true as const, value: EMPTY_CANVAS_FILE } : parseComponentCanvasSource(stored.source);
  if (!parsed.ok) {
    throw new Error(`.stacki/component-canvas.json: ${parsed.error.message}`);
  }
  const snapshot = defaultsSnapshot(components.source, catalogOf(project, app.scan));
  const component: CanvasComponent = { file, name: scanComponent.name, schema: scanComponent.schema ?? [], rest: scanComponent.hasRest === true };
  const layout = buildCanvasLayout(component, parsed.value.components[file]);
  if (layout.total > layout.frames.length) {
    app.showToast(translate('componentCanvas.notice.truncated', { shown: layout.frames.length, total: layout.total }), 'info');
  }
  const id = crypto.randomUUID();
  const pageFile = pageFileOf(id);
  const page = pageSourceOf({ id, component, layout, settings: parsed.value }, await withMissingAssets(project, snapshot, parsed.value), translate);
  await createDefaultsCanvas(project, pageFile, page);
  try {
    const pagePath = project + '/' + pageFile;
    const { root, instances, boxes } = await canvasTree(pagePath, page);
    const origin: Origin = {
      stack: app.editStackRef.current,
      selectionPath: app.pathFor(app.selectedId),
      device: app.device,
      customWidth: app.previewDimensions.customWidth,
    };
    const pageEntry: OpenFile = {
      kind: 'page',
      path: pagePath,
      name: translate('componentCanvas.pageName', { name: prettyComponentName(component.name) }),
      route: defaultsCanvasRoute(pageFile),
    };
    // The canvas page itself, every frame's instance closed. The first frame's instance is selected, as a frame is
    // what the canvas is about: the Settings panel opens on its preview values and Frame settings on its frame.
    const first = instances[0];
    assert(first !== undefined, 'A canvas page has an instance per frame');
    await app.openFile(pageEntry, { nextStack: [pageEntry], selectionPath: first.path });
    if (app.pageStateRef.current.currentPage?.path !== pageEntry.path) {
      throw new Error(translate('componentCanvas.error.notOpened'));
    }
    app.setDevice('desktop');
    app.setLeftTab('navigator');
    app.setRightTab('settings');
    return {
      state: {
        kind: 'open',
        id,
        component,
        settings: parsed.value,
        layout,
        frame: first.key,
        scopes: { props: first.key, size: '', background: first.key },
        scale: 1,
        framePanel: rememberedFramePanel(),
        defaults: frameDefaults(snapshot, file, prettyComponentName(component.name)),
        instances,
        boxes,
        root,
        subject: 'frame',
        picked: { kind: 'component' },
        resizing: undefined,
      },
      origin,
      base: stored.source,
      page,
    };
  } catch (error: unknown) {
    await removeDefaultsCanvas(project, pageFile).catch(() => undefined);
    throw error;
  }
}

function pageSourceOf(canvas: Pick<CanvasOpen, 'id' | 'component' | 'layout' | 'settings'>, snapshot: DefaultsSnapshot, translate: Translator): string {
  const { id, component, layout } = canvas;
  const root = canvasRoot(canvas.settings, component.file);
  return canvasPageSource({
    id,
    component: component.file,
    fallbackText: prettyComponentName(component.name),
    theme: 'dark',
    surface: root.background,
    rootClasses: root.classes,
    snapshot,
    groups: pageItems(groupFrames(layout.frames), component, translate),
    arrange: arrangementOf(canvas.settings.components[component.file]),
    frames: layout.frames.map((frame) => ({
      key: frame.key,
      label: frameLabel(frame, component, translate),
      row: frame.row,
      props: frame.props,
      assets: frame.assets,
      literals: frame.literals,
      content: frame.content,
      omitted: frame.omitted,
      width: frame.resolved.width,
      height: frame.resolved.height,
      background: frame.resolved.background,
    })),
  });
}

// The snapshot with every file a default or a preview value names that the project no longer has: the page leaves
// those values out rather than importing a missing file, which would break every frame. The panel says which are gone.
async function withMissingAssets(project: string, snapshot: DefaultsSnapshot, settings: ComponentCanvasFile): Promise<DefaultsSnapshot> {
  const named = [...new Set(canvasAssetUses(settings).map((use) => use.file))];
  const found = await Promise.all(named.map((file) => assetFileExists(project, file)));
  const missing = [...(await missingAssetFiles(project, snapshot.config)), ...named.filter((_, index) => found[index] !== true)];
  return { ...snapshot, missingAssets: [...new Set(missing)] };
}

// The frames' boxes with their headers and captions in words.
function pageItems(items: readonly CanvasTreeItem[], component: CanvasComponent, translate: Translator, depth = 0): readonly CanvasPageItem[] {
  assert(depth <= CANVAS_LIMITS.splitPropsMax, 'Boxes nest no deeper than the split');
  return items.map((item) =>
    item.kind === 'frame'
      ? { kind: 'frame', key: item.key, caption: frameLabel({ parts: item.caption }, component, translate) }
      : {
          kind: 'group',
          key: item.key,
          header: frameLabel({ parts: item.header }, component, translate),
          children: pageItems(item.children, component, translate, depth + 1),
        },
  );
}

// The insertion catalog from the scan the app already holds, the way the defaults host builds it from a fresh one.
function catalogOf(project: string, scan: ScanResult): readonly DefaultComponent[] {
  return [...scan.components, ...scan.layouts].map((component) => ({
    file: relativeComponentPath(project, component.path),
    ...(component.origin?.kind === 'package' ? { importPath: component.origin.importPath } : {}),
    name: component.name,
    props: (component.schema ?? []).map((field) => field.name),
    slots: component.slots ?? [],
    slotText: component.slotText ?? false,
    ...(component.setHtml === true ? { setHtml: true } : {}),
  }));
}

// The canvas page's root and each frame's instance, as the editor's parser reads the page (canvasPage.ts canvasTreeOf).
async function canvasTree(pagePath: string, source: string): Promise<CanvasTree> {
  const parsed = await parsePageSource(pagePath, source);
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  const found = canvasTreeOf(parsed.model.nodes);
  if (found.instances.length === 0) {
    throw new Error('The canvas page has no frames');
  }
  return found;
}

async function returnTo(app: ShellView, back: Origin, translate: Translator): Promise<void> {
  // The page comes back at the device and width it was left at: the canvas draws at the pane's own width.
  if (back.device === 'custom' && back.customWidth !== undefined) {
    app.requestCanvasWidth(back.customWidth);
  } else {
    app.setDevice(back.device);
  }
  const entry = back.stack.at(-1);
  if (entry === undefined) {
    app.setCurrentPage(undefined);
    app.setPageState(undefined);
    app.setEditStack([]);
    return;
  }
  await app.openFile(entry, { nextStack: back.stack, selectionPath: back.selectionPath });
  if (app.pageStateRef.current.currentPage?.path !== entry.path) {
    app.showToast(translate('componentCanvas.error.notReturned'), 'error');
  }
}

// How much the preview frame is scaled on screen (a fixed-width device drawn smaller than its width): 1 when it fills.
function previewScale(): number {
  const frame = document.querySelector<HTMLIFrameElement>('.preview-frame-wrap iframe');
  const width = frame?.offsetWidth ?? 0;
  return frame === null || width === 0 ? 1 : Math.max(frame.getBoundingClientRect().width / width, 0.01);
}

function postToCanvas(id: string, message: Readonly<Record<string, unknown>>): void {
  for (const frame of document.querySelectorAll<HTMLIFrameElement>('.preview-frame-wrap iframe')) {
    try {
      // Only a frame showing the dev server's page hears it: one still on the app's own blank document (between loads)
      // would log a mismatched origin for every message.
      if (frameShows(frame, new URL(frame.src).origin)) {
        frame.contentWindow?.postMessage({ ...message, type: CANVAS_MESSAGE, canvas: id }, new URL(frame.src).origin);
      }
    } catch {
      // A frame still loading has no address to post to; it asks again when it is ready.
    }
  }
}

// Whether the frame's document is at `origin`. The dev server's page is another origin than the app's, so its location
// cannot be read: reading it throws, and that is the answer. A document the app can read is its own, not the canvas.
function frameShows(frame: HTMLIFrameElement, origin: string): boolean {
  try {
    return frame.contentWindow?.location.origin === origin;
  } catch {
    return true;
  }
}

// The canvas page follows the frames: rewritten whole, a moment after they change, only when its text changes. The
// components file is read again each time, so an insertion default changed meanwhile shows in the frames.
//
// Paced, not put off: while changes keep coming (a colour dragged through a picker) the page is rewritten every
// pageDelayMs with the latest settings, so the canvas follows the drag, rather than once the changes stop. At most one
// rewrite runs and one waits; the waiting one reads the settings when it starts, so a fast stream never queues up.
function useCanvasPageWrites(
  state: CanvasState,
  writes: React.MutableRefObject<Writes>,
  catalog: React.MutableRefObject<readonly DefaultComponent[]>,
  context: {
    readonly project: string;
    readonly translate: Translator;
    readonly shell: React.MutableRefObject<ShellView>;
    readonly setState: React.Dispatch<React.SetStateAction<CanvasState>>;
  },
): void {
  const open = state.kind === 'open' ? state : undefined;
  const latest = useRef(open);
  latest.current = open;
  const { project, translate, shell, setState } = context;
  // Component defaults saved while the canvas is open (Set component defaults, a nested component's recipe) change
  // what the frames' instances are given, so the page is written again from the file, never from a copy of it.
  const [defaultsVersion, setDefaultsVersion] = useState(0);
  useEffect(() => onMetadataWrite(() => setDefaultsVersion((version) => version + 1)), []);
  // An asset renamed, moved, deleted or brought back changes what the frames can import.
  useEffect(() => onAssetEntriesChanged(() => setDefaultsVersion((version) => version + 1)), []);
  // What the page is written from; a zoom or a selection changes none of it, so it rewrites nothing.
  const id = open?.id;
  const settings = open?.settings;
  const layout = open?.layout;
  const component = open?.component;
  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const held = writes.current;
    const rewrite = async (): Promise<void> => {
      held.pageWaiting = false;
      const current = latest.current;
      if (current === undefined || current.id !== id) {
        return;
      }
      const components = await readMetadata(project, 'components');
      const snapshot = await withMissingAssets(project, defaultsSnapshot(components.source, catalog.current), current.settings);
      const defaults = frameDefaults(snapshot, current.component.file, prettyComponentName(current.component.name));
      if (JSON.stringify(defaults) !== JSON.stringify(current.defaults)) {
        setState((now) => (now.kind === 'open' && now.id === current.id ? { ...now, defaults } : now));
      }
      const page = pageSourceOf(current, snapshot, translate);
      if (page !== held.page && held.active === current.id) {
        held.page = page;
        // The frames' instances move with the frames: read where they are before the page that has them loads.
        const pagePath = project + '/' + pageFileOf(current.id);
        const { root, instances, boxes } = await canvasTree(pagePath, page);
        setState((now) =>
          now.kind === 'open' &&
          now.id === current.id &&
          (JSON.stringify(now.instances) !== JSON.stringify(instances) || JSON.stringify(now.boxes) !== JSON.stringify(boxes) || now.root !== root)
            ? { ...now, instances, boxes, root }
            : now,
        );
        await writeText(project, pageFileOf(current.id), page);
        await reloadCanvasPage(shell.current, pagePath, { before: current.instances, after: instances, boxesBefore: current.boxes, boxesAfter: boxes, root });
      }
    };
    // A rewrite already waiting will read these settings when it starts; a timer already set will start one.
    if (held.pageTimer !== undefined || held.pageWaiting) {
      return;
    }
    held.pageTimer = setTimeout(() => {
      held.pageTimer = undefined;
      held.pageWaiting = true;
      held.pageQueue = held.pageQueue.then(rewrite).catch((error: unknown) => {
        held.pageWaiting = false;
        console.warn('Could not update the component canvas page:', error);
      });
    }, CANVAS_TIMING.pageDelayMs);
  }, [catalog, component, defaultsVersion, id, layout, project, setState, settings, shell, translate, writes]);
  // The canvas closing stops a rewrite not yet started; one under way checks that its canvas is still the active one.
  useEffect(
    () => () => {
      const held = writes.current;
      clearTimeout(held.pageTimer);
      held.pageTimer = undefined;
    },
    [id, writes],
  );
}

// The app's own writes raise no file event (appNavigation.ts reloadFromDisk), so while the canvas page is the open file
// its new text is read here: the Navigator and the Settings panel then show the new frames. The selected frame's
// instance stays selected, wherever the rewrite moved it; inside an instance nothing is read (the page is not open).
async function reloadCanvasPage(
  app: ShellView,
  pagePath: string,
  moved: {
    readonly before: readonly CanvasInstance[];
    readonly after: readonly CanvasInstance[];
    readonly boxesBefore: readonly CanvasBox[];
    readonly boxesAfter: readonly CanvasBox[];
    readonly root: string;
  },
): Promise<void> {
  if (app.pageStateRef.current.currentPage?.path !== pagePath) {
    return;
  }
  const selectedPath = app.pathFor(app.selectedId);
  // A box stays selected as the box it is, wherever the rewrite moved it; one the rewrite removed gives way to the
  // first frame it held, or the root.
  const box = moved.boxesBefore.find((candidate) => candidate.path === selectedPath);
  // The canvas root stays selected as the root; a frame's instance, as the frame it is (or became).
  const rootSelected =
    selectedPath !== undefined && box === undefined && !moved.before.some((instance) => instance.path === selectedPath) && !selectedPath.includes('.');
  const key = box?.kind === 'frame' ? undefined : moved.before.find((instance) => instance.path === selectedPath)?.key;
  const read = await readPage(pagePath);
  const latest = app.pageStateRef.current;
  if (latest.currentPage?.path !== pagePath) {
    return;
  }
  const next = toEditorPageState(carriedParse(latest.pageState, read));
  assert(next.source === read.source, 'The canvas page shown is the one on disk');
  app.setPageState(next);
  const keptBox = box === undefined ? undefined : moved.boxesAfter.find((candidate) => candidate.kind === box.kind && candidate.key === box.key);
  const path =
    box !== undefined
      ? (keptBox?.path ?? moved.root)
      : rootSelected
        ? moved.root
        : (moved.after.find((instance) => instance.key === key) ?? (key === undefined ? undefined : narrowerFrame(moved.after, key)))?.path;
  const node = path === undefined || !next.editable ? undefined : nodeAtPath(next.model.nodes, trailOf(path));
  if (node !== undefined) {
    app.setSelectedId(node.id);
  }
}

// A frame a new split divided: the first of the frames it became, whose keys hold every pair of its own (`variant=arrow`
// became `direction=forward&variant=arrow` and `direction=back&variant=arrow`), or the frame a removed split merged
// it into.
function narrowerFrame(instances: readonly CanvasInstance[], key: string): CanvasInstance | undefined {
  const pairs = key === '' ? [] : key.split('&');
  assert(pairs.length <= CANVAS_LIMITS.splitPropsMax, 'A frame key holds a bounded number of pairs');
  const pairsOf = (instance: CanvasInstance): readonly string[] => (instance.key === '' ? [] : instance.key.split('&'));
  return (
    instances.find((instance) => pairs.every((pair) => pairsOf(instance).includes(pair))) ??
    instances.find((instance) => pairsOf(instance).every((pair) => pairs.includes(pair)))
  );
}

// Messages from the canvas page: the zoom, and that it is ready for the selection. The selection itself is the editor's
// (a press on a box or an instance selects it as on any page); the page is told what is selected, so it can mark the
// frame's caption and keep captions clear of the editor's tag.
function useCanvasMessages(
  state: CanvasState,
  setState: React.Dispatch<React.SetStateAction<CanvasState>>,
  refs: {
    /** Saves a resize let go of on the canvas, once (useDesktopComponentCanvas resizeEdit). */
    readonly commitResize: (resize: { readonly frame: string; readonly width: FrameLength | undefined; readonly height: FrameLength | undefined }) => void;
    readonly cover: React.MutableRefObject<number>;
    readonly drawn: React.MutableRefObject<ReadonlyMap<string, { readonly width: number; readonly height: number }>>;
  },
): void {
  const { cover, drawn, commitResize } = refs;
  const id = state.kind === 'open' ? state.id : undefined;
  const selection = state.kind === 'open' ? JSON.stringify(selectionOf(state)) : undefined;
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    const receive = (event: MessageEvent<unknown>): void => {
      const message = canvasMessage(event.data, id);
      if (message === undefined || !fromPreview(event.source)) {
        return;
      }
      if (message.event === 'resize' && message.resize !== undefined) {
        const resize = message.resize;
        if (resize.phase === 'end') {
          commitResize(resize);
        }
        setState((current) =>
          current.kind !== 'open'
            ? current
            : { ...current, resizing: resize.phase === 'live' ? { frame: resize.frame, width: resize.width, height: resize.height } : undefined },
        );
      } else if (message.event === 'sizes') {
        drawn.current = message.sizes;
      } else if (message.event === 'view' && message.scale !== undefined) {
        // The zoom on screen: the canvas's own times the preview frame's (a fixed-width Desktop is drawn smaller).
        const scale = message.scale * previewScale();
        setState((current) => (current.kind === 'open' && current.scale !== scale ? { ...current, scale } : current));
      } else if (message.event === 'ready') {
        setState((current) => {
          if (current.kind === 'open') {
            postToCanvas(current.id, selectionOf(current));
            // A page that loaded after the popover opened has not heard how much of it the popover covers.
            postToCanvas(current.id, { command: 'inset', right: cover.current / previewScale() });
          }
          return current;
        });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [commitResize, cover, drawn, id, setState]);
  // Escape while a frame is being resized puts it back, wherever the keyboard is.
  const resizing = state.kind === 'open' && state.resizing !== undefined;
  useEffect(() => {
    if (id === undefined || !resizing) {
      return undefined;
    }
    const cancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        postToCanvas(id, { command: 'cancelResize' });
      }
    };
    window.addEventListener('keydown', cancel, true);
    return () => window.removeEventListener('keydown', cancel, true);
  }, [id, resizing]);
  useEffect(() => {
    if (id === undefined || selection === undefined) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(selection);
    assert(typeof parsed === 'object', 'A canvas selection is an object');
    assert(parsed !== null, 'A canvas selection is not null');
    postToCanvas(id, { ...parsed });
    return measureSelectionTag(id);
  }, [id, selection]);
}

// What the canvas page is told is selected: the frame, and whether its component, its box, a group or the root.
function selectionOf(current: CanvasOpen): Readonly<Record<string, unknown>> {
  if (current.subject === 'root') {
    return { command: 'select', frame: current.frame, target: 'root' };
  }
  const { picked } = current;
  return { command: 'select', frame: current.frame, target: picked.kind, ...(picked.kind === 'group' ? { group: picked.key } : {}) };
}

// How many frames the selection's tag is looked for after a selection: the editor draws it a frame or two later.
const TAG_MEASURE_FRAMES_MAX = 30;

// The editor's tag over the selection, measured on screen and sent to the canvas page, which hides any caption or
// heading the tag would cover (canvasChrome.ts hideUnderTag). Its size alone: the page knows where the selection is at
// every zoom, and the tag keeps its size on screen.
function measureSelectionTag(id: string): () => void {
  let frame = 0;
  let handle = requestAnimationFrame(function look(): void {
    // Two frames on: the outline drawn before them may still be the last selection's.
    const tag = frame < 2 ? undefined : (document.querySelector<HTMLElement>('.node-outline.sel .node-outline-tag') ?? undefined);
    if (tag !== undefined) {
      // In the canvas page's own pixels: a fixed-width preview frame is drawn smaller than its width.
      const bounds = tag.getBoundingClientRect();
      const scale = previewScale();
      postToCanvas(id, { command: 'tag', width: bounds.width / scale, height: bounds.height / scale, inside: tag.classList.contains('inside') });
      return;
    }
    frame += 1;
    if (frame < TAG_MEASURE_FRAMES_MAX) {
      handle = requestAnimationFrame(look);
    }
  });
  return () => cancelAnimationFrame(handle);
}

function fromPreview(source: unknown): boolean {
  return [...document.querySelectorAll<HTMLIFrameElement>('.preview-frame-wrap iframe')].some((frame) => frame.contentWindow === source);
}

// The component's props as the scan has them now: a prop added or removed in the canvas changes the frames.
function useLiveSchema(state: CanvasState, scan: ScanResult, setState: React.Dispatch<React.SetStateAction<CanvasState>>): void {
  const open = state.kind === 'open' ? state : undefined;
  const file = open?.component.file;
  useEffect(() => {
    if (file === undefined) {
      return;
    }
    const live = scan.components.find((component) => component.path.replaceAll('\\', '/').endsWith('/' + file));
    const schema = live?.schema;
    if (schema === undefined) {
      return;
    }
    setState((current) => {
      if (current.kind !== 'open' || JSON.stringify(current.component.schema) === JSON.stringify(schema)) {
        return current;
      }
      const component = { ...current.component, schema, rest: live?.hasRest === true };
      const layout = buildCanvasLayout(component, current.settings.components[component.file]);
      const frame = layout.frames.some((candidate) => candidate.key === current.frame) ? current.frame : (layout.frames[0]?.key ?? '');
      return { ...current, component, layout, frame, scopes: keptScopes(current, frame, layout) };
    });
  }, [file, scan.components, setState]);
}

// A file moved in the project rewrites the canvas settings that named it (electron/project/componentDefaultRelink.ts):
// the canvas reads them again, keeping what it has not written yet.
function useRelinkedSettings(state: CanvasState, writes: React.MutableRefObject<Writes>, setState: React.Dispatch<React.SetStateAction<CanvasState>>): void {
  const id = state.kind === 'open' ? state.id : undefined;
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    return onAssetEntriesChanged(() => {
      void writes.current.store
        ?.reread()
        .then((settings) =>
          setState((current) =>
            current.kind === 'open' && current.id === id && JSON.stringify(current.settings) !== JSON.stringify(settings)
              ? withSettings(current, settings)
              : current,
          ),
        )
        .catch((error: unknown) => console.warn('Could not re-read the component canvas settings:', error));
    });
  }, [id, setState, writes]);
}

// Opening anything that is not the canvas page or inside it ends the canvas (it stays the root of the edit stack while
// an instance is open inside it).
function useLeaveWhenAway(state: CanvasState, app: ShellView, finish: (restore: Origin | undefined) => Promise<void>): void {
  const id = state.kind === 'open' ? state.id : undefined;
  const root = app.editStack[0]?.path;
  const project = app.project.path;
  useEffect(() => {
    if (id !== undefined && root !== project + '/' + pageFileOf(id)) {
      void finish(undefined);
    }
  }, [finish, id, project, root]);
}

// The selected frame follows the editor: the box, group or instance selected on the canvas page, or the instance opened
// to edit inside. So the Settings panel, Frame settings and the frame's caption always speak of the same frame.
//
// It follows during render, not after it: a selection change and the canvas state it implies reach the screen in one
// paint. Followed in an effect, the outline and the Settings panel moved a frame before Frame settings and the scope
// did, and the panel's fields (keyed by frame and scope) were mounted twice; recorded in the app, that was the flicker.
// React re-renders this component at once when its own state is set during its render, before any child sees it.
//
// A selection inside an instance (an action that selects a child) is moved to the instance, which is closed here; one
// on the page's own scaffolding (its <body>, its styles) is the canvas root. Those move the editor's selection, which
// belongs to another component, so they wait for the effect.
/** Exported for its regression test (componentCanvasFollow.test.js); the canvas host is its one caller. */
export function useFrameFollowsEditor(
  state: CanvasState,
  app: Pick<ShellView, 'editStack' | 'pathFor' | 'selectedId' | 'model' | 'setSelectedId'>,
  setState: React.Dispatch<React.SetStateAction<CanvasState>>,
): void {
  const open = state.kind === 'open';
  const inside = app.editStack.length > 1 ? app.editStack[1]?.focusPath : undefined;
  const selected = app.editStack.length === 1 ? app.pathFor(app.selectedId) : undefined;
  const followed = inside ?? selected;
  const instances = state.kind === 'open' ? state.instances : undefined;
  const boxes = state.kind === 'open' ? state.boxes : undefined;
  const { model, setSelectedId } = app;
  // What was last followed: only a moved selection (or a rewritten page) is followed again.
  const done = useRef<{ readonly selection: string; readonly instances: unknown; readonly boxes: unknown } | undefined>(undefined);
  const selection = `${inside === undefined ? 'page' : 'inside'}|${followed ?? ''}`;
  if (!open || followed === undefined) {
    done.current = undefined;
  } else if (done.current?.selection !== selection || done.current.instances !== instances || done.current.boxes !== boxes) {
    done.current = { selection, instances, boxes };
    const next = followedState(state, followed, inside === undefined ? 'page' : 'inside');
    if (next !== state) {
      setState(next);
    }
  }
  useEffect(() => {
    if (!open || followed === undefined || inside !== undefined || isCanvasRoot(followed) || canvasBoxOf(followed) !== undefined) {
      return;
    }
    const instance = canvasInstanceAt(followed);
    const within = instance !== undefined && (followed === instance.path || followed.startsWith(instance.path + '.'));
    // Inside an instance: the instance; on the page's scaffolding: the canvas root.
    const path = within ? instance.path : canvasRootPath();
    if (path === followed || path === undefined) {
      return;
    }
    const node = nodeAtPath(model?.nodes ?? [], trailOf(path));
    if (node !== undefined) {
      setSelectedId(node.id);
    }
  }, [followed, inside, model, open, setSelectedId]);
}

// The root scope the canvas root's settings start at: the one whose values the canvas draws, so the class field and the
// background never show a value this component's own replaces. That is every component's canvas, where a theme class or
// a canvas colour usually belongs, unless this component has a setting of its own.
function shownRootScope(current: Pick<CanvasOpen, 'settings' | 'component'>): string {
  return hasOwnCanvasRoot(current.settings, current.component.file) ? COMPONENT_SCOPE : PROJECT_SCOPE;
}

// The canvas state a selection on its page implies; `current` itself when it already says so.
function followedState(current: CanvasState, followed: string, where: 'page' | 'inside'): CanvasState {
  if (current.kind !== 'open') {
    return current;
  }
  if (where === 'inside') {
    const instance = canvasInstanceOf(followed);
    return instance === undefined ? current : withFramePicked(current, instance.key, { kind: 'component' });
  }
  if (isCanvasRoot(followed)) {
    // The canvas itself: Frame settings and the Settings panel speak of its root, at a root scope.
    return current.subject === 'root' ? current : { ...current, subject: 'root', scopes: { ...current.scopes, background: shownRootScope(current) } };
  }
  const box = canvasBoxOf(followed);
  if (box !== undefined) {
    return box.kind === 'frame' ? withFramePicked(current, box.key, { kind: 'box' }) : withGroupPicked(current, box.key);
  }
  const instance = canvasInstanceAt(followed);
  if (instance === undefined || !(followed === instance.path || followed.startsWith(instance.path + '.'))) {
    return current; // The scaffolding: the effect selects the root, which is followed then.
  }
  return withFramePicked(current, instance.key, { kind: 'component' });
}

// The canvas with a frame selected, through its component or its box. Another frame starts at its own scope; the same
// frame keeps the scope it had, unless that was a group's (a group selected before it) or the root's.
function withFramePicked(current: CanvasState, key: string, picked: CanvasOpen['picked']): CanvasState {
  if (current.kind !== 'open' || !current.layout.frames.some((frame) => frame.key === key)) {
    return current;
  }
  if (current.frame === key && current.subject === 'frame' && current.picked.kind === picked.kind) {
    return current;
  }
  return { ...current, frame: key, scopes: scopesAfterSelect(current, key), subject: 'frame', picked };
}

// The canvas with a group's box selected: its edits go to every frame in it (the group's key is their shared values),
// and the panels show the first of them, or the selected frame where it is one of them.
function withGroupPicked(current: CanvasState, key: string): CanvasState {
  if (current.kind !== 'open') {
    return current;
  }
  const pairs = keyPairs(key);
  const holds = (frame: string): boolean => pairs.every((pair) => keyPairs(frame).includes(pair));
  const frame = holds(current.frame) ? current.frame : current.layout.frames.find((candidate) => holds(candidate.key))?.key;
  if (frame === undefined) {
    return current;
  }
  assert(scopeHolds(key, frame), 'A group is a scope of every frame in it');
  if (current.subject === 'frame' && current.picked.kind === 'group' && current.picked.key === key && current.frame === frame) {
    return current;
  }
  // Every section edits the group: that is what selecting it says.
  return { ...current, frame, scopes: { props: key, size: key, background: key }, subject: 'frame', picked: { kind: 'group', key } };
}

// The breakpoint devices do not apply to the canvas (its toolbar hides them), so their number keys do nothing there:
// a capture listener on the window runs before the toolbar's (usePreviewSizing.ts useDeviceShortcuts) and keeps the key.
function useNoDeviceKeys(state: CanvasState): void {
  const open = state.kind === 'open';
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const keep = (event: KeyboardEvent): void => {
      const target = event.target;
      const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
      if (/^[0-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', keep, true);
    return () => window.removeEventListener('keydown', keep, true);
  }, [open]);
}

// Open in canvas from the element menus (navigator and canvas): the instance's component as the open file imports it,
// the way Open component finds it (appNavigation.ts useOpenComponent), then the same open as the Components panel's.
function useInstanceOpener(app: ShellView, translate: Translator, open: (component: ScanComponent) => void): void {
  const appRef = useRef(app);
  appRef.current = app;
  useEffect(() => {
    const opener = (name: string): void => {
      const current = appRef.current;
      void instanceComponent(current, name).then(
        (component) => {
          if (component === undefined) {
            current.showToast(translate('componentCanvas.error.open', { message: name }), 'error');
          } else {
            open(component);
          }
        },
        (error: unknown) => current.showToast(translate('componentCanvas.error.open', { message: cleanError(error) }), 'error'),
      );
    };
    registerCanvasInstanceOpener(opener);
    return () => registerCanvasInstanceOpener(undefined);
  }, [open, translate]);
}

async function instanceComponent(app: ShellView, name: string): Promise<ScanComponent | undefined> {
  const { currentPage, pageState } = app.pageStateRef.current;
  const spec = pageState?.editable === true ? pageState.model.imports.find((entry) => entry.name === name)?.path : undefined;
  const host = currentPage?.path;
  const file = spec === undefined || host === undefined ? undefined : await resolveProjectImport(app.project.path, host, spec);
  const normalized = file?.replaceAll('\\', '/');
  const byFile = normalized === undefined ? undefined : app.scan.components.find((component) => component.path.replaceAll('\\', '/') === normalized);
  return byFile ?? app.scan.components.find((component) => component.name === name && component.origin?.kind !== 'package');
}
