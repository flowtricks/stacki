// Stacki Apps in Studio's editor: the shared Apps panel, host and overlay layer
// (vendor/stacki/src/features/apps) with Studio's commands. Selection, hover,
// panels, device, scrolling, the page tree, inserting elements and components
// (at the selection or a named place), removing and duplicating run Studio's own
// editor actions, as do undo, redo and save (the shared document's history).
// Attribute, class and inline style edits, a new node's attributes or props,
// replacing a node and the insert palette answer `applied: false` with a reason: Studio's style and
// settings panels edit through its shared document, which apps do not reach yet;
// each is an `unable` ability, so `app.info`'s `can` says so before an app tries.
// Storage and the person go to the Studio server (appDataClient.ts).
import { readAppSettings } from './publishClient';
import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import AppsPanel from '../../../vendor/stacki/src/features/apps/AppsPanel';
import { AppsHost } from '../../../vendor/stacki/src/features/apps/AppsHost';
import { AppOverlayLayer } from '../../../vendor/stacki/src/features/apps/AppOverlayLayer';
import { useAppsRuntime, useRefTargetLookup } from '../../../vendor/stacki/src/features/apps/appsRuntime';
import { setAppsPanelReveal } from '../../../vendor/stacki/src/features/apps/appsDirectory';
import { overlayAnchorPaths, type MeasuredRects } from '../../../vendor/stacki/src/features/apps/overlayPlacement';
import { able, unable, type AppHostCommands } from '../../../vendor/stacki/src/features/apps/appRpcHost';
import {
  STUDIO_STORAGE_WRITER,
  listStudioAppStorageKeys,
  onStudioPersonChange,
  readStudioAppPeople,
  readStudioAppPerson,
  readStudioAppStorage,
  readStudioHostVersion,
  watchStudioAppStorage,
  writeStudioAppStorage,
} from './appDataClient';
import { studioFileStamps, studioFileTree } from './pageFilesClient';
import { connectAppAuth, disconnectAppAuth, onAppAuthChanged, readAppAccessToken, readAppAuthStatus, runAppFileCall, runAppNetFetch } from './accessClient';
import { useCanvasCapture } from '../../../vendor/stacki/src/features/apps/useCanvasCapture';
import { useMeasureRequests } from '../../../vendor/stacki/src/features/apps/overlayMeasure';
import type {
  AppEditOutcome,
  AppInsert,
  AppInsertOutcome,
  AppInsertPlace,
  AppLeftPanel,
  AppNodeView,
  AppViewport,
} from '../../../vendor/stacki/shared/properties/appsRpc';
import { insertedNodeId, planStudioInsert } from './studioAppInsert';
import { APP_RPC_LIMITS } from '../../../vendor/stacki/shared/properties/appsRpc';
import { githubLoginAvatar } from '../../../vendor/stacki/shared/ipc/commitAvatars';
import CommitAvatar from '../../../vendor/stacki/src/features/history/CommitAvatar';
import type { ParserNode } from '../source/source';
import { routeFor } from '../project/projectClient';
import { useStudioRole } from '../roles/useEditorRole';
import { canStudioPanel, getStudioRole } from '../roles/roleStore';
import { registerAgentTaskHandler } from '../../../vendor/stacki/src/lib/agentTasks';
import { chatState, createChat, updateChat } from '../ai/chatState';
import { can } from '../../../vendor/stacki/shared/properties/projectRoles';
import { pathFor } from '../project/previewSelection';
import type { EditorProps } from '../../app/Editor';
import type { Panel } from '../../app/EditorRail';
import type { useEditor } from '../project/useEditor';

type EditorModel = ReturnType<typeof useEditor>;
type AppViewportDevice = AppViewport['device'];

/** Why an edit Studio's panels make through the shared document is not an app's yet. */
const NOT_YET = 'This edit is not available to apps in Studio yet; it works in Stacki Desktop.';

/** The canvas path of a Studio node id in the open file, as the outlines key it. */
export function studioAppPath(file: string, nodeId: string): string {
  return (file.startsWith('src/pages/') ? '' : `${file}|`) + pathFor(nodeId);
}

function notifyWith(report: (problem: unknown) => void) {
  return (message: string, kind: 'info' | 'success' | 'error') => report(kind === 'error' ? new Error(message) : message);
}

