// The shared Menu: a rounded popover of rows, the way the model, effort, mode and chat menus
// of the AI panel are drawn. It is generic: it knows rows, not what they choose.
//
// A row is an item (title, optional muted description, optional "Recommended" style pill,
// a number or key at the end, a blue check on the chosen one), a submenu (current value and
// a chevron that opens a menu to the side), a toggle (a switch at the end) or, between
// them, a heading, a muted note or a divider. `menuModel.ts` holds the row types and the
// keyboard model; this file draws them.
//
// Keyboard: Up/Down/Home/End move, Right opens a submenu and Left closes it, Enter/Space
// choose, a digit chooses the row with that `numberKey`, a letter chooses the row with that
// `accelerator`, Escape closes the topmost menu (the popup does that itself, so a submenu
// closes before the menu that owns it). Focus is real focus on the row buttons, so a screen
// reader hears the row, its description and whether it is checked.
//
// Pointer: hovering a row focuses it; hovering a submenu row opens it after a short
// delay and hovering another row closes it after one, so a pointer crossing the corner on
// its way to the submenu does not lose it. The check ends the row, so icons line up on the left.
//
// Usage: keep `open` and the anchor in the caller (useMenuTrigger does both) and pass the rows.
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefCallback } from 'react';
import { assert } from '../../shared/core/assert';
import Popup from './Popup';
import { CheckIcon, ChevronRightIcon } from './Icons';
import { centralIcon } from './central/CentralIcon';
import { info as centralInfo } from './central/centralGeometry';
import { assertMenuEntries, decideKey, initialIndex, isMenuRow, isNavigable, placeInfoTip, placeMenu } from './menuModel';
import { useDelayedPlacement } from './delayedTooltip';
import type { InfoTipPlacement, MenuEntry, MenuPlacement, MenuPosition, MenuRow } from './menuModel';
import './menu.css';

export type { MenuEntry, MenuItem, MenuSubmenu, MenuToggle, MenuHeading, MenuNote, MenuDivider, MenuPlacement } from './menuModel';

const InfoIcon = centralIcon(centralInfo, 12);

export interface MenuProps {
  readonly open: boolean;
  /** The element the menu opens from; it also gets focus back when the menu closes. */
  readonly anchor: HTMLElement | undefined;
  readonly entries: readonly MenuEntry[];
  /** The menu's accessible name. */
  readonly label: string;
  readonly onClose: () => void;
  readonly placement?: MenuPlacement;
  /** The narrowest the menu may be, in pixels. */
  readonly widthPxMin?: number;
  readonly className?: string;
}

export default function Menu(props: MenuProps) {
  assertMenuEntries(props.entries);
  return (
    <MenuLayer
      open={props.open}
      anchor={props.anchor}
      entries={props.entries}
      label={props.label}
      placement={props.placement ?? 'below-start'}
      widthPxMin={props.widthPxMin ?? MENU_WIDTH_PX_MIN}
      className={props.className ?? ''}
      autoFocus
      onDismiss={props.onClose}
      closeAll={undefined}
      onCloseSelf={undefined}
      onPointerInside={undefined}
    />
  );
}

/** The open state and the anchor a button needs to drive a Menu. */
export function useMenuTrigger() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  const ref = useCallback<RefCallback<HTMLElement>>((element) => setAnchor(element ?? undefined), []);
  return { open, anchor, ref, toggle, close };
}

const MENU_WIDTH_PX_MIN = 220;
const SUBMENU_WIDTH_PX_MIN = 240;
// How long the pointer must rest on a submenu row before it opens, and how long it may sit on
// another row before the open one closes; long enough to cross a corner, short enough to feel direct.
const SUBMENU_OPEN_DELAY_MS = 120;
const SUBMENU_CLOSE_DELAY_MS = 160;

interface LayerProps {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  readonly entries: readonly MenuEntry[];
  readonly label: string;
  readonly placement: MenuPlacement;
  readonly widthPxMin: number;
  readonly className: string;
  readonly autoFocus: boolean;
  /** Called after the popup has finished closing itself (an outside press, Escape). */
  readonly onDismiss: () => void;
  /** Closes the whole tree; absent on the root, which closes itself. */
  readonly closeAll: (() => void) | undefined;
  /** Present on a submenu: closes just this layer and returns focus to its row. */
  readonly onCloseSelf: (() => void) | undefined;
  /** The pointer is inside this layer (a submenu cancels its parent's pending close). */
  readonly onPointerInside: (() => void) | undefined;
}

