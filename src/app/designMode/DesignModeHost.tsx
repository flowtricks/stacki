// Design mode (experimental; docs/design-mode/REMOVE.md lists how to take it out): where it meets the app.
//
// The app mounts this once (src/app/shell/AppShell.tsx, one marked line). While mounted it registers the "Design
// mode" row of the AI panel header's Modes menu (src/features/ai/panelModes.ts), which turns every other mode off
// when this one goes on and this one off when another does. While Design mode is on, this
// covers the editor (everything but the AI panel) with the design workspace and keeps the editor from acting:
// the window is held (src/ui/busyLock.ts), so the menu's Undo, Redo, Paste, Insert and Reload do nothing to the
// project; the editor's selection is cleared, so its keyboard shortcuts have nothing to act on; and the keys
// Design mode uses, with the editor's chords that would still act under the cover (designCoveredKeys.ts), are
// taken before the editor's listeners hear them.
//
// What it is handed is a read-only view of the app (DesignHostSource): the open page, its model, the scan, the
// dev server address, the left panel and the toast. No write of the editor is in reach.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ShellView } from '../App';
import { registerPanelMode } from '../../features/ai/panelModes';
import { breakpointLabel } from '../../lib/breakpointLabel';
import { useLocale, useTranslate } from '../../lib/i18n/useTranslate';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import { holdWindow } from '../../ui/busyLock';
import TipAnchor from '../../ui/TipAnchor';
import PanelBoundary from '../../ui/PanelBoundary';
import { DESIGN_MODE_ENABLED } from '../../../shared/designMode/designModeContract';
import type { PageModelView, DesignComponentEntry } from './model/designPrepare';
import type { DesignPage, FrameId } from './model/designTypes';
import { DESIGN_LIMITS } from './model/designTypes';
import {
  addFreshFrame,
  beginLive,
  commitFrame,
  designState,
  duplicateFrame,
  exitDesignMode,
  frameRecord,
  isDesignModeActive,
  redo,
  select,
  setEditingText,
  setTool,
  setView,
  startDesignMode,
  startOver,
  subscribeDesignActive,
  undo,
  useDesignState,
  type StartOutcome,
} from './runtime/designSession';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  hasCopied,
  nudgeSelection,
  pasteInto,
  selectParent,
  toggleHiddenSelection,
} from './runtime/designGestures';
import { reachesCoveredEditor } from './model/designCoveredKeys';
import { captureFrame } from './runtime/designCapture';
import { sendFrameToAi } from './runtime/designHandoff';
import { frameDocument as sessionFrameDocument, serializeFrame } from './runtime/designSession';
import { designWord, useDesignWords, type DesignWords } from './i18n/designWords';
import { DesignActionsContext, type DesignActions, type DesignComponent, type DesignPropField } from './ui/designActions';
import { DesignCanvas } from './ui/DesignCanvas';
import { focusDesignCanvas, keepUnscrolled } from './ui/designPointer';
import { DesignInspector } from './ui/DesignInspector';
import { DesignToolbar } from './ui/DesignToolbar';
import { fitView } from './ui/canvasGeometry';
import { AddIcon, CloseIcon, DesignModeIcon, RedoIcon, ResetIcon, SendIcon, UndoIcon } from './ui/designIcons';
import { pickOnDoubleClick } from './model/designSelect';
import { designIdOf } from './model/designDom';
import './ui/designMode.css';

/** What Design mode reads of the app. Reads only: nothing here writes to the project. */
export type DesignHostSource = Pick<
  ShellView,
  'project' | 'devUrl' | 'pageUrlPath' | 'currentPage' | 'pageState' | 'scan' | 'leftTab' | 'setLeftTab' | 'selectedId' | 'setSelectedId' | 'showToast'
>;

/** Where Design mode sits in the Modes menu: after comment pins (10). */
const MODES_MENU_ORDER = 20;

function pageOf(app: DesignHostSource, words: DesignWords): DesignPage | undefined {
  const current = app.currentPage;
  // The component defaults editor shows a scratch page under .stacki/ (a component on the canvas is no page either):
  // there is no page to copy, and covering the editor would hide its Close button.
  if (current?.path?.includes('/.stacki/') === true) {
    return undefined;
  }
  if (current === undefined || app.pageUrlPath === undefined || current.kind !== 'page') {
    return current?.kind === 'route' ? { projectPath: app.project.path, file: undefined, route: current.route, title: current.name } : undefined;
  }
  return { projectPath: app.project.path, file: current.path, route: app.pageUrlPath, title: frameTitle(current.name, words) };
}

