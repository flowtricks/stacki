// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the canvas, Design mode's only view.
//
// A pan and zoom canvas over the editor's preview, holding every frame as a live document. The editor's own preview
// keeps rendering the site's copy underneath: it is what the shown frame is pictured from. The left rail, the
// Navigator and the Style and Settings panels are the editor's own, and follow what is selected here.
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import Menu from '../../ui/Menu';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import type { DesignFrameId } from '../../../shared/ipc/designSession';
import type { DesignNodeAt } from '../../../shared/ipc/designSnapshot';
import { DesignFrameTile, EMPTY_FRAME, type DesignTileProps } from './DesignFrameTile';
import { fitCamera, zoomAt } from './designCamera';
import { noteCanvasChange, reportCaptureRefusals } from './designCaptureQueue';
import { exitDesignMode } from './designActions';
import { watchLiveCanvas, watchLivePreviews } from './designLiveCanvas';
import { applyLiveReport } from './designLiveApply';
import {
  duplicateFrame,
  mayDuplicate,
  placeBeside,
  removeFrame,
  renameFrame,
  selectElement,
  selectFrame,
  type DesignOpsContext,
  type OnSession,
} from './designFrameOps';
import { offersUnlink, unlinkPicked } from './designUnlink';
import type { MenuEntry } from '../../ui/Menu';
import { designView, framePicture, updateDesignView, useDesignView, type DesignView } from './designStore';
import { nodeUnder, tileAt, useDesignGestures, type DesignDrag, type DesignHover } from './useDesignGestures';
import { useDesignKeys } from './useDesignKeys';
import { useCanvasColumn } from './useCanvasColumn';
import { useDesignWords } from './i18n/designWords';

interface ContextTarget {
  readonly frame: DesignFrameId;
  readonly x: number;
  readonly y: number;
  /** A component instance right-clicked in the shown frame, which the menu offers to unlink. */
  readonly instance: DesignNodeAt | undefined;
}

/** A wheel step with ⌘ or Ctrl (a pinch is one) zooms by this much per pixel. */
const ZOOM_PER_PX = 1 / 300;

