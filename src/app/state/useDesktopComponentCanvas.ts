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
  serializeComponentCanvas,
  withFrameEdit,
  canvasRoot,
  PROJECT_ROOT,
  withRootEdit,
  type RootTarget,
  withSplit,
  CANVAS_LIMITS,
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
import { canvasPageSource, canvasTreeOf, frameDefaults, type CanvasTree } from '../../features/preview/componentCanvas/canvasPage';
import { CANVAS_MESSAGE, canvasMessage } from '../../features/preview/componentCanvas/canvasChrome';
import { frameLabel, prettyComponentName } from '../../features/preview/componentCanvas/frameLabel';
import {
  canvasInstanceAt,
  canvasInstanceOf,
  canvasRootPath,
  canvasPageFile,
  COMPONENT_SCOPE,
  isCanvasRoot,
  noteComponentCanvas,
  PROJECT_SCOPE,
  registerCanvasInstanceOpener,
  type CanvasInstance,
  type CanvasOpen,
  type CanvasState,
  type CanvasZoom,
  type ComponentCanvasControl,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { cleanError } from '../../lib/cleanError';
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
  /** The settings file as last read or written: the base the next write is checked against. */
  base: string | undefined;
  /** The page text last written, so an unchanged page is never rewritten. */
  page: string;
  /** The canvas whose page may be written: cleared as it closes, so a write already under way never revives a retired page. */
  active: string | undefined;
  settingsTimer: ReturnType<typeof setTimeout> | undefined;
  pageTimer: ReturnType<typeof setTimeout> | undefined;
}

