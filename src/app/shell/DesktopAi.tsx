// Desktop's side of the AI chat panel (src/features/ai/): where it sits — the
// left panel when docked, a floating window when popped out (DockableWindow,
// as app windows are) — its rail button, the agent-task handler that makes
// "Fix with AI" open a chat, and the two things the panel asks the app for:
// the terminal (an agent's sign-in runs there) and the merge editor (an undo
// whose file moved on since the agent's edit).
//
// Expanded, the docked chat leaves the left panel and covers the canvas area instead, the region the Variables
// sheet covers (CanvasCovers), so a long chat gets the editor's width and the list shows beside it (the panel
// lays itself out for its width). The expand toggle in the chat's header and Escape (outside a text field) put
// it back in the left panel. Whether it is expanded lasts for the app's session; it opens in the side panel.
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { WireMergeClash } from '../../../shared/ipc/ipcWire';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { can } from '../../../shared/properties/projectRoles';
import { aiAgentTaskHandler, AI_PANEL_HANDLER_PRIORITY } from '../../features/ai/aiAgentTask';
import { mentionComponentsOf, setMentionComponents } from '../../features/ai/mentions/componentMentions';
import { setSelectionMention } from '../../features/ai/mentions/selectionMention';
import { projectRelativePath } from '../../lib/projectPath';
import { locatorOf, selectionMentionOf } from './aiSelection';
import { useAddToChat } from './aiAddToChat';
import { mentionIndexSource } from './aiMentionIndex';
import { setMentionIndexSource } from '../../features/ai/mentions/projectMentions';
// Lends the Properties panel's prop field to the composer's component-chip popover.
import './aiMemberField';
import MergeConflictModal from '../../features/git/MergeConflictModal';
import { requestTerminalTab } from '../../features/terminal/terminalAgent';
import { openExternalURL } from '../../ipc/appBridge';
import { registerAgentTaskHandler } from '../../lib/agentTasks';
import { canPanel } from '../../lib/roleAccess';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useAiPanelWidth } from './aiPanelWidth';
import { useAiScreenshotSource } from './aiScreenshotSource';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import { readWindowMode, storeWindowMode } from '../../ui/windowPreferences';
import { AiPanel } from '../appPanels';
import type { PanelExpansion } from '../../features/ai/sessions/ChatHeader';
import type { ShellView } from '../App';

const WINDOW_MODE_KEY = 'stacki.window.ai.mode';

interface AiWindowState {
  readonly mode: WindowMode;
  /** Whether the floating window is shown; the docked panel follows the left tab instead. */
  readonly floatingOpen: boolean;
  /** Whether the docked chat covers the canvas area instead of sitting in the left panel. */
  readonly expanded: boolean;
  readonly merge: { readonly clash: WireMergeClash; readonly settle: (resolution: MergeResolution | undefined) => void } | undefined;
}

let windowState: AiWindowState = { mode: initialMode(), floatingOpen: false, expanded: false, merge: undefined };
const listeners = new Set<() => void>();

function initialMode(): WindowMode {
  // The panel starts docked and then remembers the mode it was last used in.
  return readWindowMode(WINDOW_MODE_KEY, { fallback: 'docked' });
}

function setWindowState(change: (current: AiWindowState) => AiWindowState): void {
  windowState = change(windowState);
  for (const listener of [...listeners]) {
    listener();
  }
}

function useAiWindow(): AiWindowState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => windowState,
  );
}

/** Whether the role may use the panel: it sees it (`panel:ai`) and may edit code, which agents do. */
export function useAiAvailable(): boolean {
  const role = useCurrentRole();
  return canPanel(role, 'ai') && can(role, 'code:edit');
}

/** The rail button's state and action, or undefined for a role without the panel. */
export function useAiRailButton(app: ShellView): { readonly active: boolean; readonly onSelect: () => void } | undefined {
  const available = useAiAvailable();
  const state = useAiWindow();
  if (!available) {
    return undefined;
  }
  const floating = state.mode === 'floating';
  return {
    active: floating ? state.floatingOpen : app.leftTab === 'ai' || state.expanded,
    onSelect: () => {
      if (state.expanded) {
        // The rail button closes a chat that is showing, wherever it shows.
        setWindowState((current) => ({ ...current, expanded: false }));
        return;
      }
      if (floating) {
        setWindowState((current) => ({ ...current, floatingOpen: !current.floatingOpen }));
      } else {
        app.setLeftTab((tab) => (tab === 'ai' ? undefined : 'ai'));
      }
    },
  };
}

