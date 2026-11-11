// Desktop's commands for Stacki Apps (src/features/apps/appRpcHost.ts): each RPC
// method, as the editor's own UI does it. Selection is `setSelectedId` with the
// navigator's reveal; panels are the rail's `setLeftTab` and the right tabs;
// the canvas is the toolbar's device and the style panel's width request, and
// the selection scroll's `avb:scroll-to`; edits are the Style and Settings
// panels' gestures (`setProp`, `addClassToNode`, …), so an app's edit is one
// undo step that saves, conflicts and previews exactly as a click does.
//
// The commands read the shell through a ref, so the object handed to the
// runtime can be built once and still act on the latest editor state.
import { readAppSettings } from '../../ipc/appPublishBridge';
import type React from 'react';
import { assert } from '../../../shared/core/assert';
import {
  APP_RPC_LIMITS,
  type AppEditOutcome,
  type AppInsert,
  type AppInsertOutcome,
  type AppLeftPanel,
  type AppNodeView,
  type AppPageView,
  type AppRect,
  type AppViewport,
} from '../../../shared/properties/appsRpc';
import { able, type AppHostCommands, type AppHostInsert } from '../../features/apps/appRpcHost';
import {
  DESKTOP_STORAGE_WRITER,
  listAppStorageKeys,
  onAppPersonChanged,
  readAppPeople,
  readAppPerson,
  readAppStorage,
  readHostVersion,
  captureCanvasSnapshot,
  watchAppStorage,
  writeAppStorage,
} from '../../ipc/appDataBridge';
import type { AppEventState } from '../../features/apps/AppsHost';
import type { EditorNode } from '../../editor/pageView';
import { findEditorNodeById } from '../../editor/pageState';
import { PLACEMENT_END } from '../../editor/classAttr';
import { cleanError } from '../../lib/cleanError';
import { readPage } from '../../ipc/bridge';
import { appFileStamps } from '../../ipc/appPageFilesBridge';
import { desktopAppAuth, desktopAppFiles, desktopAppNet } from './desktopAppAccess';
import type { ShellView } from '../App';
import type { HistoryEntry, LeftTab } from '../appTypes';

const APPLIED: AppEditOutcome = { applied: true };