/** The first frame's name: the page file's name without its extension, and "Home" for an index page. */
function frameTitle(name: string, words: DesignWords): string {
  const stem = name.replace(/\.(astro|md|mdx)$/, '');
  return stem === 'index' ? words('frame.home') : stem;
}

function modelOf(app: DesignHostSource): PageModelView | undefined {
  const state = app.pageState;
  return state !== undefined && state.editable ? { model: state.model, text: state.parsedFrom } : undefined;
}

function fieldOf(field: {
  readonly name: string;
  readonly type: string;
  readonly options?: readonly string[];
  readonly default?: string | number | boolean | undefined;
  readonly doc?: string;
}): DesignPropField {
  const options = field.options ?? [];
  const kind =
    options.length > 0 ? 'choice' : field.type === 'boolean' ? 'boolean' : field.type === 'number' ? 'number' : field.type === 'string' ? 'text' : 'other';
  return { name: field.name, kind, options, defaultValue: field.default, doc: field.doc };
}

function componentsOf(app: DesignHostSource): readonly DesignComponent[] {
  // Project-relative files only: what the canvas markers name and what the render route accepts (a package component has none).
  return [...app.scan.components, ...app.scan.layouts].flatMap((component) =>
    component.file === undefined ? [] : [{ name: component.name, path: component.file, fields: (component.schema ?? []).map(fieldOf) }],
  );
}

function entriesOf(components: readonly DesignComponent[]): readonly DesignComponentEntry[] {
  return components.map((component) => ({ name: component.name, path: component.path }));
}

function reportStart(app: DesignHostSource, words: DesignWords, outcome: StartOutcome): void {
  if (outcome === 'no-canvas') {
    app.showToast(words('toast.noCanvas'), 'warning');
  } else if (outcome === 'failed') {
    app.showToast(words('toast.failed'), 'error');
  } else if (outcome === 'restored') {
    app.showToast(words('toast.restored'), 'info');
  }
}

async function enterDesignMode(app: DesignHostSource, words: DesignWords): Promise<void> {
  const page = pageOf(app, words);
  if (page === undefined) {
    app.showToast(words('toast.noCanvas'), 'warning');
    return;
  }
  if (app.leftTab !== 'ai') {
    app.setLeftTab('ai');
  }
  reportStart(app, words, await startDesignMode({ page, model: modelOf(app), components: entriesOf(componentsOf(app)) }));
}

/**
 * The app's one mount of Design mode. Its own error boundary, so a fault in Design mode shows there and never
 * takes the editor down; while Design mode is off it renders nothing and reads nothing.
 */
export function DesignModeHost({ app }: { readonly app: DesignHostSource }) {
  const words = useDesignWords();
  return (
    <PanelBoundary name="Design mode" label={words('mode.name')}>
      <DesignModeGate app={app} />
    </PanelBoundary>
  );
}

function DesignModeGate({ app }: { readonly app: DesignHostSource }) {
  const state = useDesignState();
  const words = useDesignWords();
  const { locale } = useLocale();
  const latest = useRef({ app, words });
  latest.current = { app, words };
  // The Modes menu's row, registered again when the language changes so its name and the button follow it.
  useEffect(() => {
    if (!DESIGN_MODE_ENABLED) {
      return undefined;
    }
    return registerPanelMode({
      id: 'design',
      order: MODES_MENU_ORDER,
      label: () => designWord(locale, 'mode.name'),
      icon: () => <DesignModeIcon size={16} />,
      isActive: isDesignModeActive,
      setActive: (active) => {
        if (active === 'off') {
          void exitDesignMode();
        } else {
          void enterDesignMode(latest.current.app, latest.current.words);
        }
      },
      subscribe: subscribeDesignActive,
    });
  }, [locale]);
  // Leaving the project ends the mode.
  useEffect(() => () => void exitDesignMode(), []);
  return state.phase === 'off' ? undefined : <DesignWorkspace app={app} />;
}