export function useDesktopComponentCanvas(app: ShellView): ComponentCanvasControl {
  const translate = useTranslate();
  const [state, setState] = useState<CanvasState>({ kind: 'idle' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const origin = useRef<Origin>({ stack: [], selectionPath: undefined, device: 'desktop', customWidth: undefined });
  const writes = useRef<Writes>({ base: undefined, page: '', active: undefined, settingsTimer: undefined, pageTimer: undefined });
  const project = app.project.path;
  // The shell's latest view, for the control's actions: the control itself stays the same object between renders.
  const shell = useRef(app);
  shell.current = app;
  noteComponentCanvas(state);

  const saveSettings = useCallback(
    async (closing?: CanvasOpen): Promise<void> => {
      const current = closing ?? stateRef.current;
      const held = writes.current;
      clearTimeout(held.settingsTimer);
      held.settingsTimer = undefined;
      if (current.kind !== 'open') {
        return;
      }
      const source = serializeComponentCanvas(current.settings);
      // No file yet and nothing to put in one: nothing is written. A project-level setting (the canvas root's classes or
      // background) is something, though no component has settings yet.
      if (source === held.base || (held.base === undefined && source === serializeComponentCanvas(EMPTY_CANVAS_FILE))) {
        return;
      }
      try {
        const saved = await writeMetadata(project, { kind: 'componentCanvas', source, ...(held.base === undefined ? {} : { base: held.base }) });
        held.base = saved.source;
      } catch (error: unknown) {
        app.showToast(translate('componentCanvas.error.save', { message: cleanError(error) }), 'error');
        // Someone else changed the file: carry on from what is on disk now.
        held.base = (await readMetadata(project, 'componentCanvas')).source;
      }
    },
    [app, project, translate],
  );

  // Ends one canvas without navigating: its settings are written and its page retired (projectMetadataHandlers.ts).
  const retire = useCallback(
    async (closing: CanvasState): Promise<void> => {
      if (closing.kind !== 'open') {
        return;
      }
      await saveSettings(closing);
      clearTimeout(writes.current.pageTimer);
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
            writes.current = { base: opened.base, page: opened.page, active: opened.state.id, settingsTimer: undefined, pageTimer: undefined };
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

  const update = useCallback(
    (change: (current: CanvasOpen) => ComponentCanvasFile): void => {
      const current = stateRef.current;
      if (current.kind !== 'open') {
        return;
      }
      let settings: ComponentCanvasFile;
      try {
        settings = change(current);
      } catch (error: unknown) {
        app.showToast(translate('componentCanvas.error.save', { message: cleanError(error) }), 'error');
        return;
      }
      const layout = buildCanvasLayout(current.component, settings.components[current.component.file]);
      const frame = layout.frames.some((candidate) => candidate.key === current.frame) ? current.frame : (layout.frames[0]?.key ?? '');
      const scope = scopeStillFits(current.scope, frame, layout) ? current.scope : frame;
      const next = { ...current, settings, layout, frame, scope };
      // Two writes of one gesture can arrive before the next render: each builds on the one before.
      stateRef.current = next;
      setState(next);
      clearTimeout(writes.current.settingsTimer);
      writes.current.settingsTimer = setTimeout(() => void saveSettings(), CANVAS_TIMING.settingsDelayMs);
    },
    [app, saveSettings, translate],
  );

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
  useCanvasMessages(state, setState, cover);
  useLiveSchema(state, app.scan, setState);
  useRelinkedSettings(state, project, writes, setState);
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
      selectFrame: (key) => {
        const current = stateRef.current;
        if (current.kind === 'open' && current.layout.frames.some((frame) => frame.key === key)) {
          setState({ ...current, frame: key, scope: scopeAfterSelect(current, key), subject: 'frame' });
          // On the canvas page the frame's instance is what is selected; inside an instance the selection stays.
          const instance = current.instances.find((candidate) => candidate.key === key);
          const view = shell.current;
          const node = instance === undefined || view.editStackRef.current.length > 1 ? undefined : nodeAtPath(view.model?.nodes ?? [], trailOf(instance.path));
          if (node !== undefined) {
            view.setSelectedId(node.id);
          }
        }
      },
      setScope: (scope) => {
        const current = stateRef.current;
        if (current.kind === 'open' && scopeStillFits(scope, current.frame, current.layout)) {
          setState({ ...current, scope });
        }
      },
      edit: (edit: FrameEdit) =>
        update((current) => {
          const target = rootTarget(current);
          if (target === undefined) {
            return withFrameEdit(current.settings, current.component.file, current.scope, edit);
          }
          // A root scope holds the canvas root's background (and its classes, editRootClasses); a frame's size is not set there.
          return edit.kind === 'background' ? withRootEdit(current.settings, target, { kind: 'background', value: edit.value }) : current.settings;
        }),
      editRootClasses: (classes) =>
        update((current) =>
          withRootEdit(current.settings, rootTarget(current) ?? { kind: 'component', file: current.component.file }, { kind: 'classes', value: classes }),
        ),
      setSplit: (split) => update((current) => withSplit(current.settings, current.component.file, split)),
      coverRight,
      showFramePanel: () => {
        const current = stateRef.current;
        if (current.kind === 'open') {
          rememberFramePanel('shown');
          setState({ ...current, framePanel: 'shown' });
        }
      },
      editValues: (scope, edits) => {
        assert(edits.length <= LIMITS.attrsPerNodeMax, 'One write holds a bounded number of values');
        if (edits.length > 0) {
          update((current) => edits.reduce((file, edit) => withFrameEdit(file, current.component.file, scope, edit), current.settings));
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
    [app.project.path, coverRight, finish, open, state, update],
  );
}

// Where a canvas root setting goes at the current scope: the project's default or this component's; undefined at a
// frame scope.
function rootTarget(current: CanvasOpen): RootTarget | undefined {
  if (current.scope === PROJECT_SCOPE) {
    return PROJECT_ROOT;
  }
  return current.scope === COMPONENT_SCOPE ? { kind: 'component', file: current.component.file } : undefined;
}

// The scope a newly selected canvas root starts at: the component's own when it already sets something of its own,
// else the project's, which a theme class or a canvas colour usually is.
function rootScopeFor(current: CanvasOpen): string {
  const root = canvasRoot(current.settings, current.component.file);
  return root.backgroundSource === 'component' || root.classesSource === 'component' ? COMPONENT_SCOPE : PROJECT_SCOPE;
}

// The scope after a frame is selected: another frame (or coming from the canvas root) starts at the frame itself, so a
// wider scope is always a choice made for the frame in front of you; the same frame selected again keeps it.
function scopeAfterSelect(current: CanvasOpen, key: string): string {
  return key !== current.frame || rootTarget(current) !== undefined ? key : current.scope;
}

// A scope is the selected frame, every frame, one split value the selected frame shows, or a canvas root scope.
function scopeStillFits(scope: string, frame: string, layout: CanvasOpen['layout']): boolean {
  if (scope === '' || scope === frame || scope === PROJECT_SCOPE || scope === COMPONENT_SCOPE) {
    return true;
  }
  const selected = layout.frames.find((candidate) => candidate.key === frame);
  return selected?.parts.some((part) => frameKeyOfPart(part) === scope) ?? false;
}

function frameKeyOfPart(part: CanvasOpen['layout']['frames'][number]['parts'][number]): string {
  return part.value.kind === 'unset' ? part.prop : `${part.prop}=${encodeURIComponent(String(part.value.value))}`;
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
    const { root, instances } = await canvasTree(pagePath, page);
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
        scope: first.key,
        scale: 1,
        framePanel: rememberedFramePanel(),
        defaults: frameDefaults(snapshot, file, prettyComponentName(component.name)),
        instances,
        root,
        subject: 'frame',
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
      frame.contentWindow?.postMessage({ ...message, type: CANVAS_MESSAGE, canvas: id }, new URL(frame.src).origin);
    } catch {
      // A frame still loading has no address to post to; it asks again when it is ready.
    }
  }
}

// The canvas page follows the frames: rewritten whole, a moment after they change, only when its text changes. The
// components file is read again each time, so an insertion default changed meanwhile shows in the frames.
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
  const { project, translate, shell, setState } = context;
  // Component defaults saved while the canvas is open (Set component defaults, a nested component's recipe) change
  // what the frames' instances are given, so the page is written again from the file, never from a copy of it.
  const [defaultsVersion, setDefaultsVersion] = useState(0);
  useEffect(() => onMetadataWrite(() => setDefaultsVersion((version) => version + 1)), []);
  // An asset renamed, moved, deleted or brought back changes what the frames can import.
  useEffect(() => onAssetEntriesChanged(() => setDefaultsVersion((version) => version + 1)), []);
  useEffect(() => {
    if (open === undefined) {
      return undefined;
    }
    const held = writes.current;
    clearTimeout(held.pageTimer);
    held.pageTimer = setTimeout(() => {
      void (async () => {
        const components = await readMetadata(project, 'components');
        const snapshot = await withMissingAssets(project, defaultsSnapshot(components.source, catalog.current), open.settings);
        const defaults = frameDefaults(snapshot, open.component.file, prettyComponentName(open.component.name));
        if (JSON.stringify(defaults) !== JSON.stringify(open.defaults)) {
          setState((current) => (current.kind === 'open' && current.id === open.id ? { ...current, defaults } : current));
        }
        const page = pageSourceOf(open, snapshot, translate);
        if (page !== held.page && held.active === open.id) {
          held.page = page;
          // The frames' instances move with the frames: read where they are before the page that has them loads.
          const pagePath = project + '/' + pageFileOf(open.id);
          const { root, instances } = await canvasTree(pagePath, page);
          setState((current) =>
            current.kind === 'open' && current.id === open.id && (JSON.stringify(current.instances) !== JSON.stringify(instances) || current.root !== root)
              ? { ...current, instances, root }
              : current,
          );
          await writeText(project, pageFileOf(open.id), page);
          await reloadCanvasPage(shell.current, pagePath, { before: open.instances, after: instances, root });
        }
      })().catch((error: unknown) => console.warn('Could not update the component canvas page:', error));
    }, CANVAS_TIMING.pageDelayMs);
    return () => clearTimeout(held.pageTimer);
  }, [catalog, defaultsVersion, open, project, setState, shell, translate, writes]);
}

// The app's own writes raise no file event (appNavigation.ts reloadFromDisk), so while the canvas page is the open file
// its new text is read here: the Navigator and the Settings panel then show the new frames. The selected frame's
// instance stays selected, wherever the rewrite moved it; inside an instance nothing is read (the page is not open).
async function reloadCanvasPage(
  app: ShellView,
  pagePath: string,
  moved: { readonly before: readonly CanvasInstance[]; readonly after: readonly CanvasInstance[]; readonly root: string },
): Promise<void> {
  if (app.pageStateRef.current.currentPage?.path !== pagePath) {
    return;
  }
  const selectedPath = app.pathFor(app.selectedId);
  // The canvas root stays selected as the root; a frame's instance, as the frame it is (or became).
  const rootSelected = selectedPath !== undefined && !moved.before.some((instance) => instance.path === selectedPath) && !selectedPath.includes('.');
  const key = moved.before.find((instance) => instance.path === selectedPath)?.key;
  const read = await readPage(pagePath);
  const latest = app.pageStateRef.current;
  if (latest.currentPage?.path !== pagePath) {
    return;
  }
  const next = toEditorPageState(carriedParse(latest.pageState, read));
  assert(next.source === read.source, 'The canvas page shown is the one on disk');
  app.setPageState(next);
  const path = rootSelected
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

// Messages from the canvas page: which frame a press landed in, the zoom, and that it is ready for the selection.
function useCanvasMessages(state: CanvasState, setState: React.Dispatch<React.SetStateAction<CanvasState>>, cover: React.MutableRefObject<number>): void {
  const id = state.kind === 'open' ? state.id : undefined;
  const frame = state.kind === 'open' ? state.frame : undefined;
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    const receive = (event: MessageEvent<unknown>): void => {
      const message = canvasMessage(event.data, id);
      if (message === undefined || !fromPreview(event.source)) {
        return;
      }
      if (message.event === 'select' && message.frame !== undefined) {
        const key = message.frame;
        // The editor selects the frame's instance from the click itself (AppPanes.tsx selectCanvasPath); a press on a
        // frame's label or the space around its instance also opens the frame's settings again.
        if (message.chrome) {
          rememberFramePanel('shown');
        }
        setState((current) =>
          current.kind === 'open' && current.layout.frames.some((candidate) => candidate.key === key)
            ? { ...current, frame: key, scope: scopeAfterSelect(current, key), framePanel: message.chrome ? 'shown' : current.framePanel }
            : current,
        );
      } else if (message.event === 'view' && message.scale !== undefined) {
        // The zoom on screen: the canvas's own times the preview frame's (a fixed-width Desktop is drawn smaller).
        const scale = message.scale * previewScale();
        setState((current) => (current.kind === 'open' && current.scale !== scale ? { ...current, scale } : current));
      } else if (message.event === 'ready') {
        setState((current) => {
          if (current.kind === 'open') {
            postToCanvas(current.id, { command: 'select', frame: current.frame });
            // A page that loaded after the popover opened has not heard how much of it the popover covers.
            postToCanvas(current.id, { command: 'inset', right: cover.current / previewScale() });
          }
          return current;
        });
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [cover, id, setState]);
  useEffect(() => {
    if (id !== undefined && frame !== undefined) {
      postToCanvas(id, { command: 'select', frame });
    }
  }, [frame, id]);
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
      return { ...current, component, layout, frame, scope: scopeStillFits(current.scope, frame, layout) ? current.scope : frame };
    });
  }, [file, scan.components, setState]);
}

