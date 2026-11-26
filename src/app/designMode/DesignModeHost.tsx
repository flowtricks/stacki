// Design mode (experimental; docs/design-mode/REMOVE.md lists how to take it out): where it meets the app.
//
// The app mounts this once (src/app/shell/AppShell.tsx, one marked line). It registers the "Design mode" button of the
// AI panel's header (src/features/ai/panelModes.ts). Turning it on copies the project into a sandbox in
// main and opens the copy (designActions.ts); from then on the window is the normal editor, every panel working on
// the copy, with three differences this module makes: its pan and zoom canvas of frames over the preview
// (DesignCanvas.tsx), its bar (DesignBar.tsx), and the style panel starting each selection on its Inline styles
// chip (src/features/style/model/inlineDefault.ts). What cannot work on a copy is out of reach (designRole.ts), and
// main refuses it anyway (electron/lib/designMode/designFence.ts).
import { useEffect, useMemo, useRef } from 'react';
import type { ShellView } from '../App';
import { registerPanelMode } from '../../features/ai/panelModes';
import { setInlineDefault } from '../../features/style/model/inlineDefault';
import { useLocale } from '../../lib/i18n/useTranslate';
import { centralIcon } from '../../ui/central/CentralIcon';
import { brush } from '../../ui/central/centralGeometry';
import PanelBoundary from '../../ui/PanelBoundary';
import { DESIGN_MODE_ENABLED, type DesignSessionState } from '../../../shared/ipc/designSession';
import { designSession } from './designBridge';
import { DESIGN_NOTICE_KEY, cancelDesignMode, enterDesignMode, exitDesignMode, type DesignHostSource, type DesignNotice } from './designActions';
import { installState, type DesignOpsContext } from './designFrameOps';
import { setAiHold } from '../../features/ai/aiHold';
import { draftHandoff } from './designHandoff';
import { applyDesignRole, clearDesignRole } from './designRole';
import { designView, isDesignModeActive, subscribeDesignView, updateDesignView, useDesignView } from './designStore';
import { DesignBar } from './DesignBar';
import { DesignCanvas } from './DesignCanvas';
import { designWord, useDesignWords, type DesignWords } from './i18n/designWords';
import './designMode.css';

/** Design mode's own mark (Central's `brush`): its header button. Only Design mode draws it. */
export const DesignModeIcon = centralIcon(brush);

/** Where Design mode's header button sits: after comment pins (10), before "+". */
const MODE_BUTTON_ORDER = 20;

export function DesignModeHost({ app }: { readonly app: ShellView }) {
  const words = useDesignWords();
  if (!DESIGN_MODE_ENABLED) {
    return undefined;
  }
  return (
    <PanelBoundary name="Design mode" label={words('mode.name')}>
      <DesignModeGate app={app} />
    </PanelBoundary>
  );
}

function DesignModeGate({ app }: { readonly app: ShellView }) {
  const view = useDesignView();
  const words = useDesignWords();
  const { locale } = useLocale();
  const latest = useRef({ app, words });
  latest.current = { app, words };
  const context = useMemo<DesignOpsContext>(() => ({ app: () => latest.current.app, words: () => latest.current.words }), []);
  // The header button, registered again when the language changes so its name follows it.
  useEffect(
    () =>
      registerPanelMode({
        id: 'design',
        order: MODE_BUTTON_ORDER,
        label: () => designWord(locale, 'mode.name'),
        icon: () => <DesignModeIcon size={16} />,
        isActive: isDesignModeActive,
        setActive: (active) => {
          const { app: current, words: currentWords } = latest.current;
          if (active === 'on') {
            void enterDesignMode(current, currentWords);
          } else if (designView().phase === 'entering') {
            void cancelDesignMode();
          } else {
            void exitDesignMode(current, currentWords, 'keep');
          }
        },
        subscribe: subscribeDesignView,
      }),
    [locale],
  );
  useSessionOnOpen(app.project.path, latest);
  // The preview's name follows the language: the catalog may load after the mode's look is applied.
  const roleName = words('mode.name');
  const on = view.session.kind === 'on';
  const holdReason = words('ai.hold');
  useEffect(() => {
    if (!on) {
      return undefined;
    }
    applyDesignRole(roleName);
    // The agent cannot work on the copy (main refuses it): the AI panel offers nothing it would refuse.
    setAiHold(holdReason);
    return () => setAiHold(undefined);
  }, [on, roleName, holdReason]);
  useReopenedPage(app, view.session);
  useUnselectedFrame(app.selectedId);
  if (view.session.kind !== 'on') {
    return undefined;
  }
  return (
    <>
      <DesignCanvas context={context} session={view.session} />
      <DesignBar app={app} context={context} />
    </>
  );
}