/** The docked panel, inside the left panel. */
export function AiTab({ app }: { readonly app: ShellView }) {
  const translate = useTranslate();
  const state = useAiWindow();
  if (state.mode === 'floating') {
    return <p className="ai-empty">{translate('shell.ai.ownWindow')}</p>;
  }
  if (state.expanded) {
    // The chat is over the canvas (AiCover); one panel at a time, so two never answer the same keys.
    return undefined;
  }
  return <DockedAi app={app} />;
}

// Its own component so the wider chat width is held only while the chat is docked: a popped-out chat leaves the left panel its shared width.
function DockedAi({ app }: { readonly app: ShellView }) {
  useAiPanelWidth();
  const changeMode = useModeChange(app);
  const { setLeftTab } = app;
  const expansion = {
    expanded: false,
    onToggle: () => {
      // The left panel gives the chat up and closes, so the canvas area the chat now covers is as wide as it gets.
      setWindowState((current) => ({ ...current, expanded: true }));
      setLeftTab((tab) => (tab === 'ai' ? undefined : tab));
    },
  };
  return <AiWindow app={app} mode="docked" onModeChange={changeMode} expansion={expansion} />;
}

/** The expanded chat over the canvas area (AppPanes.tsx CanvasCovers); nothing while it is in the left panel or its own window. */
export function AiCover({ app }: { readonly app: ShellView }) {
  const available = useAiAvailable();
  const state = useAiWindow();
  const changeMode = useModeChange(app);
  const { setLeftTab } = app;
  if (!available || !state.expanded || state.mode !== 'docked') {
    return undefined;
  }
  const collapse = (): void => {
    setWindowState((current) => ({ ...current, expanded: false }));
    setLeftTab('ai');
  };
  return (
    // `display: contents` keeps the frame's own box the cover, as the Variables sheet's is; this only hears Escape.
    <div
      style={{ display: 'contents' }}
      onKeyDown={(event) => {
        if (shouldEscapeExpanded(event)) {
          event.preventDefault();
          collapse();
        }
      }}
    >
      <AiWindow app={app} mode="docked" onModeChange={changeMode} expansion={{ expanded: true, onToggle: collapse }} />
    </div>
  );
}

/**
 * Escape leaves the expanded chat only when nothing nearer used it: a menu, a dialog or the composer (which stops a
 * running turn with it) prevents the default, and a text field keeps the key for its own editing.
 */
export function shouldEscapeExpanded(event: { readonly key: string; readonly defaultPrevented: boolean; readonly target: unknown }): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented) {
    return false;
  }
  if (!(event.target instanceof HTMLElement)) {
    return true;
  }
  return !event.target.matches('input, textarea, [contenteditable], [contenteditable] *');
}

/** Shows the panel where it lives: already over the canvas, in its window, or in the left panel. */
function openAiPanel(setLeftTab: ShellView['setLeftTab']): void {
  if (windowState.expanded) {
    // Already showing over the canvas.
    return;
  }
  if (windowState.mode === 'floating') {
    setWindowState((current) => ({ ...current, floatingOpen: true }));
  } else {
    setLeftTab('ai');
  }
}