// A file moved in the project rewrites the canvas settings that named it (electron/project/componentDefaultRelink.ts).
// While nothing here is waiting to be written, the canvas takes what is on disk, so its next save builds on it.
function useRelinkedSettings(
  state: CanvasState,
  project: string,
  writes: React.MutableRefObject<Writes>,
  setState: React.Dispatch<React.SetStateAction<CanvasState>>,
): void {
  const id = state.kind === 'open' ? state.id : undefined;
  useEffect(() => {
    if (id === undefined) {
      return undefined;
    }
    const adopt = async (): Promise<void> => {
      const held = writes.current;
      const stored = await readMetadata(project, 'componentCanvas');
      if (held.settingsTimer !== undefined || stored.source === undefined || stored.source === held.base) {
        return;
      }
      const parsed = parseComponentCanvasSource(stored.source);
      if (!parsed.ok) {
        return;
      }
      held.base = stored.source;
      setState((current) => {
        if (current.kind !== 'open' || current.id !== id) {
          return current;
        }
        const layout = buildCanvasLayout(current.component, parsed.value.components[current.component.file]);
        const frame = layout.frames.some((candidate) => candidate.key === current.frame) ? current.frame : (layout.frames[0]?.key ?? '');
        return { ...current, settings: parsed.value, layout, frame, scope: scopeStillFits(current.scope, frame, layout) ? current.scope : frame };
      });
    };
    return onAssetEntriesChanged(() => void adopt().catch((error: unknown) => console.warn('Could not re-read the component canvas settings:', error)));
  }, [id, project, setState, writes]);
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

// The selected frame follows the editor: the instance selected on the canvas page, or the one opened to edit inside.
// So the Settings panel, Frame settings and the frame's highlighted label always speak of the same frame. On the canvas
// page a frame is one thing, so a selection that lands on its wrappers or inside its instance (an action that selects
// a neighbour or a parent) is moved to the instance.
function useFrameFollowsEditor(state: CanvasState, app: ShellView, setState: React.Dispatch<React.SetStateAction<CanvasState>>): void {
  const open = state.kind === 'open';
  const inside = app.editStack.length > 1 ? app.editStack[1]?.focusPath : undefined;
  const selected = app.editStack.length === 1 ? app.pathFor(app.selectedId) : undefined;
  const followed = inside ?? selected;
  const instances = state.kind === 'open' ? state.instances : undefined;
  const { model, setSelectedId } = app;
  useEffect(() => {
    if (!open || followed === undefined) {
      return;
    }
    if (inside === undefined && isCanvasRoot(followed)) {
      // The canvas itself: Frame settings and the Settings panel speak of its root, at a root scope.
      setState((current) => (current.kind === 'open' && current.subject !== 'root' ? { ...current, subject: 'root', scope: rootScopeFor(current) } : current));
      return;
    }
    const instance = inside === undefined ? canvasInstanceAt(followed) : canvasInstanceOf(followed);
    if (instance === undefined) {
      return;
    }
    if (inside === undefined && instance.path !== followed) {
      // A frame is its instance: a selection on the frame itself goes up to the canvas root when it came from the
      // instance (a parent step), and anything else in the frame is the instance.
      const parentStep = instance.path.startsWith(followed + '.');
      const node = nodeAtPath(model?.nodes ?? [], trailOf(parentStep ? (canvasRootPath() ?? instance.path) : instance.path));
      if (node !== undefined) {
        setSelectedId(node.id);
      }
      if (parentStep) {
        return;
      }
    }
    const key = instance.key;
    setState((current) =>
      current.kind === 'open' && (current.frame !== key || current.subject !== 'frame') && current.layout.frames.some((frame) => frame.key === key)
        ? { ...current, frame: key, scope: scopeAfterSelect(current, key), subject: 'frame' }
        : current,
    );
  }, [followed, inside, instances, model, open, setSelectedId, setState]);
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