function avatar(login: string | undefined, name: string): ReactNode {
  return <CommitAvatar name={login ?? name} email="" url={login === undefined ? undefined : githubLoginAvatar(login)} />;
}

export function StudioAppsPanel({ props }: { readonly props: EditorProps }) {
  const role = useStudioRole();
  return <AppsPanel projectPath={props.project.name} role={role} notify={notifyWith(props.report)} renderAvatar={avatar} />;
}

export function StudioAppsHost({ props, model }: { readonly props: EditorProps; readonly model: EditorModel }) {
  const current = useRef({ props, model });
  current.current = { props, model };
  const host = useMemo(() => studioAppHost(current), []);
  const role = useStudioRole();
  useEffect(() => {
    setAppsPanelReveal(() => current.current.props.view.setPanel('apps'));
    return () => setAppsPanelReveal(undefined);
  }, []);
  // The Apps panel's "Build an app" opens Studio's chat on the prompt, unsent (the same hand-off as Desktop's AI panel).
  useEffect(
    () =>
      registerAgentTaskHandler('studio-chat', 20, async (task) => {
        if (task.delivery !== 'draft' || !canStudioPanel(getStudioRole(), 'ai')) {
          return { tag: 'declined' };
        }
        const draftCharsMax = 12_000; // The composer's own limit (ChatComposer.tsx); a longer prompt would be cut.
        if (task.prompt.length > draftCharsMax) {
          return { tag: 'declined' };
        }
        // A chat with something typed or said is left as it is: the prompt goes to a new one, or after the typed words when the chats are full.
        const busy = (thread: { readonly draft: string; readonly messages: readonly unknown[] }) => thread.draft.trim() !== '' || thread.messages.length > 0;
        const active = chatState().threads.find((thread) => thread.id === chatState().active);
        if (active !== undefined && busy(active)) {
          createChat(active.model);
        }
        const target = chatState().threads.find((thread) => thread.id === chatState().active);
        if (target === undefined) {
          return { tag: 'declined' };
        }
        const joined = target.draft.trim() === '' ? task.prompt : `${target.draft}\n\n${task.prompt}`;
        if (joined.length > draftCharsMax) {
          return { tag: 'declined' };
        }
        updateChat(target.id, (thread) => ({ ...thread, draft: joined }));
        current.current.props.view.setPanel('ai');
        return { tag: 'sent', where: 'the AI chat' };
      }),
    [],
  );
  useCanvasCapture({
    // A click's id is the open file's index path (previewClient.ts); `0` is the layout, as pathFor reads it.
    nodeIdForPath: (path) => {
      const nodeId = path === '0' ? 'layout' : `n${path}`;
      return findNode(current.current.model.nodes, nodeId) === undefined ? undefined : nodeId;
    },
    sendCursor: (cursor) => current.current.model.preview.send({ type: 'avb:app-cursor', cursor: cursor ?? 'none' }),
    // A page's markup carries bare paths; a component open on its own has no page around it to name.
    canvasPage: () => (current.current.props.file.startsWith('src/pages/') ? current.current.props.file : undefined),
  });
  const { view } = props;
  const state = {
    selection: model.selected || undefined,
    hover: model.preview.outlines.hovered?.id,
    viewport: canvasViewport(view.device),
    panels: { left: leftOf(view.panel), right: view.tab },
    pagePath: props.file,
    pageVersion: model.document === undefined ? undefined : `${props.file}:${model.nodes.length}:${JSON.stringify(model.nodes).length}`,
  };
  return <AppsHost projectPath={props.project.name} host={host} role={role} state={state} notify={notifyWith(props.report)} />;
}

/** App overlay anchors for the canvas to measure, beside collaborators' selections. */
export function useStudioAppAnchors(file: string): readonly string[] {
  const runtime = useAppsRuntime();
  const measuring = useMeasureRequests();
  const refTarget = useRefTargetLookup();
  return overlayAnchorPaths(runtime.overlays, measuring, refTarget, (nodeId) => studioAppPath(file, nodeId));
}

export function StudioAppOverlays({ rects, scale, file }: { readonly rects: MeasuredRects; readonly scale: number; readonly file: string }) {
  return <AppOverlayLayer rects={rects} scale={scale} pathFor={(nodeId) => studioAppPath(file, nodeId)} />;
}