export function DesignCanvas({ context, session }: { readonly context: DesignOpsContext; readonly session: OnSession }) {
  const words = useDesignWords();
  const view = useDesignView();
  // With the pointer button on, the preview itself is shown: the shown frame live, links and scripts working.
  const area = useCanvasColumn('.main > .center .preview-frame-wrap:not([data-canvas-interactive="true"])');
  const plane = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<ContextTarget | undefined>(undefined);
  const [renaming, setRenaming] = useState<DesignFrameId | undefined>(undefined);
  const fit = useCallback(() => {
    const current = designView();
    const element = plane.current;
    if (current.session.kind !== 'on' || element === null || element.clientWidth === 0) {
      return;
    }
    const boxes = current.session.frames.map((frame) => ({
      at: frame.at,
      widthPx: current.snapshots.get(frame.id)?.viewportWidthPx ?? EMPTY_FRAME.widthPx,
    }));
    updateDesignView((next) => ({ ...next, camera: fitCamera(boxes, element.clientWidth, element.clientHeight) }));
  }, []);
  const space = useDesignKeys(context, plane, fit);
  const gestures = useDesignGestures(context, plane, space);
  useLiveCanvas(context);
  // A picture taken while the preview itself was shown was taken without walking the page: it is taken again.
  useEffect(() => {
    if (area.visible) {
      noteCanvasChange();
    }
  }, [area.visible]);
  useEffect(() => {
    if (view.camera === undefined) {
      fit();
    }
  }, [view.camera, area.visible, fit]);
  // Fitted again once the frames' real widths are known.
  const sized = view.snapshots.size > 0;
  useEffect(() => {
    if (sized) {
      fit();
    }
  }, [sized, fit]);
  useWheel(plane);
  const openMenu = (event: MouseEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const tile = tileAt(event.target);
    if (tile === undefined) {
      return;
    }
    // A component in the shown frame is picked, as a click would, and its menu offers to unlink it. Anywhere else
    // (another frame, whose page the panels have not read, or an element that is no instance) picks the frame.
    const node =
      tile.part === 'body' && tile.frame === session.active && designView().switching === undefined ? nodeUnder(tile, event.clientX, event.clientY) : undefined;
    const instance = node !== undefined && offersUnlink(context.app(), node.path) ? node : undefined;
    if (instance === undefined) {
      selectFrame(context, tile.frame);
    } else {
      selectElement(context, tile.frame, instance.path, instance.copy);
    }
    setMenu({ frame: tile.frame, x: event.clientX, y: event.clientY, instance });
  };
  const camera = view.camera ?? { x: 0, y: 0, zoom: 1 };
  return (
    <div
      className={view.photo === undefined ? 'dm-canvas' : 'dm-canvas is-photo'}
      data-design-mode=""
      style={{ ...area.style, display: area.visible ? 'block' : 'none' }}
    >
      <div
        ref={plane}
        className="dm-plane"
        dir="ltr"
        tabIndex={-1}
        role="application"
        aria-label={words('board.title')}
        onContextMenu={openMenu}
        {...gestures.handlers}
      >
        <div className="dm-world" style={{ transform: `translate(${String(camera.x)}px, ${String(camera.y)}px) scale(${String(camera.zoom)})` }}>
          {tilesOf(session, view, gestures.drag, gestures.hover, context).map((tile) => (
            <DesignFrameTile
              key={tile.frame.id}
              {...tile}
              zoom={camera.zoom}
              renaming={renaming === tile.frame.id}
              onRename={() => setRenaming(tile.frame.id)}
              onRenamed={(name) => {
                setRenaming(undefined);
                if (name !== undefined) {
                  renameFrame(context, tile.frame.id, name);
                }
                plane.current?.focus({ preventScroll: true });
              }}
            />
          ))}
        </div>
      </div>
      {menu !== undefined && (
        <FrameMenu
          context={context}
          session={session}
          target={menu}
          onRename={() => setRenaming(menu.frame)}
          onSend={(frame) => void exitDesignMode(context.app(), context.words(), 'send', frame)}
          onClose={() => {
            setMenu(undefined);
            plane.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

type TileData = Omit<DesignTileProps, 'zoom' | 'renaming' | 'onRename' | 'onRenamed'>;

/** Each frame as it is drawn, and the copy being dragged out of one, under the id it will keep. */
function tilesOf(
  session: OnSession,
  view: DesignView,
  drag: DesignDrag | undefined,
  hover: DesignHover | undefined,
  context: DesignOpsContext,
): readonly TileData[] {
  const picked = pickedNode(session, view, context);
  const selected = view.selection.kind === 'frame' ? view.selection.frame : undefined;
  const tiles: TileData[] = session.frames.map((frame) => ({
    frame,
    at: drag?.kind === 'move' && drag.frame === frame.id ? drag.at : frame.at,
    snapshot: framePicture(view, session.frames, frame),
    mark: selected === frame.id ? 'selected' : (view.switching ?? session.active) === frame.id ? 'active' : 'none',
    hover: hover?.frame === frame.id ? hover.node : undefined,
    picked: picked?.frame === frame.id ? picked.node : undefined,
    hidden: view.photo !== undefined && view.photo !== frame.id,
    guides: drag?.kind === 'element' && drag.frame === frame.id ? drag.pull.guides : [],
    size: drag?.kind === 'element' && drag.frame === frame.id ? drag.pull.size : undefined,
  }));
  if (drag?.kind === 'copy') {
    const source = session.frames.find((frame) => frame.id === drag.source);
    if (source !== undefined) {
      const name = context.words()('frame.copy', { name: source.name });
      const frame = { ...source, id: drag.id, name, at: drag.at };
      tiles.push({
        frame,
        at: drag.at,
        snapshot: framePicture(view, session.frames, source),
        mark: 'selected',
        hover: undefined,
        picked: undefined,
        ghost: true,
      });
    }
  }
  // In id order, so a frame's document is never moved in the page, which would load it again.
  return tiles.sort((left, right) => Number(left.frame.id.slice(1)) - Number(right.frame.id.slice(1)));
}

/** The element outline: what the panels have selected in the shown frame, or the pick on its way to them. */
function pickedNode(session: OnSession, view: DesignView, context: DesignOpsContext): DesignHover | undefined {
  const selection = view.selection;
  if (selection.kind === 'frame') {
    return undefined;
  }
  const app = context.app();
  const path = view.switching === undefined ? app.pathFor(app.selectedId) : undefined;
  if (path === undefined) {
    // Only while the pick is on its way: once the panels have it, their selection is the outline.
    const pending = view.switching !== undefined || (selection.kind === 'element' && selection.frame !== session.active);
    return pending && selection.kind === 'element' ? { frame: selection.frame, node: { path: selection.path, copy: selection.copy } } : undefined;
  }
  const node: DesignNodeAt = { path, copy: selection.kind === 'element' && selection.path === path ? selection.copy : 0 };
  return { frame: session.active, node };
}

/** Pictures the shown frame again whenever the live canvas, or the file the panels edit, changes. */
function useLiveCanvas(context: DesignOpsContext): void {
  const words = useDesignWords();
  const app = context.app();
  const source = app.pageState?.source;
  const scope = `${app.editedRel ?? ''}|${app.focusPath ?? ''}|${app.currentPage?.path ?? ''}|${app.pageUrlPath ?? ''}`;
  // What was picked on the page before is not on this one.
  const pageKey = `${app.currentPage?.path ?? ''}|${app.pageUrlPath ?? ''}`;
  useEffect(() => {
    updateDesignView((view) => (view.selection.kind === 'element' ? { ...view, selection: { kind: 'none' } } : view));
  }, [pageKey]);
  useEffect(() => watchLiveCanvas(noteCanvasChange), []);
  // A panel's live preview restyles the shown frame in place.
  useEffect(
    () =>
      watchLivePreviews((message) => {
        const view = designView();
        if (view.session.kind !== 'on' || view.switching !== undefined || view.returning === 'returning') {
          return;
        }
        const shown = document.querySelectorAll<HTMLIFrameElement>(`.dm-tile[data-dm-tile="${view.session.active}"] .dm-document`);
        for (const frame of shown) {
          if (frame.contentDocument !== null) {
            applyLiveReport(frame.contentDocument, message);
          }
        }
        // The outlines are measured again where the restyling moved things.
        updateDesignView((current) => ({ ...current, liveRevision: current.liveRevision + 1 }));
      }),
    [],
  );
  useEffect(() => noteCanvasChange(), [source, scope, app.devStatus]);
  const told = useRef(false);
  useEffect(() => {
    reportCaptureRefusals((failure) => {
      if ((failure === 'too-many-elements' || failure === 'too-large') && !told.current) {
        told.current = true;
        context.app().showToast(words('toast.pageTooLarge'), 'warning');
      }
    });
    return () => reportCaptureRefusals(undefined);
  }, [context, words]);
}

/** Wheel and two-finger scroll pan; with ⌘ or Ctrl, which a pinch sends, they zoom about the pointer. */
function useWheel(plane: React.RefObject<HTMLDivElement>): void {
  useEffect(() => {
    const element = plane.current;
    if (element === null) {
      return undefined;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      updateDesignView((view) => {
        const camera = view.camera;
        if (camera === undefined) {
          return view;
        }
        const next =
          event.ctrlKey || event.metaKey
            ? zoomAt(camera, camera.zoom * Math.exp(-event.deltaY * ZOOM_PER_PX), event.clientX - box.left, event.clientY - box.top)
            : { ...camera, x: camera.x - event.deltaX, y: camera.y - event.deltaY };
        return { ...view, camera: next };
      });
    };
    // Not passive: the window must not scroll or zoom itself under the canvas.
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [plane]);
}

function FrameMenu({
  context,
  session,
  target,
  onRename,
  onSend,
  onClose,
}: {
  readonly context: DesignOpsContext;
  readonly session: OnSession;
  readonly target: ContextTarget;
  readonly onRename: () => void;
  readonly onSend: (frame: DesignFrameId) => void;
  readonly onClose: () => void;
}) {
  const words = useDesignWords();
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const widthPx = designView().snapshots.get(target.frame)?.viewportWidthPx ?? EMPTY_FRAME.widthPx;
  return (
    <>
      <span ref={(element) => setAnchor(element ?? undefined)} className="dm-menu-anchor" style={{ left: target.x, top: target.y }} />
      <Menu
        open={anchor !== undefined}
        anchor={anchor}
        label={words('menu.label')}
        onClose={onClose}
        placement="below-start"
        entries={[
          ...unlinkEntries(context, target),
          {
            kind: 'item',
            id: 'duplicate',
            label: words('menu.duplicate'),
            shortcut: shortcutLabel('D', 'primary', currentDesktopPlatform()),
            onSelect: () => {
              if (mayDuplicate(context)) {
                duplicateFrame(context, target.frame, placeBeside(session, target.frame, widthPx));
              }
            },
          },
          { kind: 'item', id: 'rename', label: words('frame.rename'), onSelect: onRename },
          { kind: 'item', id: 'send', label: words('bar.send'), onSelect: () => onSend(target.frame) },
          {
            kind: 'item',
            id: 'delete',
            label: words('frame.delete'),
            shortcut: currentDesktopPlatform() === 'darwin' ? '⌫' : 'Del',
            danger: true,
            disabled: session.frames.length <= 1,
            onSelect: () => removeFrame(context, target.frame),
          },
        ]}
      />
    </>
  );
}

/** "Unlink component" first, for a right-clicked instance, set off from the frame's own rows. */
function unlinkEntries(context: DesignOpsContext, target: ContextTarget): readonly MenuEntry[] {
  const instance = target.instance;
  if (instance === undefined) {
    return [];
  }
  return [
    { kind: 'item', id: 'unlink', label: context.words()('menu.unlink'), onSelect: () => void unlinkPicked(context, target.frame, instance) },
    { kind: 'divider', id: 'unlink-divider' },
  ];
}
