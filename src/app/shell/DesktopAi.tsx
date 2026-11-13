// Desktop's side of the AI chat panel (src/features/ai/): where it sits — the
// left panel when docked, a floating window when popped out (DockableWindow,
// as app windows are) — its rail button, the agent-task handler that makes
// "Fix with AI" open a chat, and the two things the panel asks the app for:
// the terminal (an agent's sign-in runs there) and the merge editor (an undo
// whose file moved on since the agent's edit).
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { WireMergeClash } from '../../../shared/ipc/ipcWire';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { can } from '../../../shared/properties/projectRoles';
import { aiAgentTaskHandler, AI_PANEL_HANDLER_PRIORITY } from '../../features/ai/aiAgentTask';
import MergeConflictModal from '../../features/git/MergeConflictModal';
import { requestTerminalTab } from '../../features/terminal/terminalAgent';
import { openExternalURL } from '../../ipc/appBridge';
import { registerAgentTaskHandler } from '../../lib/agentTasks';
import { canPanel } from '../../lib/roleAccess';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { useAiPanelWidth } from './aiPanelWidth';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import { readWindowMode, storeWindowMode } from '../../ui/windowPreferences';
import { AiPanel } from '../appPanels';
import type { ShellView } from '../App';

const WINDOW_MODE_KEY = 'stacki.window.ai.mode';

interface AiWindowState {
  readonly mode: WindowMode;
  /** Whether the floating window is shown; the docked panel follows the left tab instead. */
  readonly floatingOpen: boolean;
  readonly merge: { readonly clash: WireMergeClash; readonly settle: (resolution: MergeResolution | undefined) => void } | undefined;
}

let windowState: AiWindowState = { mode: initialMode(), floatingOpen: false, merge: undefined };
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
    active: floating ? state.floatingOpen : app.leftTab === 'ai',
    onSelect: () => {
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
  return <DockedAi app={app} />;
}

// Its own component so the wider chat width is held only while the chat is docked: a popped-out chat leaves the left panel its shared width.
function DockedAi({ app }: { readonly app: ShellView }) {
  useAiPanelWidth();
  const changeMode = useModeChange(app);
  return <AiWindow app={app} mode="docked" onModeChange={changeMode} />;
}

/** Mounted with the shell: the hand-off handler, the floating window and the merge editor. */
export function AiHost({ app }: { readonly app: ShellView }) {
  const available = useAiAvailable();
  const state = useAiWindow();
  const changeMode = useModeChange(app);
  const projectPath = app.project.path;
  const { setLeftTab } = app;
  useEffect(
    () =>
      registerAgentTaskHandler(
        'ai-panel',
        AI_PANEL_HANDLER_PRIORITY,
        aiAgentTaskHandler({
          projectPath: () => projectPath,
          available: () => available,
          openPanel: () => {
            if (windowState.mode === 'floating') {
              setWindowState((current) => ({ ...current, floatingOpen: true }));
            } else {
              setLeftTab('ai');
            }
          },
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

function AiWindow({ app, mode, onModeChange }: { readonly app: ShellView; readonly mode: WindowMode; readonly onModeChange: (mode: WindowMode) => void }) {
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
      renderFrame={(header: ReactNode, body: ReactNode) => (
        <DockableWindow
          mode={mode}
          onModeChange={onModeChange}
          label={translate('rail.ai')}
          className="ai-frame"
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
    setWindowState((current) => ({ ...current, mode, floatingOpen: mode === 'floating' }));
    // Popped out, the left panel gives its room back; docked again, the chat returns to it.
    setLeftTab((tab) => (mode === 'floating' ? (tab === 'ai' ? undefined : tab) : 'ai'));
  };
}