// The canvas as it is drawn: the shared preview's sized frame (previewViewport.css).
function canvasViewport(device: AppViewportDevice): AppViewport {
  const sized = document.querySelector<HTMLElement>('.frame-sized') ?? undefined;
  const widthPx = sized?.offsetWidth ?? 0;
  const shown = sized?.getBoundingClientRect().width ?? 0;
  const scale = widthPx > 0 && shown > 0 ? Math.round((shown / widthPx) * 1000) / 1000 : 1;
  return { widthPx, heightPx: sized?.offsetHeight ?? 0, scale, device };
}

function leftOf(panel: Panel | undefined): AppLeftPanel | undefined {
  if (panel === undefined || panel === 'ai') {
    return undefined;
  }
  return panel === 'collections' ? 'cms' : panel;
}

function panelOf(panel: AppLeftPanel): Panel {
  if (panel === 'cms') {
    return 'collections';
  }
  // Studio has no style selectors, Instructions or Audits panel; the navigator is its closest.
  if (panel === 'instructions' || panel === 'audits') {
    return 'navigator';
  }
  return panel === 'selectors' ? 'navigator' : panel;
}

function studioAppHost(current: { readonly current: { readonly props: EditorProps; readonly model: EditorModel } }): AppHostCommands {
  const model = () => current.current.model;
  const view = () => current.current.props.view;
  const known = (nodeId: string) => findNode(model().nodes, nodeId) !== undefined;
  const act = async (nodeId: string, label: string | undefined, run: () => void): Promise<AppEditOutcome> => {
    if (!model().editable || !known(nodeId)) {
      return { applied: false, reason: 'No editable element has that id on the open page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
    labelled(model().document, label, run);
    await model().document?.whenSaved();
    return { applied: true };
  };
  const insertWith = async (insert: {
    readonly item: AppInsert;
    readonly place: AppInsertPlace;
    readonly label: string | undefined;
  }): Promise<AppInsertOutcome> => {
    const document = model().document;
    if (document === undefined || !document.ready || !model().editable) {
      return { applied: false, reason: 'The open page cannot be edited' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
    }
    const page = { file: current.current.props.file, text: document.text.toString(), selected: model().selected };
    const plan = planStudioInsert(page, current.current.props.project, insert);
    if (plan.kind === 'refused') {
      return { applied: false, reason: plan.reason };
    }
    const before = page.text;
    let sent: Promise<boolean> = Promise.resolve(false);
    labelled(document, insert.label, () => {
      sent = document.action(plan.action);
    });
    try {
      if (!(await sent)) {
        return { applied: false, reason: 'Someone else has that element selected' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      // The server's answer carries the page change and, with it, the selection of what was inserted.
      await textChangedFrom(document, before);
      await document.whenSaved();
    } catch (error: unknown) {
      return { applied: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return { applied: true, nodeId: insertedNodeId(document.text.toString(), document.selected, insert.item) };
  };
  return {
    viewport: () => canvasViewport(view().device),
    setDevice: (device) => view().setDevice(device),
    setWidth: unable('Setting the canvas width is not available to apps in Studio yet; choose a device with canvas.setDevice.'),
    scrollTo: able((target) => {
      if (!('nodeId' in target)) {
        // A point scrolls through the frame's app-scroll message, which the dispatcher sends (appRpcHost.ts scrollCanvas).
        return { applied: false, reason: 'A point is scrolled by the canvas itself' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      if (!known(target.nodeId)) {
        return { applied: false, reason: 'That element is not on the canvas' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      model().preview.reveal(target.nodeId, target.occurrence ?? 0, { replayOnLoad: false });
      return { applied: true };
    }),
    openPanel: (panel) => view().setPanel(panelOf(panel)),
    closePanel: () => view().setPanel(undefined),
    openRightPanel: (panel) => view().setTab(panel),
    panels: () => ({ left: leftOf(view().panel), right: view().tab }),
    selection: () => ({ nodeId: model().selected || undefined }),
    select: (nodeId) => {
      if (nodeId !== undefined && !known(nodeId)) {
        return { applied: false, reason: 'No element has that id on the open page' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      model().select(nodeId ?? '');
      return { applied: true };
    },
    page: () => ({ path: current.current.props.file, editable: model().editable, ...nodeViews(model().nodes) }),
    pages: () => current.current.props.project.pages.map((page) => ({ path: page, route: routeFor(page), title: undefined })),
    openPage: (path) => {
      if (!current.current.props.project.pages.includes(path)) {
        return { applied: false, reason: 'This project has no page at that path' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      current.current.props.open(path);
      return { applied: true };
    },
    // The Components panel's own open: the component's canvas on its own, with no page instance's props.
    openComponent: able((path) => {
      const component = current.current.props.project.components.find((entry) => entry.file === path);
      if (component === undefined) {
        return { applied: false, reason: 'This project has no component at that path' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      if (component.origin?.kind === 'package') {
        return { applied: false, reason: 'Package components are read-only' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      if (!can(getStudioRole(), 'component:edit')) {
        return { applied: false, reason: 'Your role cannot edit components in this project' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      current.current.props.open(path);
      return { applied: true };
    }),
    // Studio's canvas is a browser frame of another origin: the browser has no photograph of it to give.
    snapshot: unable('Canvas snapshots are not available in Studio; they work in Stacki Desktop.'),
    node: (nodeId) => {
      const node = findNode(model().nodes, nodeId);
      return node === undefined ? undefined : nodeViews([node]).nodes[0];
    },
    attributes: unable(NOT_YET),
    classes: unable(NOT_YET),
    setStyle: unable(NOT_YET),
    // The quick insert's own actions (studioAppInsert.ts), at the selection or the place the app names.
    insertElement: able((insert) => insertWith(insert)),
    insertComponent: (insert) => insertWith(insert),
    // Studio's insert actions add a bare node, and removing the replaced node would be a second history step.
    insertAttributes: unable('Giving a new node attributes or props is not available to apps in Studio yet; it works in Stacki Desktop.'),
    insertReplace: unable('Replacing a node in one step is not available to apps in Studio yet; it works in Stacki Desktop.'),
    remove: (nodeId, label) => act(nodeId, label, () => model().action({ kind: 'delete', node: nodeId })),
    duplicate: (nodeId, label) => act(nodeId, label, () => model().action({ kind: 'duplicate', node: nodeId })),
    // The shared document's history: what ⌘Z and ⇧⌘Z run in Studio (useEditorKeys.ts).
    history: able({ undo: () => stepHistory(model().document, 'undo'), redo: () => stepHistory(model().document, 'redo') }),
    // Studio saves as it edits; ⌘S waits for what is pending to be written.
    save: async () => {
      const document = model().document;
      if (document === undefined) {
        return { applied: false, reason: 'No page is open' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
      }
      await document.whenSaved();
      return { applied: true };
    },
    // Studio's palette is local to its quick insert (QuickInsert.tsx), which apps do not reach yet.
    openPalette: unable('Opening the insert palette is not available to apps in Studio yet; it works in Stacki Desktop.'),
    // Escape, replayed on the editor's document: the handlers its own key reaches decide what it leaves.
    escape: () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return { applied: true };
    },
    notify: (message, kind) => notifyWith(current.current.props.report)(message, kind),
    settings: async (appId) => {
      const answer = await readAppSettings('', appId);
      if (!answer.ok) {
        throw new Error(answer.message);
      }
      return answer.value;
    },
    kind: 'studio',
    version: () => readStudioHostVersion(),
    person: () => readStudioAppPerson(),
    people: () => readStudioAppPeople(),
    onPersonChange: (listener) => onStudioPersonChange(listener),
    storage: {
      writer: STUDIO_STORAGE_WRITER,
      get: readStudioAppStorage,
      set: writeStudioAppStorage,
      keys: listStudioAppStorageKeys,
      watch: watchStudioAppStorage,
    },
    // Project files and sign-ins, on the server (appAccessServer.ts). A file change reaches open editors
    // through the server's watcher and the collaboration rooms; Studio's history is the shared
    // document's, which keeps no step for a change on disk, so the label is not shown here.
    files: { run: (appId, operation) => runAppFileCall('', appId, operation) },
    auth: {
      connect: (appId, provider) => connectAppAuth('', appId, provider),
      token: (appId, provider) => readAppAccessToken('', appId, provider),
      disconnect: (appId, provider) => disconnectAppAuth('', appId, provider),
      status: (appId) => readAppAuthStatus('', appId),
      watch: (listener) => onAppAuthChanged(listener),
    },
    net: { fetch: (appId, request) => runAppNetFetch('', appId, request) },
    // Pages and components read from the server and parsed here, as opening them would; ids match an opened page's.
    pageFiles: {
      list: () => {
        const { project } = current.current.props;
        const files = [...project.pages, ...project.components.map((component) => component.file)];
        return [...new Set(files)].filter((file) => /\.(?:astro|md|mdx)$/.test(file)).slice(0, APP_RPC_LIMITS.indexFilesMax);
      },
      stamps: (paths) => studioFileStamps(paths),
      readTree: async (path) => {
        const read = await studioFileTree(path);
        return { editable: read.editable, ...nodeViews(read.nodes) };
      },
    },
  };
}

// Runs an app's edit and names the history step it made (`label`), when it made one.
function labelled(document: EditorModel['document'], label: string | undefined, run: () => void): void {
  const before = document?.history.newest();
  run();
  if (label !== undefined) {
    document?.history.labelNewest(before, label);
  }
}

/** How often an insert looks for the server's answer: it lands within a few frames. */
const INSERT_POLL_MS = 50;

// Waits, within the navigation bound, for the page text to change from `before`: the server's
// answer to an action this window sent. Past the bound it stops waiting; the insert's id is then unknown.
async function textChangedFrom(document: NonNullable<EditorModel['document']>, before: string): Promise<void> {
  const pollsMax = Math.ceil(APP_RPC_LIMITS.navigateTimeoutMs / INSERT_POLL_MS);
  for (let poll = 0; poll < pollsMax; poll += 1) {
    if (document.text.toString() !== before) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, INSERT_POLL_MS));
  }
}

async function stepHistory(document: EditorModel['document'], direction: 'undo' | 'redo'): Promise<AppEditOutcome> {
  if (document === undefined) {
    return { applied: false, reason: 'No page is open' }; // i18n-ignore: refusal returned to the app over the SDK for its developer, never drawn by Stacki.
  }
  await document.history.step(direction);
  return { applied: true };
}

function findNode(nodes: readonly ParserNode[], nodeId: string): ParserNode | undefined {
  const queue = [...nodes];
  for (let visited = 0; visited < APP_RPC_LIMITS.treeNodesMax * 4 && queue.length > 0; visited += 1) {
    const node = queue.shift();
    if (node?.id === nodeId) {
      return node;
    }
    queue.push(...(node?.children ?? []));
  }
  return undefined;
}

function nodeViews(roots: readonly ParserNode[]): { readonly nodes: readonly AppNodeView[]; readonly truncated: boolean } {
  let remaining = APP_RPC_LIMITS.treeNodesMax;
  // Recursion is bounded by treeDepthMax.
  const visit = (node: ParserNode, depth: number): AppNodeView => {
    remaining -= 1;
    const attributes: Record<string, string> = {};
    for (const [name, attr] of Object.entries(node.props ?? {})) {
      if (attr.type === 'string' && name !== 'class') {
        attributes[name] = attr.value;
      }
    }
    const classAttr = node.props?.['class'];
    const children: AppNodeView[] = [];
    if (depth < APP_RPC_LIMITS.treeDepthMax) {
      for (const child of node.children ?? []) {
        if (remaining <= 0) {
          break;
        }
        children.push(visit(child, depth + 1));
      }
    }
    return {
      id: node.id ?? '',
      kind: node.kind,
      name: node.name ?? '',
      classes: classAttr?.type === 'string' ? classAttr.value.split(/\s+/).filter((name: string) => name.length > 0) : [],
      attributes,
      text: node.kind === 'text' && node.value !== undefined ? node.value.slice(0, APP_RPC_LIMITS.nodeTextCharsMax) : undefined,
      children,
    };
  };
  const nodes: AppNodeView[] = [];
  for (const root of roots) {
    if (remaining <= 0) {
      break;
    }
    nodes.push(visit(root, 0));
  }
  return { nodes, truncated: remaining <= 0 };
}
