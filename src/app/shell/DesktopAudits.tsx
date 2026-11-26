// Desktop's side of the Audits panel: the runner that keeps the report current
// (mounted with the shell, so findings are current when the panel opens),
// the terminal dock registered as the agent-task handler until the AI
// panel registers its own, and the panel's tab with what fixes and reveals
// write through — the open page's own edit queue, and the page edit channels
// for every other file.
import { useEffect, useRef } from 'react';
import { toFilePath } from '../../../shared/core/brand';
import { can } from '../../../shared/properties/projectRoles';
import { registerAgentTaskHandler } from '../../lib/agentTasks';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { readPage } from '../../ipc/bridge';
import { styleTransport } from '../../ipc/editorEnvironment';
import { record, text } from '../../../shared/core/boundary';
import { editProjectPage, editProjectPageBatch } from '../../ipc/appBridge';
import { nodeAtPath } from '../../editor/editorTree';
import type { EditorNode } from '../../editor/pageView';
import { useAuditRunner } from '../../features/audits/useAuditRunner';
import { absolutePath, type FixDeps } from '../../features/audits/auditFixes';
import { terminalAgentHandler } from '../../features/terminal/terminalAgent';
import { AuditsPanel } from '../appPanels';
import { relativeTo } from '../../features/audits/auditScope';
import { hostRoute } from '../../features/audits/auditPlaces';
import { openAppSettings } from '../settings/LazySettings';
import { nextReveal, revealNode, type PendingReveal, type StyleBlockCode } from './auditReveal';
import { lineAtOffset, type AuditCodeTarget } from '../../features/audits/tokenActions';
import { AUDIT_VALUE_KIT } from './auditValueKit';
import { selectFromPanel } from './panelSelection';
import type { ShellView } from '../App';
import { plainStepFiles } from '../model/componentCreation';

/** The terminal's place among agent-task handlers: below the AI panel's, when there is one. */
const TERMINAL_HANDLER_PRIORITY = 10;

/** An element a finding named in a file that was not open: selected once that file opens. */
let pendingReveal: PendingReveal | undefined;

/** A component waiting for the page it is to be opened on: opened once that page shows. */
let pendingOpen: { readonly hostPath: string; readonly file: string } | undefined;

export function AuditsHost({ app }: { readonly app: ShellView }) {
  const open =
    app.currentPage?.path === undefined
      ? undefined
      : { path: app.currentPage.path, kind: app.currentPage.kind === 'component' ? ('component' as const) : ('page' as const) };
  useAuditRunner({ projectPath: app.project.path, scan: app.scan, open, pageState: app.pageState, devUrl: app.devStatus === 'on' ? app.devUrl : undefined });
  const role = useCurrentRole();
  const { setTermOpen } = app;
  useEffect(
    () =>
      registerAgentTaskHandler(
        'terminal',
        TERMINAL_HANDLER_PRIORITY,
        terminalAgentHandler({ platform: window.avb.platform, available: () => can(role, 'code:edit'), openDock: () => setTermOpen(true) }),
      ),
    [role, setTermOpen],
  );
  const state = app.pageState;
  const shownPath = app.currentPage?.path;
  const appRef = useRef(app);
  appRef.current = app;
  const rendered = app.renderedPaths !== undefined;
  useEffect(() => {
    const waiting = pendingOpen;
    if (waiting !== undefined && shownPath === waiting.hostPath && state !== undefined) {
      pendingOpen = undefined;
      openFinding(appRef.current, waiting.file);
    }
  }, [shownPath, state]);
  useEffect(() => {
    const wanted = pendingReveal;
    if (wanted === undefined) {
      return;
    }
    const step = nextReveal(wanted, { shownPath, editable: state?.editable === true, rendered });
    pendingReveal = step.pending;
    if (step.select && state?.editable === true) {
      const node = nodeAtPath<EditorNode>(state.model.nodes, wanted.trail);
      if (node !== undefined) {
        revealNode(appRef.current, node.id);
      }
      if (wanted.code !== undefined) {
        openStyleCode(appRef.current, state.model.nodes, wanted.code);
      }
    }
  }, [shownPath, state, rendered]);
  return undefined;
}

export function AuditsTab({ app }: { readonly app: ShellView }) {
  return (
    <AuditsPanel
      project={app.project}
      fixDeps={() => fixDeps(app)}
      onReveal={(file: string, trail: readonly number[] | undefined, prop: string | undefined, code?: AuditCodeTarget, routes?: readonly string[]) =>
        reveal(app, { file, trail, prop, code, routes })
      }
      onHover={(file: string, trail: readonly number[] | undefined) => hover(app, file, trail)}
      onCreatePage={(route: string) => app.onCreatePage(route.replace(/^\/+|\/+$/g, '') || 'index', undefined)}
      routes={app.scan.pages.map((page) => page.route).filter((route) => !route.includes('['))}
      showToast={app.showToast}
      measure={() => measureTargets(app)}
      sources={() => searchSources(app)}
      onConfigure={() => openAppSettings('audits')}
      valueKit={AUDIT_VALUE_KIT}
    />
  );
}

// The open file's node at `trail`, when the file is the one shown.
function shownNode(app: ShellView, file: string, trail: readonly number[]): EditorNode | undefined {
  const state = app.pageStateRef.current.pageState;
  if (app.currentPage?.path !== absolutePath(app.project.path, file) || state?.editable !== true) {
    return undefined;
  }
  return nodeAtPath<EditorNode>(state.model.nodes, trail);
}