/** An element selected anywhere (the Navigator among them) takes the place of a selected frame. */
function useUnselectedFrame(selectedId: string | undefined): void {
  useEffect(() => {
    if (selectedId !== undefined) {
      updateDesignView((view) => (view.selection.kind === 'frame' ? { ...view, selection: { kind: 'none' } } : view));
    }
  }, [selectedId]);
}

/** On every project open: is this window on a Design mode copy? Then the mode's look; else, a handoff to take. */
function useSessionOnOpen(projectPath: string, latest: { readonly current: { readonly app: DesignHostSource; readonly words: DesignWords } }): void {
  useEffect(() => {
    const lifetime: { state: 'active' | 'disposed' } = { state: 'active' };
    void (async () => {
      const reply = await designSession({ op: 'state' });
      if (lifetime.state === 'disposed' || reply.kind !== 'state') {
        return;
      }
      const { app, words } = latest.current;
      const notice = takeNotice();
      if (reply.state.kind === 'on' && reply.state.liveRoot === projectPath) {
        applyDesignRole(words('mode.name'));
        setInlineDefault('inline');
        // The canvas is up with every frame before the copy's dev server is: each shows its kept document.
        const kept = await designSession({ op: 'frame-snapshots' });
        const snapshots = new Map(kept.kind === 'snapshots' ? kept.snapshots.map((entry) => [entry.frame, entry.snapshot] as const) : []);
        updateDesignView((view) => ({ ...view, snapshots }));
        installState(reply);
        updateDesignView((view) => ({ ...view, phase: 'working' }));
        announceEntered(app, words, reply.state, notice);
        return;
      }
      await announceLeft(app, words, notice);
    })().catch(() => undefined);
    return () => {
      lifetime.state = 'disposed';
      setInlineDefault('selector');
      clearDesignRole();
    };
  }, [projectPath, latest]);
}

function announceEntered(
  app: DesignHostSource,
  words: DesignWords,
  state: Extract<DesignSessionState, { kind: 'on' }>,
  notice: DesignNotice | undefined,
): void {
  if (notice !== 'entered') {
    return;
  }
  app.showToast(words('toast.entered'), 'info');
  if (state.stale) {
    app.showToast(words('toast.stale'), 'warning');
  } else if (state.frames.length > 1 || state.frames.some((frame) => frame.changedFiles > 0)) {
    app.showToast(words('toast.restored'), 'info');
  }
}

async function announceLeft(app: DesignHostSource, words: DesignWords, notice: DesignNotice | undefined): Promise<void> {
  if (notice === 'left') {
    app.showToast(words('toast.left'), 'info');
    return;
  }
  if (notice !== 'sent') {
    return;
  }
  const taken = await designSession({ op: 'take-handoff' });
  if (taken.kind !== 'handoff' || taken.handoff === undefined) {
    app.showToast(words('toast.left'), 'info');
    return;
  }
  app.setLeftTab('ai');
  const drafted = await draftHandoff(app.project.path, taken.handoff);
  app.showToast(words(drafted ? 'toast.sent' : 'toast.chatFailed'), drafted ? 'success' : 'error');
}

function takeNotice(): DesignNotice | undefined {
  try {
    const notice = sessionStorage.getItem(DESIGN_NOTICE_KEY);
    sessionStorage.removeItem(DESIGN_NOTICE_KEY);
    return notice === 'entered' || notice === 'left' || notice === 'sent' ? notice : undefined;
  } catch {
    return undefined;
  }
}

/** The copy opens on its home page; this goes back to the page the person was on, once. */
function useReopenedPage(app: DesignHostSource, session: DesignSessionState): void {
  const done = useRef<string | undefined>(undefined);
  const page = session.kind === 'on' ? session.page : undefined;
  const liveRoot = session.kind === 'on' ? session.liveRoot : undefined;
  const { scan, currentPage, selectPage } = app;
  useEffect(() => {
    if (page === undefined || liveRoot === undefined || done.current === liveRoot || scan === undefined) {
      return;
    }
    done.current = liveRoot;
    const target = scan.pages.find((entry) => entry.name === page);
    if (target !== undefined && currentPage?.name !== page) {
      void selectPage(target).catch(() => undefined);
    }
  }, [page, liveRoot, scan, currentPage, selectPage]);
}
