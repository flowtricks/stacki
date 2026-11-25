// A frame's title row above it on the canvas, drawn at screen size whatever the zoom: its name (double-click
// to rename, drag to move the frame), its width, "Original" (hold to see the page as copied) and its menu.
import { capturePointer } from './designPointer';
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import TipAnchor from '../../../ui/TipAnchor';
import type { DesignFrameRecord } from '../model/designTypes';
import { DESIGN_LIMITS } from '../model/designTypes';
import { arrangeFrames, deleteFrame, designState, duplicateFrame, resetFrame, selectFrame, setPeek, setView, updateFrame } from '../runtime/designSession';
import type { DesignWords } from '../i18n/designWords';
import { useDesignActions } from './designActions';
import { ChevronIcon, CopyIcon, DeleteIcon, ExportIcon, MoreIcon, ResetIcon, SendIcon, ShowIcon } from './designIcons';

const HEADER_HEIGHT_PX = 28;

export function DesignFrameHeader({
  frame,
  scale,
  words,
  selected,
}: {
  readonly frame: DesignFrameRecord;
  readonly scale: number;
  readonly words: DesignWords;
  readonly selected: boolean;
}) {
  const actions = useDesignActions();
  const menu = useMenuTrigger();
  const widthMenu = useMenuTrigger();
  const [renaming, setRenaming] = useState(false);
  const drag = useRef<{ readonly x: number; readonly y: number; readonly frameX: number; readonly frameY: number; moved: boolean } | undefined>(undefined);
  const order = designState().frames.map((candidate) => candidate.id);
  const index = order.indexOf(frame.id);
  const move = (delta: number) => {
    const next = [...order];
    const [taken] = next.splice(index, 1);
    if (taken !== undefined) {
      next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, taken);
      arrangeFrames(next);
    }
  };
  const entries: MenuEntry[] = [
    {
      kind: 'item',
      id: 'send',
      label: words('frame.sendToAi'),
      icon: <SendIcon size={16} />,
      tooltip: words('frame.sendToAiTip'),
      onSelect: () => actions.sendToAi(frame.id),
    },
    { kind: 'item', id: 'copy-image', label: words('frame.copyImage'), icon: <CopyIcon size={16} />, onSelect: () => actions.copyImage(frame.id) },
    { kind: 'item', id: 'export', label: words('frame.exportImage'), icon: <ExportIcon size={16} />, onSelect: () => actions.exportImage(frame.id) },
    { kind: 'divider', id: 'd1' },
    { kind: 'item', id: 'duplicate', label: words('frame.duplicate'), shortcut: '⌘D', onSelect: () => duplicateFrame(frame.id) },
    { kind: 'item', id: 'rename', label: words('frame.rename'), onSelect: () => setRenaming(true) },
    { kind: 'item', id: 'left', label: words('frame.moveLeft'), disabled: index <= 0, onSelect: () => move(-1) },
    { kind: 'item', id: 'right', label: words('frame.moveRight'), disabled: index >= order.length - 1, onSelect: () => move(1) },
    {
      kind: 'item',
      id: 'reset',
      label: words('frame.reset'),
      icon: <ResetIcon size={16} />,
      tooltip: words('frame.resetTip'),
      onSelect: () => void resetFrame(frame.id),
    },
    { kind: 'divider', id: 'd2' },
    {
      kind: 'item',
      id: 'delete',
      label: words('frame.delete'),
      icon: <DeleteIcon size={16} />,
      danger: true,
      disabled: order.length <= 1,
      onSelect: () => deleteFrame(frame.id),
    },
  ];
  const widthEntries: MenuEntry[] = actions.widths.map((width) => ({
    kind: 'item',
    id: 'w' + String(width.widthPx),
    label: width.label,
    description: String(width.widthPx) + 'px',
    checked: width.widthPx === frame.widthPx,
    onSelect: () => updateFrame(frame.id, { widthPx: width.widthPx }),
  }));
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    selectFrame(frame.id);
    if (event.button !== 0 || renaming) {
      return;
    }
    capturePointer(event.currentTarget, event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, frameX: frame.xPx, frameY: frame.yPx, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (active === undefined) {
      return;
    }
    const dx = (event.clientX - active.x) / scale;
    const dy = (event.clientY - active.y) / scale;
    if (!active.moved && Math.hypot(dx * scale, dy * scale) < 3) {
      return;
    }
    active.moved = true;
    const element = event.currentTarget.parentElement;
    if (element !== null) {
      element.style.left = String(active.frameX + dx) + 'px';
      element.style.top = String(active.frameY + dy) + 'px';
    }
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    drag.current = undefined;
    if (active?.moved === true) {
      updateFrame(frame.id, {
        xPx: Math.round(active.frameX + (event.clientX - active.x) / scale),
        yPx: Math.round(active.frameY + (event.clientY - active.y) / scale),
      });
    }
  };
  return (
    <div
      className={`dm-frame-header${selected ? ' is-selected' : ''}`}
      style={{ width: frame.widthPx * scale, top: -HEADER_HEIGHT_PX / scale, transform: `scale(${String(1 / scale)})` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setRenaming(true);
      }}
    >
      {renaming ? (
        <input
          className="dm-frame-rename"
          aria-label={words('frame.nameLabel')}
          defaultValue={frame.name}
          maxLength={DESIGN_LIMITS.frameNameCharsMax}
          autoFocus
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              setRenaming(false);
            }
          }}
          onBlur={(event) => {
            setRenaming(false);
            const name = event.currentTarget.value.trim();
            if (name !== '' && name !== frame.name) {
              updateFrame(frame.id, { name });
            }
          }}
        />
      ) : (
        <span className="dm-frame-name">{frame.name}</span>
      )}
      <button
        type="button"
        ref={widthMenu.ref}
        className="dm-frame-chip"
        aria-label={words('frame.width')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={widthMenu.toggle}
      >
        {String(frame.widthPx)}
        <ChevronIcon size={12} />
      </button>
      <span className="dm-frame-header-space" />
      <TipAnchor text={words('frame.originalTip')}>
        <button
          type="button"
          className="dm-frame-icon"
          aria-label={words('frame.original')}
          onPointerDown={(event) => {
            event.stopPropagation();
            setPeek(frame.id);
            const release = () => {
              setPeek(undefined);
              window.removeEventListener('pointerup', release);
              window.removeEventListener('pointercancel', release);
            };
            window.addEventListener('pointerup', release);
            window.addEventListener('pointercancel', release);
          }}
        >
          <ShowIcon size={16} />
          <span>{words('frame.original')}</span>
        </button>
      </TipAnchor>
      <button
        type="button"
        ref={menu.ref}
        className="dm-frame-icon"
        aria-label={words('frame.menu')}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={menu.toggle}
      >
        <MoreIcon size={16} />
      </button>
      <Menu open={menu.open} anchor={menu.anchor} entries={entries} label={words('frame.menu')} placement="below-end" widthPxMin={220} onClose={menu.close} />
      <Menu
        open={widthMenu.open}
        anchor={widthMenu.anchor}
        entries={widthEntries}
        label={words('frame.width')}
        placement="below-start"
        widthPxMin={200}
        onClose={widthMenu.close}
      />
    </div>
  );
}

/** Centres the view on a frame's top at the current zoom (the frames menu of the top bar). */
export function revealFrame(frame: DesignFrameRecord, canvasWidthPx: number): void {
  const view = designState().view;
  setView({ ...view, xPx: canvasWidthPx / 2 - (frame.xPx + frame.widthPx / 2) * view.scale, yPx: 70 - frame.yPx * view.scale });
}
