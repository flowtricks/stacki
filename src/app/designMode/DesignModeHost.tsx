// Design mode (experimental; docs/design-mode/REMOVE.md lists how to take it out): where it meets the app.
//
// The app mounts this once (src/app/shell/AppShell.tsx, one marked line). It registers the "Design mode" row of the
// AI panel header's Modes menu (src/features/ai/panelModes.ts). Turning it on copies the project into a sandbox in
// main and opens the copy (designActions.ts); from then on the window is the normal editor, every panel working on
// the copy, with three differences this module makes: the bar of frames over the canvas (DesignBar.tsx), the board
// that shows them side by side (DesignBoard.tsx), and the style panel starting each selection on its Inline styles
// chip (src/features/style/model/inlineDefault.ts). What cannot work on a copy is out of reach (designRole.ts), and
// main refuses it anyway (electron/lib/designMode/designFence.ts).
import { useEffect, useRef } from 'react';
import { registerPanelMode } from '../../features/ai/panelModes';
import { setInlineDefault } from '../../features/style/model/inlineDefault';
import { useLocale } from '../../lib/i18n/useTranslate';
import { centralIcon } from '../../ui/central/CentralIcon';
import { canvas } from '../../ui/central/centralGeometry';
import PanelBoundary from '../../ui/PanelBoundary';
import { DESIGN_MODE_ENABLED, type DesignSessionState } from '../../../shared/ipc/designSession';
import { designSession } from './designBridge';
import { DESIGN_NOTICE_KEY, enterDesignMode, exitDesignMode, installReply, type DesignHostSource, type DesignNotice } from './designActions';
import { draftHandoff } from './designHandoff';
import { applyDesignRole, clearDesignRole } from './designRole';
import { isDesignModeActive, subscribeDesignView, updateDesignView, useDesignView } from './designStore';
import { DesignBar } from './DesignBar';
import { DesignBoard } from './DesignBoard';
import { designWord, useDesignWords, type DesignWords } from './i18n/designWords';
import './designMode.css';

export const DesignModeIcon = centralIcon(canvas);

/** Where Design mode sits in the Modes menu: after comment pins (10). */
const MODES_MENU_ORDER = 20;

export function DesignModeHost({ app }: { readonly app: DesignHostSource }) {
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

function DesignModeGate({ app }: { readonly app: DesignHostSource }) {
  const view = useDesignView();
  const words = useDesignWords();
  const { locale } = useLocale();
  const latest = useRef({ app, words });
  latest.current = { app, words };
  // The Modes menu's row, registered again when the language changes so its name follows it.
  useEffect(
    () =>
      registerPanelMode({
        id: 'design',
        order: MODES_MENU_ORDER,
        label: () => designWord(locale, 'mode.name'),
        icon: () => <DesignModeIcon size={16} />,
        isActive: isDesignModeActive,
        setActive: (active) => {
          const { app: current, words: currentWords } = latest.current;
          void (active === 'on' ? enterDesignMode(current, currentWords) : exitDesignMode(current, currentWords, 'keep'));
        },
        subscribe: subscribeDesignView,
      }),
    [locale],
  );
  useSessionOnOpen(app.project.path, latest);
  useReopenedPage(app, view.session);
  if (view.session.kind !== 'on') {
    return undefined;
  }
  return (
    <>
      <DesignBar app={app} session={view.session} phase={view.phase} />
      {view.board === 'open' && <DesignBoard app={app} session={view.session} images={view.images} />}
    </>
  );
}

/** On every project open: is this window on a Design mode copy? Then the mode's look; else, a handoff to take. */
function useSessionOnOpen(projectPath: string, latest: { readonly current: { readonly app: DesignHostSource; readonly words: DesignWords } }): void {
  useEffect(() => {
    const lifetime: { value: 'active' | 'disposed' } = { value: 'active' };
    void (async () => {
      const reply = await designSession({ op: 'state' });
      if (lifetime.value === 'disposed' || reply.kind !== 'state') {
        return;
      }
      const { app, words } = latest.current;
      const notice = takeNotice();
      if (reply.state.kind === 'on' && reply.state.liveRoot === projectPath) {
        applyDesignRole(words('mode.name'));
        setInlineDefault('inline');
        installReply(reply);
        installReply(await designSession({ op: 'frame-images' }));
        updateDesignView((view) => ({ ...view, phase: 'working' }));
        announceEntered(app, words, reply.state, notice);
        return;
      }
      await announceLeft(app, words, notice);
    })().catch(() => undefined);
    return () => {
      lifetime.value = 'disposed';
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