/** Mounted with the shell: the hand-off handler, the floating window and the merge editor. */
export function AiHost({ app }: { readonly app: ShellView }) {
  const available = useAiAvailable();
  const state = useAiWindow();
  const changeMode = useModeChange(app);
  useAiScreenshotSource();
  useAddToChat(app, { available, openPanel: () => openAiPanel(app.setLeftTab) });
  const projectPath = app.project.path;
  const { setLeftTab } = app;
  const scannedComponents = app.scan.components;
  const scannedLayouts = app.scan.layouts;
  const scannedPages = app.scan.pages;
  const projectClasses = app.projectClasses;
  // The composer's `@` lists the components the scan found, with paths relative to the project the agent runs in.
  useEffect(() => {
    // Layouts are components too (they take props and slots); the picker lists them under their own heading.
    setMentionComponents(mentionComponentsOf([...scannedComponents, ...scannedLayouts], { path: projectPath, platform: window.avb.platform }));
    return () => setMentionComponents(undefined);
  }, [scannedComponents, scannedLayouts, projectPath]);
  // Pages, CSS variables, classes and assets, from what the panels already hold.
  useEffect(() => {
    setMentionIndexSource(mentionIndexSource({ projectPath, platform: window.avb.platform, pages: scannedPages, classNames: projectClasses }));
    return () => setMentionIndexSource(undefined);
  }, [projectPath, scannedPages, projectClasses]);
  // "Add selected element" offers what the Properties panel shows: the selected node and the values it writes.
  const { selectedNode, selectedComponent, selectedId, pathFor } = app;
  const openPage = app.currentPage?.path;
  useEffect(() => {
    const platform = window.avb.platform;
    const openFile = openPage === undefined ? undefined : projectRelativePath(projectPath, openPage, platform);
    const place = locatorOf(selectedId === undefined ? undefined : pathFor(selectedId), openFile);
    const node = selectedNode !== undefined && 'kind' in selectedNode && selectedNode.kind !== 'frontmatter' ? selectedNode : undefined;
    setSelectionMention(
      selectionMentionOf({
        node,
        component: selectedComponent,
        file: place?.file,
        locator: place?.locator,
        componentFile: selectedComponent === undefined ? undefined : projectRelativePath(projectPath, selectedComponent.path, platform),
      }),
    );
    // pathFor is rebuilt each render; the selection and the file are what change the answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [selectedNode, selectedComponent, selectedId, openPage, projectPath]);
  useEffect(() => () => setSelectionMention(undefined), []);
  useEffect(
    () =>
      registerAgentTaskHandler(
        'ai-panel',
        AI_PANEL_HANDLER_PRIORITY,
        aiAgentTaskHandler({
          projectPath: () => projectPath,
          available: () => available,
          openPanel: () => openAiPanel(setLeftTab),
        }),
      ),
    [available, projectPath, setLeftTab],
  );
  return (
    <>
      {available && state.mode === 'floating' && state.floatingOpen && <AiWindow app={app} mode="floating" onModeChange={changeMode} />}
      {state.merge !== undefined && <AiMerge merge={state.merge} />}
    </>
  );
}

function AiWindow({
  app,
  mode,
  expansion,
  onModeChange,
}: {
  readonly app: ShellView;
  readonly mode: WindowMode;
  readonly expansion?: PanelExpansion | undefined;
  readonly onModeChange: (mode: WindowMode) => void;
}) {
  const { setTermOpen } = app;
  const translate = useTranslate();
  return (
    <AiPanel
      projectPath={app.project.path}
      onOpenTerminal={(command) => {
        setTermOpen(true);
        // The dock mounts its tab listener as it opens; a frame lets it settle first (terminalAgent.ts does the same).
        setTimeout(() => {
          if (!requestTerminalTab(command)) {
            app.showToast(translate('shell.ai.openTerminal', { command }), 'info');
          }
        }, 0);
      }}
      onMerge={(clash, settle) => setWindowState((current) => ({ ...current, merge: { clash, settle } }))}
      onOpenExternal={(url) => void openExternalURL(url)}
      // The same way the Audits panel and Settings show a project file: in the code panel.
      onOpenFile={(path) => void app.openProjectFile(path)}
      expansion={expansion}
      windowToggle={{ floating: mode === 'floating', onToggle: () => onModeChange(mode === 'floating' ? 'docked' : 'floating') }}
      renderFrame={(header: ReactNode, body: ReactNode) => (
        <DockableWindow
          mode={mode}
          onModeChange={onModeChange}
          label={translate('rail.ai')}
          dockToggle="none"
          className={expansion?.expanded === true ? 'ai-frame is-expanded' : 'ai-frame'}
          header={header}
          minimumSize={{ width: 340, height: 360 }}
          initialSize={{ width: 420, height: 620 }}
          storageKey="stacki.window.ai"
        >
          {body}
        </DockableWindow>
      )}
    />
  );
}

function AiMerge({ merge }: { readonly merge: NonNullable<AiWindowState['merge']> }) {
  const translate = useTranslate();
  const beforeAgent = translate('shell.ai.beforeAgent');
  const settle = (resolution: MergeResolution | undefined): void => {
    setWindowState((current) => ({ ...current, merge: undefined }));
    merge.settle(resolution);
  };
  return (
    <MergeConflictModal
      conflict={{ ok: false, conflicted: true, from: beforeAgent, branch: beforeAgent, files: [merge.clash] }}
      branches={[beforeAgent]}
      trunk={translate('shell.ai.yourFileNow')}
      busy={undefined}
      onCancel={() => settle(undefined)}
      onResolve={(choices) => {
        const resolution = choices[merge.clash.path];
        assert(resolution !== undefined, 'AiMerge: the editor answers for the one file it showed');
        settle(resolution);
      }}
    />
  );
}

function useModeChange(app: ShellView): (mode: WindowMode) => void {
  const { setLeftTab } = app;
  return (mode) => {
    storeWindowMode(WINDOW_MODE_KEY, mode);
    // A window of its own is never also expanded: popping out ends it, and docking returns to the left panel.
    setWindowState((current) => ({ ...current, mode, floatingOpen: mode === 'floating', expanded: false }));
    // Popped out, the left panel gives its room back; docked again, the chat returns to it.
    setLeftTab((tab) => (mode === 'floating' ? (tab === 'ai' ? undefined : tab) : 'ai'));
  };
}