export function desktopAppHost(appRef: React.MutableRefObject<ShellView>): AppHostCommands {
  const app = () => appRef.current;
  const editableNode = (nodeId: string): EditorNode | undefined => {
    const state = app().pageState;
    return state?.editable ? findEditorNodeById(state.model.nodes, nodeId) : undefined;
  };
  // An edit: refused unless the page is editable and has the node, then labelled and saved before it answers.
  const edit = async (
    nodeId: string,
    label: string | undefined,
    run: (node: EditorNode) => Promise<AppEditOutcome> | AppEditOutcome,
  ): Promise<AppEditOutcome> => {
    const node = editableNode(nodeId);
    if (node === undefined) {
      return { applied: false, reason: 'No editable element has that id on the open page' };
    }
    assert(node.id === nodeId, 'The edited node is the one named');
    const before = app().historyRef.current.past.at(-1);
    const outcome = await run(node);
    if (!outcome.applied) {
      return outcome;
    }
    labelNewStep(app(), before, label);
    try {
      await app().flushSave();
      return APPLIED;
    } catch (error: unknown) {
      return { applied: false, reason: cleanError(error) };
    }
  };
  const classOutcome = (outcome: { readonly tag: 'applied' } | { readonly tag: 'refused'; readonly message: string }): AppEditOutcome =>
    outcome.tag === 'applied' ? APPLIED : { applied: false, reason: outcome.message };
  return {
    viewport: () => desktopViewport(app()),
    setDevice: (device) => app().setDevice(device),
    setWidth: able((widthPx) => app().requestCanvasWidth(widthPx)),
    scrollTo: able((target) => {
      const frame = canvasFrame();
      if (frame === undefined) {
        return { applied: false, reason: 'The canvas is not showing a page' };
      }
      if ('nodeId' in target) {
        const path = app().pathFor(target.nodeId);
        if (path === undefined) {
          return { applied: false, reason: 'That element is not on the canvas' };
        }
        // The message the selection scroll sends (src/features/preview/previewRuntime.ts).
        frame.postMessage({ type: 'avb:scroll-to', path, occ: target.occurrence ?? 0 }, '*');
        return APPLIED;
      }
      // A point scrolls through the frame's app-scroll message, which the dispatcher sends (appRpcHost.ts scrollCanvas).
      return { applied: false, reason: 'A point is scrolled by the canvas itself' };
    }),
    openPanel: (panel) => app().setLeftTab(leftTabOf(panel)),
    closePanel: () => app().setLeftTab(undefined),
    openRightPanel: (panel) => app().setRightTab(panel),
    panels: () => panelsOf(app()),
    selection: () => ({ nodeId: app().selectedId }),
    select: (nodeId) => {
      if (nodeId !== undefined && editableNode(nodeId) === undefined && app().pathFor(nodeId) === undefined) {
        return { applied: false, reason: 'No element has that id on the open page' };
      }
      app().setSelectedId(nodeId);
      app().setRevealTick((count) => count + 1);
      return APPLIED;
    },
    page: () => pageView(app()),
    // Relative to the project, as `page.get`, `page.getTree` and `page.open` name files.
    pages: () => app().scan.pages.map((page) => ({ path: projectRelative(app().project.path, page.path), route: page.route, title: page.title })),
    openPage: (path) => {
      const page = app().scan.pages.find((candidate) => projectRelative(app().project.path, candidate.path) === path);
      if (page === undefined) {
        return { applied: false, reason: 'This project has no page at that path' };
      }
      app().onSelectPage(page);
      return APPLIED;
    },
    openComponent: able((path) => {
      const component = [...app().scan.components, ...app().scan.layouts].find((candidate) => candidate.file === path);
      if (component === undefined) {
        return { applied: false, reason: 'This project has no component at that path' };
      }
      // The Components panel's own open: the component's canvas on its own, with no page instance's props.
      void app().openComponent(component.name, undefined, 0, component.path).catch(app().reportFailure);
      return APPLIED;
    }),
    snapshot: able((box, widthMax) => {
      const rect = windowRectOf(box);
      return rect === undefined
        ? Promise.resolve({ applied: false, reason: 'That element is not in view on the canvas; canvas.scrollTo it first' })
        : captureCanvasSnapshot(rect, widthMax);
    }),
    node: (nodeId) => {
      const state = app().pageState;
      const node = state?.editable ? findEditorNodeById(state.model.nodes, nodeId) : undefined;
      return node === undefined ? undefined : nodeViews([node]).views[0];
    },
    attributes: able({
      set: (nodeId, name, value, label) =>
        edit(nodeId, label, () => {
          app().setProp(nodeId, name, { type: 'string', value }, true);
          return APPLIED;
        }),
      remove: (nodeId, name, label) => edit(nodeId, label, async () => classOutcome(await app().removeAttributeFromNode(nodeId, name))),
    }),
    classes: able({
      add: (nodeId, className, label) => edit(nodeId, label, async () => classOutcome(await app().addClassToNode(nodeId, className, PLACEMENT_END))),
      remove: (nodeId, className, label) => edit(nodeId, label, async () => classOutcome(await app().removeClassFromNode(nodeId, className))),
    }),
    setStyle: able((nodeId, css, label) =>
      edit(nodeId, label, () => {
        // The inline style field's own write: one declaration edit when the attribute is a plain string.
        app().setProp(nodeId, 'style', css.trim() === '' ? undefined : { type: 'string', value: css }, true);
        return APPLIED;
      }),
    ),
    insertElement: able((insert) => insertWith(insert, app)),
    insertComponent: (insert) => insertWith(insert, app),
    // The new node's attributes and the replaced node's removal are part of the insert's own gesture (appInsertGesture.ts).
    insertAttributes: able(true),
    insertReplace: able(true),
    remove: (nodeId, label) =>
      edit(nodeId, label, () => {
        app().removeNode(nodeId);
        return APPLIED;
      }),
    duplicate: (nodeId, label) =>
      edit(nodeId, label, () => {
        app().duplicateNode(nodeId);
        return APPLIED;
      }),
    history: able({
      undo: async () => {
        await app().undo();
        return APPLIED;
      },
      redo: async () => {
        await app().redo();
        return APPLIED;
      },
    }),
    // Desktop saves as it edits; ⌘S writes what is pending now, which is what flushSave does.
    save: async () => {
      try {
        await app().flushSave();
        return APPLIED;
      } catch (error: unknown) {
        return { applied: false, reason: cleanError(error) };
      }
    },
    // The ⌘E menu item's own rule (appNodeEdits.ts): an editable page, outside the interactive preview.
    openPalette: able(() => {
      if (!app().pageState?.editable) {
        return { applied: false, reason: 'The open page cannot be edited' };
      }
      if (app().inPreview) {
        return { applied: false, reason: 'The insert palette is not available in the interactive preview' };
      }
      app().setInsertOpen(true);
      return APPLIED;
    }),
    // Escape, replayed on the editor's document: the handlers its own key reaches decide what it leaves.
    escape: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return APPLIED;
    },
    notify: (message, kind) => app().showToast(message, kind),
    settings: async (appId) => {
      const answer = await readAppSettings(app().project.path, appId);
      if (!answer.ok) {
        throw new Error(answer.message);
      }
      return answer.value;
    },
    kind: 'desktop',
    version: () => readHostVersion(),
    person: () => readAppPerson(app().project.path),
    people: () => readAppPeople(app().project.path),
    onPersonChange: (listener) => onAppPersonChanged(listener),
    storage: {
      writer: DESKTOP_STORAGE_WRITER,
      get: (appId, scope, key) => readAppStorage(app().project.path, appId, scope, key),
      set: (appId, scope, key, value) => writeAppStorage(app().project.path, appId, scope, key, value),
      keys: (appId, scope) => listAppStorageKeys(app().project.path, appId, scope),
      watch: (listener) => watchAppStorage(app().project.path, listener),
    },
    // Project files and sign-ins, through main (desktopAppAccess.ts): a file change is one undo step.
    files: desktopAppFiles(appRef),
    auth: desktopAppAuth(appRef),
    net: desktopAppNet(appRef),
    // Pages and components read from disk with the parser an opened page uses; ids as opening it would give them.
    pageFiles: {
      list: () => projectFiles(app()),
      stamps: (paths) => appFileStamps(app().project.path, paths),
      readTree: async (path) => {
        const read = await readPage(joinProject(app().project.path, path));
        if (!read.editable) {
          return { editable: false, nodes: [], truncated: false };
        }
        const tree = nodeViews(read.model.nodes);
        return { editable: true, nodes: tree.views, truncated: tree.truncated };
      },
    },
  };
}

