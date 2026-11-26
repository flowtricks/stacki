// Desktop's one git session and the two quick ways to pull beside the Git panel: the button in the title bar and
// ⌥⇧G. All three go through the session's `pull`, so one lock covers them and they report the same way
// (features/git/useGitSession.ts). Nothing here pulls on its own: a person clicks or presses the chord.
import { createContext, useContext, useEffect, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { PullButton } from '../../features/git/PullButton';
import { readIncomingGitCommits } from '../../features/git/gitChipBridge';
import { useGitSession, type GitSession } from '../../features/git/useGitSession';
import type { ComponentCanvasControl } from '../../features/preview/componentCanvas/componentCanvasSession';
import { currentDesktopPlatform } from '../../lib/shortcutLabel';
import { translateFailure } from '../../lib/i18n/translateErrorText';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { canRailTab } from '../../lib/roleAccess';
import { windowHeld } from '../../ui/busyLock';
import { isPullChord, PULL_SHORTCUT, railShortcutLabel } from '../railShortcuts';
import type { ShellView } from '../App';

/** The chord as this platform writes it. */
function pullShortcutLabel(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? railShortcutLabel(PULL_SHORTCUT) : 'Alt+Shift+G';
}

// Places that keep Option letters to type with, and dialogs, which must not have the files change underneath them.
const KEEPS_THE_CHORD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .cm-editor, dialog, [role="dialog"], [role="alertdialog"]';

export type DesktopGitSource = Pick<
  ShellView,
  | 'project'
  | 'gitInfo'
  | 'gitIncoming'
  | 'recordGitIncoming'
  | 'refreshGit'
  | 'busy'
  | 'showToast'
  | 'flushSave'
  | 'previewRef'
  | 'exitCommitPreview'
  | 'reloadFromDisk'
  | 'defaultsCanvas'
  | 'propertySave'
>;

export interface DesktopGit {
  readonly session: GitSession;
  readonly incoming: DesktopGitSource['gitIncoming'];
  /** Whether this role has the Git panel; without it there is no button and the chord is not taken. */
  readonly access: 'allowed' | 'denied';
  readonly shortcut: string;
}

export const DesktopGitContext = createContext<DesktopGit | undefined>(undefined);

export function useDesktopGit(app: DesktopGitSource, componentCanvas: ComponentCanvasControl): DesktopGit {
  const access = canRailTab(useCurrentRole(), 'history') ? 'allowed' : 'denied';
  const session = useGitSession({
    info: app.gitInfo,
    refresh: app.refreshGit,
    busy: app.busy,
    project: app.project,
    showToast: app.showToast,
    flushSave: app.flushSave,
    onPulled: () => app.recordGitIncoming(0),
    pullAccess: pullAccessOf(app, componentCanvas),
    onWorktreeChanged: async () => {
      if (app.previewRef) {
        await app.exitCommitPreview();
      }
      await app.reloadFromDisk();
    },
  });
  const quickPull = useQuickPull(app, session);
  useGitPullKey(access, quickPull);
  return { session, incoming: app.gitIncoming, access, shortcut: pullShortcutLabel(currentDesktopPlatform()) };
}

// Component defaults and the component canvas edit a scratch page under .stacki/ that a reload from disk would leave,
// and a property save is a rewrite of several files still under way.
function pullAccessOf(app: DesktopGitSource, componentCanvas: ComponentCanvasControl): 'allowed' | 'blocked' {
  if (app.defaultsCanvas.state.kind !== 'idle') {
    return 'blocked';
  }
  if (componentCanvas.state.kind !== 'idle') {
    return 'blocked';
  }
  return app.propertySave.phase === 'saving' ? 'blocked' : 'allowed';
}

// The chord's work. With commits already known it pulls at once; otherwise it asks GitHub first, outside the session's
// pipeline, so finding nothing saves nothing, reloads nothing and keeps the page's undo steps.
function useQuickPull(app: DesktopGitSource, session: GitSession): () => Promise<void> {
  const translate = useTranslate();
  const checking = useRef(false);
  // Read again after the check: the branch, the lock and the editor's state may all have moved while it ran.
  const latest = useRef({ app, session });
  latest.current = { app, session };
  return async () => {
    const info = app.gitInfo;
    if (info === undefined || checking.current || session.busy !== undefined || session.conflict !== undefined) {
      return;
    }
    if (session.host.pullAccess === 'blocked' || windowHeld()) {
      return;
    }
    if (!info.isRepo || !info.remote) {
      app.showToast(translate('git.error.noRemote'), 'info');
      return;
    }
    if (info.branch === 'HEAD') {
      app.showToast(translate('git.error.detachedHead'), 'info');
      return;
    }
    if (!info.head) {
      app.showToast(translate('git.pull.none'), 'info');
      return;
    }
    if (app.gitIncoming.kind === 'ready' && app.gitIncoming.commits > 0) {
      session.pull(app.gitIncoming.commits);
      return;
    }
    checking.current = true;
    try {
      const result = await readIncomingGitCommits(app.project.path, info.branch);
      const now = latest.current;
      if (!now.app.gitInfo?.isRepo || now.app.gitInfo.branch !== info.branch) {
        return;
      }
      if (!result.ok) {
        now.app.showToast(translate('git.pull.unavailable', { message: translateFailure(result, translate) }), 'error');
        return;
      }
      now.app.recordGitIncoming(result.value);
      if (result.value === 0) {
        now.app.showToast(translate('git.pull.none'), 'info');
      } else {
        now.session.pull(result.value);
      }
    } finally {
      checking.current = false;
    }
  };
}

// ⌥⇧G, matched on the physical key because Option rewrites the typed letter. The canvas frames forward it
// (electron/preload/frameDesign.ts), replayed as this same press.
function useGitPullKey(access: DesktopGit['access'], quickPull: () => Promise<void>): void {
  const run = useRef(quickPull);
  run.current = quickPull;
  useEffect(() => {
    if (access === 'denied') {
      return undefined;
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || !isPullChord(event)) {
        return;
      }
      if (event.target instanceof Element && event.target.closest(KEEPS_THE_CHORD)) {
        return;
      }
      event.preventDefault();
      if (!event.repeat) {
        // Failures of the check and the pull are values, said as toasts; a throw here is a broken contract and stays loud.
        void run.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [access]);
}

/** What the History panel's controls take from the window's session. */
export function useDesktopGitControls(): { readonly session: GitSession; readonly shortcut: string | undefined } {
  const git = useContext(DesktopGitContext);
  assert(git !== undefined, 'The Git panel is mounted inside the shell');
  return { session: git.session, shortcut: git.access === 'allowed' ? git.shortcut : undefined };
}

/** The title bar's button: absent without something to pull, or where pulling is refused. */
export function TitleBarPull() {
  const git = useContext(DesktopGitContext);
  if (git === undefined || git.access === 'denied') {
    return undefined;
  }
  const { session, incoming, shortcut } = git;
  const info = session.host.info;
  if (!info?.isRepo || !info.remote || !info.head || info.branch === 'HEAD' || session.host.pullAccess === 'blocked') {
    return undefined;
  }
  const known = incoming.kind === 'ready' ? incoming.commits : 0;
  if (session.pulling !== undefined) {
    // The count it set out to bring in stays while the pull and the reload after it run.
    const commits = session.pulling.commits ?? known;
    return commits > 0 ? <PullButton commits={commits} state="pulling" shortcut={shortcut} onPull={() => undefined} /> : undefined;
  }
  if (known === 0) {
    return undefined;
  }
  return <PullButton commits={known} state={session.busy === undefined ? 'idle' : 'waiting'} shortcut={shortcut} onPull={() => session.pull(known)} />;
}
