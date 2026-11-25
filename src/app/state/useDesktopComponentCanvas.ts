// Desktop's component canvas: "Open canvas" in a component's menu writes a temporary canvas page that renders the
// component once per frame (src/features/componentCanvas/canvasPage.ts), then opens the component itself for editing
// with that page as the one it is shown on, the way a component is opened from a page. The navigator, the palette,
// the style panel, undo and saving are therefore the ordinary ones, and an edit reaches every frame at once.
//
// Leaving goes back to the file and selection the canvas was opened from, in one step whatever was drilled into
// since; navigating anywhere else leaves too. Frame settings are written to `.stacki/component-canvas.json` a moment
// after the last change, only when the text changes; the canvas page is rewritten whole when its frames change.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_DIRECTORY, defaultsCanvasRoute } from '../../../shared/properties/defaultsCanvas';
import {
  EMPTY_CANVAS_FILE,
  parseComponentCanvasSource,
  serializeComponentCanvas,
  withFrameEdit,
  withProjectBackground,
  withSplit,
  type ComponentCanvasFile,
  type FrameEdit,
} from '../../../shared/properties/componentCanvas';
import type { DefaultComponent, DefaultsSnapshot } from '../../../shared/properties/componentDefaults';
import type { ScanComponent, ScanResult } from '../../../shared/properties/projectScan';
import { LIMITS } from '../../../shared/core/limits';
import { parsePageSource, writeText } from '../../ipc/bridge';
import { createDefaultsCanvas, onMetadataWrite, readMetadata, removeDefaultsCanvas, writeMetadata } from '../../ipc/projectMetadataBridge';
import { defaultsSnapshot, relativeComponentPath } from '../../features/componentDefaults/defaultsHost';
import { buildCanvasLayout, type CanvasComponent } from '../../features/preview/componentCanvas/canvasModel';
import { canvasPageSource, CANVAS_ROOT_TAG, defaultProps } from '../../features/preview/componentCanvas/canvasPage';
import { CANVAS_MESSAGE, canvasMessage } from '../../features/preview/componentCanvas/canvasChrome';
import { frameLabel, prettyComponentName } from '../../features/preview/componentCanvas/frameLabel';
import {
  noteComponentCanvas,
  PROJECT_SCOPE,
  registerCanvasInstanceOpener,
  type CanvasOpen,
  type CanvasState,
  type CanvasZoom,
  type ComponentCanvasControl,
} from '../../features/preview/componentCanvas/componentCanvasSession';
import { cleanError } from '../../lib/cleanError';
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
      if (source === held.base || (held.base === undefined && Object.keys(current.settings.components).length === 0)) {
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
      setState({ ...current, settings, layout, frame, scope });
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
  useCanvasPageWrites(state, writes, catalog, { project, translate, setState });
  useCanvasMessages(state, setState, app, cover);
  useLiveSchema(state, app.scan, setState);
  useLeaveWhenAway(state, app, origin, finish);
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
          setState({ ...current, frame: key, scope: scopeAfterSelect(current, key), framePanel: 'shown' });
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
          // The project scope holds one setting, the canvas background; anything else is not set there.
          if (current.scope !== PROJECT_SCOPE) {
            return withFrameEdit(current.settings, current.component.file, current.scope, edit);
          }
          return edit.kind === 'background' ? withProjectBackground(current.settings, edit.value) : current.settings;
        }),
      setSplit: (split) => update((current) => withSplit(current.settings, current.component.file, split)),
      coverRight,
      hideFramePanel: () => {
        const current = stateRef.current;
        if (current.kind === 'open' && current.framePanel === 'shown') {
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

// The scope when another frame is selected: "this frame" follows the selection, a wider scope stays while the new frame
// is in it, and otherwise the new frame itself.
function scopeAfterSelect(current: CanvasOpen, key: string): string {
  if (current.scope === current.frame) {
    return key;
  }
  return scopeStillFits(current.scope, key, current.layout) ? current.scope : key;
}

// A scope is the selected frame, every frame, or one split value the selected frame shows.
function scopeStillFits(scope: string, frame: string, layout: CanvasOpen['layout']): boolean {
  if (scope === '' || scope === frame || scope === PROJECT_SCOPE) {
    return true;
  }
  const selected = layout.frames.find((candidate) => candidate.key === frame);
  return selected?.parts.some((part) => frameKeyOfPart(part) === scope) ?? false;
}

function frameKeyOfPart(part: CanvasOpen['layout']['frames'][number]['parts'][number]): string {
  return part.value.kind === 'unset' ? part.prop : `${part.prop}=${encodeURIComponent(String(part.value.value))}`;
}

function pageFileOf(id: string): string {
  return CANVAS_DIRECTORY + id + '.astro';
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
  const component: CanvasComponent = { file, name: scanComponent.name, schema: scanComponent.schema ?? [] };
  const layout = buildCanvasLayout(component, parsed.value.components[file]);
  if (layout.total > layout.frames.length) {
    app.showToast(translate('componentCanvas.notice.truncated', { shown: layout.frames.length, total: layout.total }), 'info');
  }
  const id = crypto.randomUUID();
  const pageFile = pageFileOf(id);
  const page = pageSourceOf({ id, component, layout, settings: parsed.value }, snapshot, translate);
  await createDefaultsCanvas(project, pageFile, page);
  try {
    const focusPath = await canvasRootPath(project + '/' + pageFile, page);
    const origin: Origin = {
      stack: app.editStackRef.current,
      selectionPath: app.pathFor(app.selectedId),
      device: app.device,
      customWidth: app.previewDimensions.customWidth,
    };
    const pageEntry: OpenFile = {
      kind: 'page',
      path: project + '/' + pageFile,
      name: translate('componentCanvas.pageName', { name: prettyComponentName(component.name) }),
      route: defaultsCanvasRoute(pageFile),
    };
    // The whole world of frames is the instance being edited, so a click in any frame selects inside the component.
    const entry: OpenFile = { kind: 'component', name: scanComponent.name, path: scanComponent.path, focusPath, focusOcc: 0, focusWhole: false };
    await app.openFile(entry, { nextStack: [pageEntry, entry], selectionPath: undefined });
    if (app.pageStateRef.current.currentPage?.path !== entry.path) {
      throw new Error(translate('componentCanvas.error.notOpened'));
    }
    // The frame is what is selected first, so the panel opens on the frame's settings.
    app.setSelectedId(undefined);
    app.setDevice('desktop');
    app.setLeftTab('navigator');
    app.setRightTab('settings');
    const first = layout.frames[0]?.key ?? '';
    return {
      state: {
        kind: 'open',
        id,
        component,
        settings: parsed.value,
        layout,
        frame: first,
        scope: first,
        scale: 1,
        framePanel: 'shown',
        defaults: defaultProps(snapshot, file, prettyComponentName(component.name)),
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
  return canvasPageSource({
    id,
    component: component.file,
    fallbackText: prettyComponentName(component.name),
    theme: 'dark',
    surface: canvas.settings.background,
    snapshot,
    frames: layout.frames.map((frame) => ({
      key: frame.key,
      label: frameLabel(frame, component, translate),
      row: frame.row,
      props: frame.props,
      omitted: frame.omitted,
      width: frame.resolved.width,
      height: frame.resolved.height,
      background: frame.resolved.background,
    })),
  });
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

// Where the frames' world sits in the canvas page's tree: the instance the editor focuses.
async function canvasRootPath(pagePath: string, source: string): Promise<string> {
  const parsed = await parsePageSource(pagePath, source);
  if (!parsed.editable) {
    throw new Error(parsed.reason);
  }
  interface Walked {
    readonly kind: string;
    readonly name?: string;
    readonly children?: readonly Walked[] | undefined;
  }
  const pending: { readonly node: Walked; readonly path: string }[] = parsed.model.nodes.map((node, index) => ({ node, path: String(index) }));
  for (let visited = 0; visited < LIMITS.treeNodesMax; visited++) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    if (next.node.kind === 'element' && next.node.name === CANVAS_ROOT_TAG) {
      return next.path;
    }
    (next.node.children ?? []).forEach((child, index) => pending.push({ node: child, path: `${next.path}.${String(index)}` }));
  }
  throw new Error('The canvas page has no frames');
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
  context: { readonly project: string; readonly translate: Translator; readonly setState: React.Dispatch<React.SetStateAction<CanvasState>> },
): void {
  const open = state.kind === 'open' ? state : undefined;
  const { project, translate, setState } = context;
  // Component defaults saved while the canvas is open (Set component defaults, a nested component's recipe) change
  // what the frames' instances are given, so the page is written again from the file, never from a copy of it.
  const [defaultsVersion, setDefaultsVersion] = useState(0);
  useEffect(() => onMetadataWrite(() => setDefaultsVersion((version) => version + 1)), []);
  useEffect(() => {
    if (open === undefined) {
      return undefined;
    }
    const held = writes.current;
    clearTimeout(held.pageTimer);
    held.pageTimer = setTimeout(() => {
      void (async () => {
        const components = await readMetadata(project, 'components');
        const snapshot = defaultsSnapshot(components.source, catalog.current);
        const defaults = defaultProps(snapshot, open.component.file, prettyComponentName(open.component.name));
        if (JSON.stringify(defaults) !== JSON.stringify(open.defaults)) {
          setState((current) => (current.kind === 'open' && current.id === open.id ? { ...current, defaults } : current));
        }
        const page = pageSourceOf(open, snapshot, translate);
        if (page !== held.page && held.active === open.id) {
          held.page = page;
          await writeText(project, pageFileOf(open.id), page);
        }
      })().catch((error: unknown) => console.warn('Could not update the component canvas page:', error));
    }, CANVAS_TIMING.pageDelayMs);
    return () => clearTimeout(held.pageTimer);
  }, [catalog, defaultsVersion, open, project, setState, translate, writes]);
}

// Messages from the canvas page: which frame a press landed in, the zoom, and that it is ready for the selection.
function useCanvasMessages(
  state: CanvasState,
  setState: React.Dispatch<React.SetStateAction<CanvasState>>,
  app: ShellView,
  cover: React.MutableRefObject<number>,
): void {
  const id = state.kind === 'open' ? state.id : undefined;
  const frame = state.kind === 'open' ? state.frame : undefined;
  const { setSelectedId } = app;
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
        setState((current) =>
          current.kind === 'open' && current.layout.frames.some((candidate) => candidate.key === key)
            ? // A press on a frame's label or the space around its component selects the frame and opens its settings.
              { ...current, frame: key, scope: scopeAfterSelect(current, key), framePanel: message.chrome ? 'shown' : current.framePanel }
            : current,
        );
        if (message.chrome) {
          setSelectedId(undefined);
        }
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
  }, [cover, id, setSelectedId, setState]);
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
      const component = { ...current.component, schema };
      const layout = buildCanvasLayout(component, current.settings.components[component.file]);
      const frame = layout.frames.some((candidate) => candidate.key === current.frame) ? current.frame : (layout.frames[0]?.key ?? '');
      return { ...current, component, layout, frame, scope: scopeStillFits(current.scope, frame, layout) ? current.scope : frame };
    });
  }, [file, scan.components, setState]);
}

// Backing out of the component to the canvas page means leaving the canvas; opening anything else ends it.
function useLeaveWhenAway(
  state: CanvasState,
  app: ShellView,
  origin: React.MutableRefObject<Origin>,
  finish: (restore: Origin | undefined) => Promise<void>,
): void {
  const id = state.kind === 'open' ? state.id : undefined;
  const root = app.editStack[0]?.path;
  const current = app.currentPage?.path;
  const project = app.project.path;
  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const pagePath = project + '/' + pageFileOf(id);
    if (root !== pagePath) {
      void finish(undefined);
    } else if (current === pagePath) {
      void finish(origin.current);
    }
  }, [current, finish, id, origin, project, root]);
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