/** The project's pages, layouts and own components, relative to the project: what an app may read from disk. */
function projectFiles(app: ShellView): readonly string[] {
  const root = app.project.path;
  const files = [
    ...app.scan.pages.map((page) => projectRelative(root, page.path)),
    ...[...app.scan.layouts, ...app.scan.components].flatMap((component) => (component.file === undefined ? [] : [component.file])),
  ];
  return [...new Set(files)].filter((file) => /\.(?:astro|md|mdx)$/.test(file)).slice(0, APP_RPC_LIMITS.indexFilesMax);
}

function joinProject(projectPath: string, relativePath: string): string {
  assert(!relativePath.startsWith('/'), 'A project file is named relative to the project');
  return `${projectPath.replace(/[\\/]+$/, '')}/${relativePath}`;
}

/**
 * Names the undo step an app's edit made (`label`): the latest step, when the
 * edit pushed a new one. An edit folded into the step before it (a burst of
 * the same edit) keeps that step's name.
 */
function labelNewStep(app: ShellView, before: HistoryEntry | undefined, label: string | undefined): void {
  if (label === undefined) {
    return;
  }
  const latest = app.historyRef.current.past.at(-1);
  if (latest === undefined || latest === before) {
    return;
  }
  latest.label = label;
  assert(app.historyRef.current.past.at(-1)?.label === label, 'The new step carries its label');
}

/** The editor state apps hear about, read from the shell for this render. */
export function desktopAppEventState(app: ShellView, hoverNodeId: string | undefined): AppEventState {
  const state = app.pageState;
  return {
    selection: app.selectedId,
    hover: hoverNodeId,
    viewport: desktopViewport(app),
    panels: panelsOf(app),
    pagePath: app.currentPage?.path,
    pageVersion: state === undefined ? undefined : `${app.currentPage?.path ?? ''}:${state.source.length}:${hashOf(state.source)}`,
  };
}

// The insert as one gesture (src/app/state/appInsert.ts), then labelled and saved before it answers.
// The shell is read again after each wait, so the answer's id is checked against the page as it is now.
async function insertWith<K extends AppInsert['kind']>(insert: AppHostInsert<K>, app: () => ShellView): Promise<AppInsertOutcome> {
  if (!app().pageState?.editable) {
    return { applied: false, reason: 'The open page cannot be edited' };
  }
  const before = app().historyRef.current.past.at(-1);
  const inserted = await app().insertForApp({ item: insert.item, place: insert.place });
  if (!inserted.applied) {
    return inserted;
  }
  assert(inserted.nodeId !== undefined, 'Desktop always knows the node it inserted');
  labelNewStep(app(), before, insert.label);
  try {
    await app().flushSave();
  } catch (error: unknown) {
    return { applied: false, reason: cleanError(error) };
  }
  // The gesture's new node keeps its id once main's reply lands (src/editor/nodeHandles.ts); a page
  // that was closed or reloaded meanwhile no longer has it, and then no id is promised.
  const shown = app().pageStateRef.current.pageState;
  const present = shown?.editable === true && findEditorNodeById(shown.model.nodes, inserted.nodeId) !== undefined;
  return { applied: true, nodeId: present ? inserted.nodeId : undefined };
}