// The `<style>` block's code window, at the declaration's line. The offset is into the block's text, the same text the window
// shows, so the line is counted there; a block that is gone or no longer raw (edited since the audit) opens nothing.
function openStyleCode(app: ShellView, nodes: readonly EditorNode[], code: StyleBlockCode): void {
  const node = nodeAtPath<EditorNode>(nodes, code.path);
  if (node?.kind === 'raw') {
    app.openCodeWindowAt(node.id, lineAtOffset(node.inner, code.offset));
  }
}

function hover(app: ShellView, file: string, trail: readonly number[] | undefined): void {
  app.setHoverNodeId(trail === undefined ? undefined : shownNode(app, file, trail)?.id);
}

function measureTargets(app: ShellView) {
  const pages = app.scan.pages
    .filter((page) => !page.route.includes('['))
    .map((page) => ({ route: page.route, file: relativeTo(app.project.path, page.path) }));
  const open = app.currentPage?.path;
  return {
    projectPath: app.project.path,
    devUrl: app.devStatus === 'on' ? app.devUrl : undefined,
    current: pages.find((page) => absolutePath(app.project.path, page.file) === open),
    pages,
  };
}

function searchSources(app: ShellView) {
  const all = [...app.scan.pages, ...app.scan.layouts, ...app.scan.components.filter((entry) => entry.origin?.kind !== 'package')].map((entry) => ({
    path: entry.path,
    file: relativeTo(app.project.path, entry.path),
  }));
  const open = app.currentPage?.path;
  return { current: all.find((entry) => entry.path === open), all };
}

function fixDeps(app: ShellView): FixDeps {
  const path = app.currentPage?.path;
  const state = app.pageStateRef.current.pageState;
  return {
    projectPath: app.project.path,
    open:
      path === undefined || state?.editable !== true
        ? undefined
        : { path, model: state.model, commit: (gesture, files) => app.commitEdit(gesture, files === undefined ? {} : { files: plainStepFiles(files) }) },
    readPage,
    send: editProjectPage,
    sendBatch: editProjectPageBatch,
    readText: async (path) => text(record(await styleTransport.readStyleFile(path))['css']),
    writeText: async (path, css) => {
      await styleTransport.writeStyleFile({ filePath: path, css });
    },
    pushCommand: (command) => app.pushCommand({ label: command.label, undo: command.undo, redo: command.redo }),
  };
}

// The open file's element is selected now; another file opens first, as the Pages
// panel and the canvas open it, and its element is selected when it has loaded. A
// declaration also opens the code window at its line: a `<style>` block's own window
// (selected and re-targeted, never a second window), or a stylesheet's file.
function reveal(
  app: ShellView,
  wanted: {
    readonly file: string;
    readonly trail: readonly number[] | undefined;
    readonly prop: string | undefined;
    readonly code: AuditCodeTarget | undefined;
    readonly routes: readonly string[] | undefined;
  },
): void {
  const { file, trail, prop, code, routes } = wanted;
  const path = absolutePath(app.project.path, file);
  pendingOpen = undefined;
  if (prop !== undefined) {
    // The value is a prop on this instance: its field is in Settings.
    app.setRightTab('settings');
  }
  if (!file.endsWith('.astro') && !file.endsWith('.md') && !file.endsWith('.mdx')) {
    // A constants module, a config or a stylesheet: its text, in the code window, at the finding's line when it has one.
    void app.openProjectFile(file, code?.tag === 'file' ? { line: code.line } : undefined);
    return;
  }
  const styleCode: StyleBlockCode | undefined = code?.tag === 'style-block' ? { path: code.path, offset: code.offset } : undefined;
  const state = app.pageStateRef.current.pageState;
  const page = app.scan.pages.find((candidate) => candidate.path === path);
  const host = page === undefined ? neededHost(app, routes ?? []) : undefined;
  if (app.currentPage?.path === path && host === undefined) {
    const node = state?.editable === true && trail !== undefined ? nodeAtPath<EditorNode>(state.model.nodes, trail) : undefined;
    if (node !== undefined) {
      revealNode(app, node.id);
    } else {
      // A page-level finding: the page itself, with nothing selected in it.
      selectFromPanel(app, undefined);
    }
    if (styleCode !== undefined && state?.editable === true) {
      openStyleCode(app, state.model.nodes, styleCode);
    }
    return;
  }
  // A page-level finding (no element) only opens its file.
  pendingReveal = trail === undefined ? undefined : { path, trail, phase: 'opening', ...(styleCode === undefined ? {} : { code: styleCode }) };
  if (page !== undefined) {
    app.onSelectPage(page);
    return;
  }
  if (host !== undefined) {
    // The canvas shows a page behind an open component, and only one that uses it has the element to outline.
    pendingOpen = { hostPath: host.path, file };
    app.onSelectPage(host);
    return;
  }
  openFinding(app, file);
}

// The page to show before opening a component on it: undefined when the page behind the editor already uses it.
function neededHost(app: ShellView, routes: readonly string[]): ShellView['scan']['pages'][number] | undefined {
  const behind = app.editStack[0]?.path ?? app.currentPage?.path;
  const shown = app.scan.pages.find((candidate) => candidate.path === behind)?.route;
  const route = hostRoute(routes, shown);
  return route === undefined ? undefined : app.scan.pages.find((candidate) => candidate.route === route);
}

// Opens a component or layout a finding is in, in place of any open above the page.
function openFinding(app: ShellView, file: string): void {
  const path = absolutePath(app.project.path, file);
  const name = file
    .split('/')
    .pop()
    ?.replace(/\.astro$/, '');
  if (name !== undefined) {
    void app.openComponent(name, undefined, 0, toFilePath(path), 'jump').catch(app.reportFailure);
  }
}