function DesignWorkspace({ app }: { readonly app: DesignHostSource }) {
  const state = useDesignState();
  const words = useDesignWords();
  const translate = useTranslate();
  const { resolved, desktopFramePx } = useProjectBreakpoints(app.project.path);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const components = useMemo(() => componentsOf(app), [app]);
  const entries = useMemo(() => entriesOf(components), [components]);
  const report = (outcome: StartOutcome) => reportStart(app, words, outcome);

  const { selectedId, setSelectedId } = app;
  const active = state.phase !== 'off';
  // While Design mode is on the editor holds still: menu edits do nothing, and nothing is selected for its keys.
  useEffect(() => (active ? holdWindow() : undefined), [active]);
  useEffect(() => {
    if (active && selectedId !== undefined) {
      setSelectedId(undefined);
    }
  }, [active, selectedId, setSelectedId]);

  const canvasBox = useRef<HTMLDivElement>(null);
  const canvasSize = useCallback(() => {
    const box = canvasBox.current?.getBoundingClientRect();
    return { widthPx: box?.width ?? 1000, heightPx: box?.height ?? 700 };
  }, []);
  const fittedOnce = useRef(false);
  useEffect(() => {
    if (state.phase === 'on' && !fittedOnce.current) {
      fittedOnce.current = true;
      const size = canvasSize();
      setView(fitView(designState().frames, size.widthPx, size.heightPx));
    }
    if (state.phase === 'off') {
      fittedOnce.current = false;
    }
  }, [state.phase, canvasSize]);

  const actions: DesignActions = {
    busy,
    components,
    widths: [
      { label: translate('preview.canvas.desktop'), widthPx: desktopFramePx },
      ...resolved.map((breakpoint) => ({ label: breakpointLabel(breakpoint, translate), widthPx: breakpoint.widthPx })),
    ].filter((entry, index, all) => all.findIndex((other) => other.widthPx === entry.widthPx) === index),
    toast: (message, kind) => app.showToast(message, kind),
    freshFrame: () => {
      if (designState().frames.length >= DESIGN_LIMITS.framesMax) {
        app.showToast(words('toast.frameLimit', { count: DESIGN_LIMITS.framesMax }), 'warning');
        return;
      }
      void addFreshFrame({ model: modelOf(app), components: entries }).then((added) => {
        if (added) {
          app.showToast(words('toast.fresh'), 'success');
        }
      });
    },
    sendToAi: (frame) => {
      const page = designState().page;
      const record = frameRecord(frame);
      if (page === undefined || record === undefined) {
        return;
      }
      setBusy(words('frame.sending'));
      void sendFrameToAi(page, record, words('handoff.request'), () => app.setLeftTab('ai'))
        .then((outcome) => {
          if (outcome.kind === 'drafted') {
            app.showToast(words('toast.sent'), 'success');
          } else {
            app.showToast(outcome.reason === 'chat' ? words('toast.chatFailed') : words('toast.captureFailed'), 'error');
          }
        })
        .finally(() => setBusy(undefined));
    },
    copyImage: (frame) => {
      void exportFrame(app.project.path, frame, 'clipboard', words, setBusy).then((done) =>
        app.showToast(done ? words('toast.copied') : words('toast.copyFailed'), done ? 'success' : 'error'),
      );
    },
    exportImage: (frame) => {
      void exportFrame(app.project.path, frame, 'file', words, setBusy).then((done) =>
        app.showToast(done ? words('toast.exported') : words('toast.captureFailed'), done ? 'success' : 'error'),
      );
    },
  };

  const spaceHeld = useDesignKeys({ active }, canvasSize);
  useDesignMenus({ active });
  useTextEditing({ active });
  const left = useWorkspaceLeft({ active, aiDocked: app.leftTab === 'ai' });

  if (!active) {
    return undefined;
  }
  const frameForActions = state.selection?.frame ?? state.frameSelected ?? state.frames[0]?.id;
  return (
    <DesignActionsContext.Provider value={actions}>
      <div className="dm-root" data-design-mode="">
        <div className="titlebar dm-topbar">
          <TipAnchor text={words('mode.badgeTip')}>
            <span className="dm-badge">
              <DesignModeIcon size={16} />
              {words('mode.badge')}
            </span>
          </TipAnchor>
          <span className="dm-page-name">{state.page?.title}</span>
          <span className="spacer" />
          {busy !== undefined && (
            <span className="dm-busy" role="status">
              {busy}
            </span>
          )}
          <TopButton label={words('history.undo')} shortcut="⌘Z" disabled={!state.canUndo} onClick={undo}>
            <UndoIcon size={16} />
          </TopButton>
          <TopButton label={words('history.redo')} shortcut="⇧⌘Z" disabled={!state.canRedo} onClick={redo}>
            <RedoIcon size={16} />
          </TopButton>
          <TopButton label={words('frame.fresh')} tip={words('frame.freshTip')} disabled={state.phase !== 'on'} onClick={actions.freshFrame}>
            <AddIcon size={16} />
          </TopButton>
          <TopButton
            label={words('mode.startOver')}
            tip={words('mode.startOverTip')}
            disabled={state.phase !== 'on'}
            onClick={() => {
              const page = pageOf(app, words);
              if (page !== undefined) {
                fittedOnce.current = false;
                void startOver({ page, model: modelOf(app), components: entries }).then(report);
              }
            }}
          >
            <ResetIcon size={16} />
          </TopButton>
          <TipAnchor text={words('frame.sendToAiTip')}>
            <button
              type="button"
              className="primary dm-send"
              disabled={frameForActions === undefined || busy !== undefined}
              onClick={() => frameForActions !== undefined && actions.sendToAi(frameForActions)}
            >
              <SendIcon size={16} />
              {words('frame.sendToAi')}
            </button>
          </TipAnchor>
          <TipAnchor text={words('mode.exitTip')}>
            <button type="button" className="dm-exit" onClick={() => void exitDesignMode()}>
              <CloseIcon size={16} />
              {words('mode.exit')}
            </button>
          </TipAnchor>
        </div>
        <div className="dm-rail-cover" style={{ width: left.railPx }} />
        <div className="dm-workspace" style={{ insetInlineStart: left.workspacePx }}>
          <div className="dm-canvas-box" ref={canvasBox} onScroll={() => keepUnscrolled(canvasBox.current ?? undefined)}>
            {state.phase === 'starting' ? (
              <div className="dm-starting" role="status" aria-busy="true" aria-label={words('mode.starting')}>
                <div className="dm-starting-frame" />
              </div>
            ) : (
              <DesignCanvas words={words} spaceHeld={spaceHeld} onTextEdit={startTextEdit} />
            )}
            <DesignToolbar words={words} canvasSize={canvasSize} />
          </div>
          <DesignInspector words={words} />
        </div>
      </div>
    </DesignActionsContext.Provider>
  );
}