function leftTabOf(panel: AppLeftPanel): NonNullable<LeftTab> {
  return panel;
}

function panelsOf(app: ShellView): AppEventState['panels'] {
  return { left: app.leftTab, right: app.rightTab };
}

/**
 * A canvas box (its viewport's CSS pixels) as the part of the editor window that
 * shows it: the frame is drawn scaled by the canvas zoom, and only what lies
 * within the frame is on screen. Undefined when none of it is.
 */
function windowRectOf(box: AppRect): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-clip iframe') ?? undefined;
  if (frame === undefined || frame.clientWidth === 0) {
    return undefined;
  }
  const shown = frame.getBoundingClientRect();
  const scale = shown.width / frame.clientWidth;
  assert(scale > 0, 'The canvas is drawn at a positive zoom');
  const left = Math.max(shown.left, shown.left + box.x * scale);
  const top = Math.max(shown.top, shown.top + box.y * scale);
  const right = Math.min(shown.right, shown.left + (box.x + box.width) * scale);
  const bottom = Math.min(shown.bottom, shown.top + (box.y + box.height) * scale);
  if (right - left < 1 || bottom - top < 1) {
    return undefined;
  }
  return { x: Math.floor(left), y: Math.floor(top), width: Math.ceil(right - left), height: Math.ceil(bottom - top) };
}

function canvasFrame(): Window | undefined {
  const frame = document.querySelector<HTMLIFrameElement>('.frame-clip iframe');
  return frame?.contentWindow ?? undefined;
}

function desktopViewport(app: ShellView): AppViewport {
  const sized = typeof document === 'undefined' ? undefined : (document.querySelector<HTMLElement>('.frame-sized') ?? undefined);
  const widthPx = sized?.offsetWidth ?? 0;
  const heightPx = sized?.offsetHeight ?? 0;
  const shown = sized?.getBoundingClientRect().width ?? 0;
  const scale = widthPx > 0 && shown > 0 ? Math.round((shown / widthPx) * 1000) / 1000 : 1;
  return { widthPx, heightPx, scale, device: app.device };
}

function pageView(app: ShellView): AppPageView | undefined {
  const state = app.pageState;
  const path = app.currentPage?.path;
  if (state === undefined || path === undefined) {
    return undefined;
  }
  // A page shown as raw text has no tree to read; its path still says what is open.
  const tree = state.editable ? nodeViews(state.model.nodes) : { views: [], truncated: false };
  return { path: projectRelative(app.project.path, path), editable: state.editable, nodes: tree.views, truncated: tree.truncated };
}

// Nodes and their children as apps read them, within the reply's node and depth bounds.
function nodeViews(roots: readonly EditorNode[]): { readonly views: readonly AppNodeView[]; readonly truncated: boolean } {
  let remaining = APP_RPC_LIMITS.treeNodesMax;
  // Recursion is bounded by treeDepthMax, asserted on entry.
  const visit = (node: EditorNode, depth: number): AppNodeView => {
    assert(depth <= APP_RPC_LIMITS.treeDepthMax, 'Node views stop at the depth bound');
    remaining -= 1;
    const children: AppNodeView[] = [];
    if (depth < APP_RPC_LIMITS.treeDepthMax) {
      for (const child of node.children ?? []) {
        if (remaining <= 0) {
          break;
        }
        children.push(visit(child, depth + 1));
      }
    }
    return { ...nodeFields(node), children };
  };
  const views: AppNodeView[] = [];
  for (const root of roots) {
    if (remaining <= 0) {
      break;
    }
    views.push(visit(root, 0));
  }
  return { views, truncated: remaining <= 0 };
}

function nodeFields(node: EditorNode): Omit<AppNodeView, 'children'> {
  const props = node.props ?? {};
  const attributes: Record<string, string> = {};
  for (const [name, attr] of Object.entries(props)) {
    if (attr.type === 'string' && name !== 'class') {
      attributes[name] = attr.value;
    }
  }
  const classAttr = props['class'];
  const classes = classAttr?.type === 'string' ? classAttr.value.split(/\s+/).filter((name) => name.length > 0) : [];
  const textValue = node.kind === 'text' ? node.value : undefined;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name ?? '',
    classes,
    attributes,
    text: textValue === undefined ? undefined : textValue.slice(0, APP_RPC_LIMITS.nodeTextCharsMax),
  };
}

/** A file as apps name it: relative to the project (`page.get`'s `path`, and the page a layer names). */
export function projectRelative(projectPath: string, filePath: string): string {
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const file = filePath.replace(/\\/g, '/');
  return file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file;
}

// A short, cheap fingerprint of the page text, so an edit that keeps its length still reads as a change.
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}