function MenuLayer(props: LayerProps) {
  const [surface, setSurface] = useState<HTMLDivElement | undefined>(undefined);
  const [position, setPosition] = useState<MenuPosition | undefined>(undefined);
  const estimate = useRef<MenuPosition | undefined>(undefined);
  // Stable, so the ref is not detached and re-attached (and the state set twice) on every render.
  const attachSurface = useCallback<RefCallback<HTMLDivElement>>((element) => setSurface(element ?? undefined), []);
  useMenuPlacement({ surface, anchor: props.anchor, placement: props.placement, open: props.open, setPosition });
  const widthPx = Math.max(props.widthPxMin, 0);
  if (estimate.current === undefined && props.anchor) {
    estimate.current = placeMenu(boxOf(props.anchor), { width: widthPx, height: estimateHeightPx(props.entries) }, windowSize(), props.placement);
  }
  const shown = position ?? estimate.current;
  const style: CSSProperties = {
    position: 'fixed',
    left: shown?.left ?? 0,
    top: shown?.top ?? 0,
    minWidth: widthPx,
    ...(shown?.heightMax === undefined ? {} : { maxHeight: shown.heightMax, overflowY: 'auto' }),
  };
  return (
    <Popup
      mode="popover"
      open={props.open}
      anchor={props.anchor}
      onClose={props.onDismiss}
      ref={attachSurface}
      className={`menu-surface ${props.className}`}
      role="menu"
      label={props.label}
      style={style}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseEnter={props.onPointerInside}
    >
      {(actions) => (
        <MenuRows
          entries={props.entries}
          autoFocus={props.autoFocus}
          closeAll={props.closeAll ?? (() => actions.finish(props.onDismiss))}
          onCloseSelf={props.onCloseSelf}
        />
      )}
    </Popup>
  );
}

interface PlacementInput {
  readonly surface: HTMLDivElement | undefined;
  readonly anchor: HTMLElement | undefined;
  readonly placement: MenuPlacement;
  readonly open: boolean;
  readonly setPosition: (position: MenuPosition) => void;
}

// The menu's real size is only known once it is drawn; measuring in a layout effect
// corrects the estimate before the browser paints, so nothing visibly jumps.
function useMenuPlacement({ surface, anchor, placement, open, setPosition }: PlacementInput): void {
  useLayoutEffect(() => {
    if (!open || surface === undefined || anchor === undefined) {
      return;
    }
    const rectangle = surface.getBoundingClientRect();
    if (rectangle.width > 0 && rectangle.height > 0) {
      // A menu that scrolls was capped to the window: its natural height is its content's.
      const height = Math.max(rectangle.height, surface.scrollHeight);
      setPosition(placeMenu(boxOf(anchor), { width: rectangle.width, height }, windowSize(), placement));
    }
  }, [surface, anchor, placement, open, setPosition]);
}

function boxOf(element: HTMLElement) {
  const rectangle = element.getBoundingClientRect();
  return { left: rectangle.left, top: rectangle.top, width: rectangle.width, height: rectangle.height };
}

function windowSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

