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
import { openAppSettings } from '../settings/Settings';
import { nextReveal, revealNode, type PendingReveal } from './auditReveal';
import { AUDIT_VALUE_KIT } from './auditValueKit';
import { selectFromPanel } from './panelSelection';
import type { ShellView } from '../App';

/** The terminal's place among agent-task handlers: below the AI panel's, when there is one. */
const TERMINAL_HANDLER_PRIORITY = 10;

/** An element a finding named in a file that was not open: selected once that file opens. */
let pendingReveal: PendingReveal | undefined;

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
    }
  }, [shownPath, state, rendered]);
  return undefined;
}

export function AuditsTab({ app }: { readonly app: ShellView }) {
  return (
    <AuditsPanel
      project={app.project}
      fixDeps={() => fixDeps(app)}
      onReveal={(file: string, trail: readonly number[] | undefined, prop: string | undefined) => reveal(app, file, trail, prop)}
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
        : { path, model: state.model, commit: (gesture, files) => app.commitEdit(gesture, files === undefined ? {} : { files }) },
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
// panel and the canvas open it, and its element is selected when it has loaded.
function reveal(app: ShellView, file: string, trail: readonly number[] | undefined, prop: string | undefined): void {
  const path = absolutePath(app.project.path, file);
  if (prop !== undefined) {
    // The value is a prop on this instance: its field is in Settings.
    app.setRightTab('settings');
  }
  if (!file.endsWith('.astro') && !file.endsWith('.md') && !file.endsWith('.mdx')) {
    // A constants module or a config: its text, in the code window.
    void app.openProjectFile(file);
    return;
  }
  const state = app.pageStateRef.current.pageState;
  if (app.currentPage?.path === path) {
    const node = state?.editable === true && trail !== undefined ? nodeAtPath<EditorNode>(state.model.nodes, trail) : undefined;
    if (node !== undefined) {
      revealNode(app, node.id);
    } else {
      // A page-level finding: the page itself, with nothing selected in it.
      selectFromPanel(app, undefined);
    }
    return;
  }
  // A page-level finding (no element) only opens its file.
  pendingReveal = trail === undefined ? undefined : { path, trail, phase: 'opening' };
  const page = app.scan.pages.find((candidate) => candidate.path === path);
  if (page !== undefined) {
    app.onSelectPage(page);
    return;
  }
  const name = file
    .split('/')
    .pop()
    ?.replace(/\.astro$/, '');
  if (name !== undefined) {
    void app.openComponent(name, undefined, 0, toFilePath(path)).catch(app.reportFailure);
  }
}