function TopButton({
  label,
  tip,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly tip?: string;
  readonly shortcut?: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <TipAnchor text={(tip ?? label) + (shortcut === undefined ? '' : ` (${shortcut})`)}>
      <button type="button" className="titlebar-btn" aria-label={label} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    </TipAnchor>
  );
}

async function exportFrame(
  projectPath: string,
  frame: FrameId,
  target: 'clipboard' | 'file',
  words: DesignWords,
  setBusy: (busy: string | undefined) => void,
): Promise<boolean> {
  const record = frameRecord(frame);
  const html = serializeFrame(frame);
  if (record === undefined || html === undefined) {
    return false;
  }
  setBusy(words('frame.capturing'));
  try {
    const capture = await captureFrame(
      projectPath,
      html,
      record.widthPx,
      record.viewportHeightPx,
      target === 'file' ? Math.min(2, window.devicePixelRatio || 1) : 1,
    );
    if (capture === undefined) {
      return false;
    }
    const blob = await new Promise<Blob | undefined>((resolve) => capture.canvas.toBlob((made) => resolve(made ?? undefined), 'image/png'));
    if (blob === undefined) {
      return false;
    }
    if (target === 'clipboard') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      return true;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = record.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    return true;
  } catch (error: unknown) {
    console.warn('[design mode] the image could not be copied or saved:', String(error));
    return false;
  } finally {
    setBusy(undefined);
  }
}

/** Where the workspace starts: right of the AI panel when it is docked open, else right of the rail. */
function useWorkspaceLeft({ active, aiDocked }: { readonly active: boolean; readonly aiDocked: boolean }): {
  readonly railPx: number;
  readonly workspacePx: number;
} {
  const [left, setLeft] = useState({ railPx: 44, workspacePx: 44 });
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const measure = () => {
      const rail = document.querySelector('.main > .rail')?.getBoundingClientRect();
      const center = document.querySelector('.main > .center')?.getBoundingClientRect();
      // Measured from the inline start, as the overlay places itself: the left edge, or the right one in a right-to-left language.
      const rightToLeft = document.documentElement.dir === 'rtl';
      const far = (box: DOMRect): number => (rightToLeft ? window.innerWidth - box.left : box.right);
      const near = (box: DOMRect): number => (rightToLeft ? window.innerWidth - box.right : box.left);
      const railPx = rail === undefined ? 44 : Math.round(far(rail));
      setLeft({ railPx, workspacePx: aiDocked && center !== undefined ? Math.round(near(center)) : railPx });
    };
    measure();
    const observer = new ResizeObserver(measure);
    const main = document.querySelector('.main');
    if (main !== null) {
      observer.observe(main);
      for (const child of main.children) {
        observer.observe(child);
      }
    }
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [active, aiDocked]);
  return left;
}