const ROW_PX = 34;
const ROW_DESCRIPTION_PX = 17;
function estimateHeightPx(entries: readonly MenuEntry[]): number {
  let total = 12;
  for (const entry of entries) {
    switch (entry.kind) {
      case 'heading':
        total += 26;
        break;
      case 'note':
        total += 54;
        break;
      case 'divider':
        total += 9;
        break;
      case 'item':
      case 'submenu':
      case 'toggle':
        total += ROW_PX + (entry.description === undefined ? 0 : ROW_DESCRIPTION_PX);
        break;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }
  return total;
}

interface OpenSubmenu {
  readonly index: number;
  /** Whether focus moves into the submenu (opened by key or click) or stays on its row (opened by hover). */
  readonly focusInto: boolean;
}
interface RowsProps {
  readonly entries: readonly MenuEntry[];
  readonly autoFocus: boolean;
  readonly closeAll: () => void;
  readonly onCloseSelf: (() => void) | undefined;
}

function MenuRows({ entries, autoFocus, closeAll, onCloseSelf }: RowsProps) {
  const rowRefs = useRef<(HTMLButtonElement | undefined)[]>([]);
  const [submenu, setSubmenu] = useState<OpenSubmenu | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hasChecks = entries.some((entry) => entry.kind === 'item' && entry.checked !== undefined);
  const hasIcons = entries.some((entry) => isMenuRow(entry) && entry.icon !== undefined);
  const focusRow = useCallback((index: number | undefined) => {
    if (index !== undefined) {
      rowRefs.current[index]?.focus({ preventScroll: true });
    }
  }, []);
  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);
  useLayoutEffect(() => {
    if (autoFocus) {
      focusRow(initialIndex(entries));
    }
    return clearTimer;
    // Focus is taken once, when the layer opens; later entry changes must not steal it back.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus is taken once, on open, by design
  }, []);
  const closeSubmenu = useCallback(
    (restoreFocusTo: number | undefined) => {
      clearTimer();
      setSubmenu(undefined);
      focusRow(restoreFocusTo);
    },
    [clearTimer, focusRow],
  );
  const choose = (entry: MenuRow, index: number): void => {
    if (entry.kind === 'submenu') {
      clearTimer();
      setSubmenu({ index, focusInto: true });
    } else if (entry.kind === 'toggle') {
      entry.onChange(!entry.on);
    } else {
      entry.onSelect();
      if (entry.keepOpen !== true) {
        closeAll();
      }
    }
  };
  const hover = (entry: MenuRow, index: number): void => {
    clearTimer();
    if (isNavigable(entry)) {
      focusRow(index);
    }
    if (entry.kind === 'submenu' && entry.disabled !== true) {
      if (submenu?.index !== index) {
        timer.current = setTimeout(() => setSubmenu({ index, focusInto: false }), SUBMENU_OPEN_DELAY_MS);
      }
    } else if (submenu !== undefined) {
      timer.current = setTimeout(() => setSubmenu(undefined), SUBMENU_CLOSE_DELAY_MS);
    }
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // A submenu is drawn in its own portal but belongs to this tree, so its keys bubble here.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) {
      return;
    }
    const focusedIndex = rowRefs.current.findIndex((row) => row !== undefined && row === document.activeElement);
    const decision = decideKey(entries, focusedIndex < 0 ? undefined : focusedIndex, event.key, event);
    if (decision.kind === 'ignore') {
      return;
    }
    if (decision.kind === 'close-submenu' && onCloseSelf === undefined) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    switch (decision.kind) {
      case 'focus':
        focusRow(decision.index);
        return;
      case 'choose': {
        const entry = entries[decision.index];
        if (entry !== undefined && isMenuRow(entry)) {
          choose(entry, decision.index);
        }
        return;
      }
      case 'open-submenu':
        clearTimer();
        setSubmenu({ index: decision.index, focusInto: true });
        return;
      case 'close-submenu':
        onCloseSelf?.();
        return;
      case 'close':
        closeAll();
        return;
      default: {
        const exhaustive: never = decision;
        return exhaustive;
      }
    }
  };
  const open = submenu === undefined ? undefined : entries[submenu.index];
  return (
    <div
      className="menu-rows"
      role="presentation"
      onKeyDown={onKeyDown}
      // Space activates a button on key release; the keydown already chose, so the release must not choose again.
      onKeyUp={(event) => {
        if (event.key === ' ') {
          event.preventDefault();
        }
      }}
    >
      {entries.map((entry, index) => {
        if (!isMenuRow(entry)) {
          return <StaticEntry key={entry.id} entry={entry} />;
        }
        return (
          <RowButton
            key={entry.id}
            entry={entry}
            hasChecks={hasChecks}
            hasIcons={hasIcons}
            expanded={submenu?.index === index}
            buttonRef={(element) => {
              rowRefs.current[index] = element ?? undefined;
            }}
            onChoose={() => choose(entry, index)}
            onHover={() => hover(entry, index)}
          />
        );
      })}
      {submenu !== undefined && open?.kind === 'submenu' && (
        <MenuLayer
          open
          anchor={rowRefs.current[submenu.index]}
          entries={open.entries}
          label={open.label}
          placement="right-start"
          widthPxMin={SUBMENU_WIDTH_PX_MIN}
          className=""
          autoFocus={submenu.focusInto}
          onDismiss={() => closeSubmenu(submenu.index)}
          closeAll={closeAll}
          onCloseSelf={() => closeSubmenu(submenu.index)}
          onPointerInside={clearTimer}
        />
      )}
    </div>
  );
}