function editableTarget(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

/** Whether focus is Design mode's own (its canvas, its panels) or nowhere in particular. */
function designHasFocus(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active.closest('[data-design-mode]') !== null;
}

/**
 * Design mode's keys. Taken at the window's capture phase, before the editor's own listeners, and only while
 * focus is Design mode's: a key typed into the AI panel stays the AI panel's.
 */
function useDesignKeys({ active }: { readonly active: boolean }, canvasSize: () => { readonly widthPx: number; readonly heightPx: number }): boolean {
  const [spaceHeld, setSpaceHeld] = useState(false);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      // Wherever focus is, the AI panel included: these would change or open the editor under the cover.
      const target = event.target;
      const inCodeEditor = target instanceof HTMLElement && target.closest('.cm-editor') !== null;
      if (reachesCoveredEditor(event, { typing: editableTarget(target), inCodeEditor })) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (!designHasFocus() || editableTarget(target) || designState().editingText !== undefined) {
        return;
      }
      const handled = handleKey(event, canvasSize);
      if (event.key === ' ' && !event.repeat) {
        setSpaceHeld(true);
      }
      if (handled || event.key === ' ') {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === ' ') {
        setSpaceHeld(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [active, canvasSize]);
  return spaceHeld;
}

function handleKey(event: KeyboardEvent, canvasSize: () => { readonly widthPx: number; readonly heightPx: number }): boolean {
  const state = designState();
  const mod = event.metaKey || event.ctrlKey;
  const step = event.shiftKey ? 10 : 1;
  switch (event.key) {
    case 'Backspace':
    case 'Delete':
      return deleteSelection();
    case 'Escape':
      if (state.selection === undefined) {
        return false;
      }
      selectParent();
      return true;
    case 'Enter': {
      const selected = state.selection;
      if (selected === undefined) {
        return false;
      }
      if (event.shiftKey) {
        return selectParent();
      }
      return diveIn();
    }
    case 'ArrowLeft':
      return nudgeSelection(-step, 0);
    case 'ArrowRight':
      return nudgeSelection(step, 0);
    case 'ArrowUp':
      return nudgeSelection(0, -step);
    case 'ArrowDown':
      return nudgeSelection(0, step);
    default:
      break;
  }
  const letter = event.key.toLowerCase();
  if (mod && letter === 'd') {
    if (state.selection === undefined && state.frameSelected !== undefined) {
      return duplicateFrame(state.frameSelected) !== undefined;
    }
    return duplicateSelection();
  }
  if (mod && event.shiftKey && letter === 'h') {
    return toggleHiddenSelection();
  }
  if (mod && (letter === 'z' || letter === 'y')) {
    // Where the menu does not take ⌘Z first (a menu-less platform build), the key still undoes here.
    if (letter === 'y' || event.shiftKey) {
      redo();
    } else {
      undo();
    }
    return true;
  }
  if (mod && letter === 'c') {
    return copySelection();
  }
  if (mod && letter === 'v') {
    const frame = state.selection?.frame ?? state.frameSelected ?? state.frames[0]?.id;
    return frame !== undefined && pasteInto(frame);
  }
  // Shift+1 by the key's place, whatever character the layout gives it ('!' on US keyboards).
  if (event.shiftKey && !mod && (event.code === 'Digit1' || event.key === '!' || event.key === '1')) {
    const size = canvasSize();
    setView(fitView(state.frames, size.widthPx, size.heightPx));
    return true;
  }
  if (mod && (event.key === '=' || event.key === '+' || event.key === '-' || event.key === '0')) {
    const size = canvasSize();
    const scale = event.key === '0' ? 1 : event.key === '-' ? state.view.scale / 1.25 : state.view.scale * 1.25;
    const clamped = Math.min(DESIGN_LIMITS.zoomMax, Math.max(DESIGN_LIMITS.zoomMin, scale));
    const ratio = clamped / state.view.scale;
    setView({
      xPx: size.widthPx / 2 - (size.widthPx / 2 - state.view.xPx) * ratio,
      yPx: size.heightPx / 2 - (size.heightPx / 2 - state.view.yPx) * ratio,
      scale: clamped,
    });
    return true;
  }
  if (!mod && !event.altKey) {
    const tools = { v: 'move', t: 'text', r: 'box', h: 'hand' } as const;
    if (letter === 'v' || letter === 't' || letter === 'r' || letter === 'h') {
      setTool(tools[letter]);
      return true;
    }
  }
  return false;
}

/** Enter: one level into the selection, toward its first child. */
function diveIn(): boolean {
  const selection = designState().selection;
  const first = selection?.ids[0];
  if (selection === undefined || first === undefined) {
    return false;
  }
  const element = sessionFrameDocument(selection.frame)?.querySelector(`[data-dm-id="${first}"]`);
  const child = element?.firstElementChild;
  if (element === null || element === undefined || child === null || child === undefined) {
    return false;
  }
  const id = designIdOf(pickOnDoubleClick(child, [element]));
  select(id === undefined ? undefined : { frame: selection.frame, ids: [id] });
  return true;
}

/**
 * The application menu's edit commands while Design mode is on. The editor's own handlers do nothing (the window
 * is held); these route each command to the field that has focus, the text being typed in a frame, or Design mode.
 */
function useDesignMenus({ active }: { readonly active: boolean }): void {
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const nativeOrDesign = (command: 'undo' | 'redo', design: () => void) => () => {
      const editing = designState().editingText;
      if (editing !== undefined) {
        sessionFrameDocument(editing.frame)?.execCommand(command);
        return;
      }
      if (editableTarget(document.activeElement)) {
        document.execCommand(command);
        return;
      }
      design();
    };
    const offs = [
      window.avb.onMenu('undo', nativeOrDesign('undo', undo)),
      window.avb.onMenu('redo', nativeOrDesign('redo', redo)),
      window.avb.onMenu('copy', () => {
        if (designHasFocus() && !editableTarget(document.activeElement) && designState().editingText === undefined) {
          copySelection();
        }
      }),
      window.avb.onMenu('paste', () => {
        const editing = designState().editingText;
        if (editing !== undefined || editableTarget(document.activeElement)) {
          const target = editing === undefined ? document : sessionFrameDocument(editing.frame);
          void navigator.clipboard.readText().then((text) => target?.execCommand('insertText', false, text));
          return;
        }
        const state = designState();
        const frame = state.selection?.frame ?? state.frameSelected ?? state.frames[0]?.id;
        if (frame !== undefined && hasCopied()) {
          pasteInto(frame);
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [active]);
}

/** Typing in a frame: the element is editable while `editingText` names it; leaving it is one undo step. */
let editing: { readonly frame: FrameId; readonly element: Element } | undefined;

function startTextEdit(frame: FrameId, element: Element): void {
  finishTextEdit();
  if (!beginLive(frame)) {
    return;
  }
  editing = { frame, element };
  element.setAttribute('contenteditable', 'plaintext-only');
  const id = designIdOf(element);
  if (id === undefined) {
    return;
  }
  setEditingText({ frame, id });
  const view = element.ownerDocument.defaultView;
  // After the press that started the edit has settled its own focus (it focuses the canvas), or the edit would end at once.
  requestAnimationFrame(() => {
    // The element is of the frame's realm, not this window's: its focus method is found, not assumed.
    const focus: unknown = Reflect.get(element, 'focus');
    if (typeof focus === 'function') {
      Reflect.apply(focus, element, []);
    }
    const selection = view?.getSelection();
    selection?.selectAllChildren(element);
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      setEditingText(undefined);
    }
  };
  const owner = element.ownerDocument;
  const onBlur = () => setEditingText(undefined);
  owner.addEventListener('keydown', onKey);
  element.addEventListener('blur', onBlur, { once: true });
  stopListening = () => {
    owner.removeEventListener('keydown', onKey);
    element.removeEventListener('blur', onBlur);
  };
}

let stopListening: () => void = () => undefined;

function finishTextEdit(): void {
  const current = editing;
  editing = undefined;
  stopListening();
  stopListening = () => undefined;
  if (current === undefined) {
    return;
  }
  current.element.removeAttribute('contenteditable');
  focusDesignCanvas();
  current.element.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
  commitFrame(current.frame, () => [current.element]);
}

function useTextEditing({ active }: { readonly active: boolean }): void {
  const state = useDesignState();
  useEffect(() => {
    if (state.editingText === undefined && editing !== undefined) {
      finishTextEdit();
    }
  }, [state.editingText]);
  useEffect(() => {
    if (!active) {
      editing = undefined;
    }
  }, [active]);
}