function StaticEntry({ entry }: { readonly entry: Exclude<MenuEntry, MenuRow> }): ReactNode {
  switch (entry.kind) {
    case 'heading':
      return (
        <div role="presentation" className="menu-heading">
          {entry.label}
        </div>
      );
    case 'note':
      return (
        <div role="presentation" className="menu-note">
          {entry.text}
        </div>
      );
    case 'divider':
      return <div role="separator" className="menu-divider" />;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

interface RowButtonProps {
  readonly entry: MenuRow;
  readonly hasChecks: boolean;
  readonly hasIcons: boolean;
  readonly expanded: boolean;
  readonly buttonRef: RefCallback<HTMLButtonElement>;
  readonly onChoose: () => void;
  readonly onHover: () => void;
}

function RowButton({ entry, hasChecks, hasIcons, expanded, buttonRef, onChoose, onHover }: RowButtonProps) {
  const classes = ['menu-row'];
  if (entry.kind === 'item' && entry.danger === true) {
    classes.push('is-danger');
  }
  if (expanded) {
    classes.push('is-open');
  }
  assert(entry.label.length > 0, 'Menu: every row has a label');
  const infoText = entry.kind === 'submenu' ? undefined : entry.info;
  const tip = useDelayedPlacement(placeTipFor);
  return (
    <button
      ref={buttonRef}
      type="button"
      className={classes.join(' ')}
      disabled={entry.disabled === true}
      onClick={(event) => {
        event.stopPropagation();
        onChoose();
      }}
      onMouseEnter={onHover}
      onFocus={(event) => {
        // Keyboard focus explains the row at once; a pointer's hover-focus waits for the mark (below).
        if (infoText !== undefined && isKeyboardFocus(event.currentTarget)) {
          const mark = event.currentTarget.querySelector<HTMLElement>('.menu-info');
          if (mark !== null) {
            tip.showNow(mark);
          }
        }
      }}
      onBlur={tip.hide}
      onMouseLeave={tip.hide}
      {...rowSemantics(entry, { expanded })}
    >
      {hasIcons && <span className="menu-icon">{entry.icon}</span>}
      <span className="menu-text">
        <span className="menu-title">
          <span className="menu-label">{entry.label}</span>
          {entry.kind === 'item' && entry.pill !== undefined && <span className="menu-pill">{entry.pill}</span>}
        </span>
        {entry.description !== undefined && <span className="menu-description">{entry.description}</span>}
      </span>
      <RowEnd entry={entry} hasChecks={hasChecks} onMarkEnter={infoText === undefined ? undefined : tip.show} onMarkLeave={tip.hide} />
      {infoText !== undefined && tip.value !== undefined && createPortal(<InfoTip text={infoText} placement={tip.value} />, document.body)}
    </button>
  );
}

// Why not the native `title`: the operating system draws it, late, in its own place, and not at all over
// some popups. The tip is the app's own, drawn on the body so the menu's scroll and clip never cut it.
function placeTipFor(mark: HTMLElement): InfoTipPlacement {
  const menu = mark.closest('.menu-surface') ?? mark;
  const box = mark.getBoundingClientRect();
  return placeInfoTip(menu.getBoundingClientRect(), box, window.innerWidth);
}

function isKeyboardFocus(element: HTMLElement): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return false;
  }
}

function InfoTip({ text, placement }: { readonly text: string; readonly placement: InfoTipPlacement }) {
  return (
    <div
      className={`rail-tooltip menu-info-tip${placement.side === 'left' ? ' is-left' : ''}`}
      role="tooltip"
      data-side={placement.side}
      style={{ left: placement.left, top: placement.top }}
    >
      {text}
    </div>
  );
}

function rowSemantics(entry: MenuRow, options: { readonly expanded: boolean }) {
  switch (entry.kind) {
    case 'item':
      return entry.checked === undefined ? { role: 'menuitem' as const } : { role: 'menuitemradio' as const, 'aria-checked': entry.checked };
    case 'toggle':
      return { role: 'menuitemcheckbox' as const, 'aria-checked': entry.on };
    case 'submenu':
      return { role: 'menuitem' as const, 'aria-haspopup': 'menu' as const, 'aria-expanded': options.expanded };
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

function RowEnd({
  entry,
  hasChecks,
  onMarkEnter,
  onMarkLeave,
}: {
  readonly entry: MenuRow;
  readonly hasChecks: boolean;
  readonly onMarkEnter: ((mark: HTMLElement) => void) | undefined;
  readonly onMarkLeave: () => void;
}) {
  switch (entry.kind) {
    case 'item': {
      const key = entry.shortcut ?? (entry.numberKey === undefined ? undefined : String(entry.numberKey));
      return (
        <span className="menu-end">
          <InfoMark text={entry.info} onEnter={onMarkEnter} onLeave={onMarkLeave} />
          {key !== undefined && <span className="menu-key">{key}</span>}
          {hasChecks && <span className="menu-check">{entry.checked === true && <CheckIcon size={14} />}</span>}
        </span>
      );
    }
    case 'toggle':
      return (
        <span className="menu-end">
          <InfoMark text={entry.info} onEnter={onMarkEnter} onLeave={onMarkLeave} />
          <span className="menu-switch" data-on={entry.on} aria-hidden="true">
            <span className="menu-switch-thumb" />
          </span>
        </span>
      );
    case 'submenu':
      return (
        <span className="menu-end">
          {entry.value !== undefined && <span className="menu-value">{entry.value}</span>}
          <ChevronRightIcon size={12} />
        </span>
      );
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}

function InfoMark({
  text,
  onEnter,
  onLeave,
}: {
  readonly text: string | undefined;
  readonly onEnter: ((mark: HTMLElement) => void) | undefined;
  readonly onLeave: () => void;
}) {
  if (text === undefined) {
    return undefined;
  }
  return (
    <span className="menu-info" onMouseEnter={(event) => onEnter?.(event.currentTarget)} onMouseLeave={onLeave}>
      <InfoIcon />
      <span className="menu-visually-hidden">{text}</span>
    </span>
  );
}
