// The Settings panel's root on Desktop: the third container of the rail order (railOrder.ts), drawn as rows.
// Its own views (Secrets, MCP, Instructions, Agents) and any rail panel a person moved in, each a row with its
// icon, its name and a chevron. A view's row opens the view inside Settings; a panel's row opens that panel in the
// panel area, as its rail button did.
//
// The rows are arranged like the rail's buttons and with the same drag (railDrag.ts, one drag for both surfaces):
// drag a row up or down to reorder it, out onto the rail to make it a button there, or drag a rail button in.
// Keyboard: Alt+Up and Alt+Down move a focused row, Alt+Left (Alt+Right when the interface is mirrored, toward
// the rail) moves it out onto the rail; the context menu offers the same moves. Each move is announced.
// An item the role cannot open is not drawn, but keeps its place in the order.
import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from 'react';
import { assert } from '../../shared/core/assert';
import { useTranslate } from '../lib/i18n/useTranslate';
import { canPanel, settingsViewsOf } from '../lib/roleAccess';
import type { SettingsViewId } from '../lib/settingsSections';
import { useCurrentRole } from '../lib/useCurrentRole';
import { ChevronRightIcon } from '../ui/Icons';
import Menu, { type MenuEntry } from '../ui/Menu';
import { useShortcutTip } from '../ui/shortcutTip';
import { useRailDrag, type RailDragHandlers } from './railDrag';
import { orderAfterDrop } from './railDragModel';
import { DEFAULT_RAIL_ORDER } from './railDefaults';
import { movedKey, railItemSpec, type RailItemSpec, type RailPanelId } from './railItems';
import { moveOutOfSettings, railPosition, sameRailOrder, shiftRailItem, type RailOrder } from './railOrder';
import { useRailOrder } from './railOrderStore';
import './settingsRailRows.css';

export interface SettingsRailRowsProps {
  /** Opens a Settings view in place of the root. */
  readonly show: (view: SettingsViewId) => void;
  /** Opens a rail panel that lives in Settings, in the panel area. */
  readonly onOpenPanel: (panel: RailPanelId) => void;
  /** Whether a component is open: Properties has a row, as it has a button, only then. */
  readonly componentOpen: boolean;
}

export function SettingsRailRows({ show, onOpenPanel, componentOpen }: SettingsRailRowsProps) {
  const translate = useTranslate();
  const role = useCurrentRole();
  const { order, change } = useRailOrder(DEFAULT_RAIL_ORDER);
  const [menu, setMenu] = useState<{ readonly anchor: HTMLElement; readonly id: string } | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const focusAfterRef = useRef<string | undefined>(undefined);

  // Every item this role can open, wherever it lives, so a shift steps over the hidden ones only.
  const roleViews = settingsViewsOf(role);
  const shownIds = new Set<string>();
  const specs = new Map<string, RailItemSpec>();
  for (const id of [...order.top, ...order.bottom, ...order.settings]) {
    const spec = railItemSpec(id);
    if (spec !== undefined && specShown(spec, { roleViews, componentOpen, canOpenPanel: (panel) => canPanel(role, panel) })) {
      shownIds.add(id);
      specs.set(id, spec);
    }
  }
  const rows = order.settings.filter((id) => shownIds.has(id));

  const commit = (next: RailOrder, id: string, focusAfter: 'focus' | 'none'): void => {
    if (sameRailOrder(next, order)) {
      return;
    }
    if (focusAfter === 'focus') {
      focusAfterRef.current = id;
    }
    change(next);
    const place = railPosition(next, shownIds, id);
    const spec = specs.get(id);
    if (place !== undefined && spec !== undefined) {
      setAnnouncement(translate(movedKey(place.group), { label: translate(spec.titleKey), position: place.position, count: place.count }));
    }
  };
  // Focus follows a moved item, onto the rail when it left Settings.
  useLayoutEffect(() => {
    const id = focusAfterRef.current;
    focusAfterRef.current = undefined;
    if (id !== undefined) {
      for (const element of document.querySelectorAll<HTMLElement>('[data-rail-id]')) {
        if (element.dataset['railId'] === id) {
          element.focus();
        }
      }
    }
  }, [order]);

  const drag = useRailDrag({
    origin: 'settings',
    railRef: undefined,
    // Every Settings row may stay in Settings: none is fixed to the rail.
    canEnterSettings: () => true,
    onStart: () => setMenu(undefined),
    onSpring: () => {},
    onDrop: (id, slot) => commit(orderAfterDrop(order, id, slot), id, 'none'),
  });
  const view = drag.view;
  const slot = view?.slot;
  const settingsSlot = slot !== undefined && slot.group === 'settings' ? slot : undefined;
  // The line shows only where a drop would change the rows.
  const lineChanges = view !== undefined && settingsSlot !== undefined && !sameRailOrder(orderAfterDrop(order, view.id, settingsSlot), order);
  const lineBefore = lineChanges ? settingsSlot.beforeId : undefined;
  const lineAtEnd = lineChanges && settingsSlot.beforeId === undefined;
  const ghostSpec = view?.origin === 'settings' ? specs.get(view.id) : undefined;

  const moveByKey = (event: ReactKeyboardEvent<HTMLElement>, id: string): void => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    // The rail is on the interface's start side: the left, or the right when mirrored.
    const towardRail = document.documentElement.dir === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
    let next: RailOrder | undefined;
    if (event.key === 'ArrowUp') {
      next = shiftRailItem(order, shownIds, id, 'up');
    } else if (event.key === 'ArrowDown') {
      next = shiftRailItem(order, shownIds, id, 'down');
    } else if (event.key === towardRail) {
      next = moveOutOfSettings(order, id);
    }
    if (next !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      commit(next, id, 'focus');
    }
  };
  const menuEntries = (id: string): readonly MenuEntry[] => {
    const at = rows.indexOf(id);
    assert(at >= 0, 'The menu belongs to a drawn row');
    const entries: MenuEntry[] = [];
    if (at > 0) {
      entries.push({ kind: 'item', id: 'up', label: translate('rail.moveUp'), onSelect: () => commit(shiftRailItem(order, shownIds, id, 'up'), id, 'focus') });
    }
    if (at < rows.length - 1) {
      entries.push({
        kind: 'item',
        id: 'down',
        label: translate('rail.moveDown'),
        onSelect: () => commit(shiftRailItem(order, shownIds, id, 'down'), id, 'focus'),
      });
    }
    entries.push({ kind: 'item', id: 'rail', label: translate('rail.moveToRail'), onSelect: () => commit(moveOutOfSettings(order, id), id, 'focus') });
    return entries;
  };

  return (
    <div
      className="panel-body settings-body settings-rail-list"
      role="list"
      aria-label={translate('settings.sections')}
      data-rail-settings-list="true"
      data-drop-ready={view?.origin === 'rail' ? 'true' : undefined}
      data-dragging={view === undefined ? undefined : 'true'}
    >
      {rows.map((id) => {
        const spec = specs.get(id);
        assert(spec !== undefined, 'A drawn row has its spec');
        return (
          <SettingsRailRow
            key={id}
            spec={spec}
            dragging={view?.id === id}
            lineBefore={lineBefore === id}
            lineAfter={lineAtEnd && rows.at(-1) === id}
            handlers={drag.handlersFor(id)}
            onActivate={() => {
              if (drag.takeSuppressedClick()) {
                return;
              }
              if (spec.kind === 'panel') {
                onOpenPanel(spec.id);
              } else {
                show(spec.id);
              }
            }}
            onKeyDown={(event) => moveByKey(event, id)}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ anchor: event.currentTarget, id });
            }}
          />
        );
      })}
      {rows.length === 0 && (
        <div className="settings-rail-empty" data-drop-ready={lineAtEnd ? 'true' : undefined}>
          {translate('rail.settingsEmpty')}
        </div>
      )}
      {ghostSpec !== undefined && (
        <div className="rail-ghost" ref={drag.ghostRef} aria-hidden="true" data-outside={slot === undefined ? 'true' : undefined}>
          <ghostSpec.Icon size={20} />
        </div>
      )}
      <div className="rail-live" role="status" aria-live="polite">
        {announcement}
      </div>
      {menu !== undefined && rows.includes(menu.id) && (
        <Menu
          open
          anchor={menu.anchor}
          entries={menuEntries(menu.id)}
          label={translate('rail.orderMenu')}
          placement="right-start"
          onClose={() => setMenu(undefined)}
        />
      )}
    </div>
  );
}

// One row: a button of the Pages list's look, its chord in a tooltip after a rest (never inline).
function SettingsRailRow({
  spec,
  dragging,
  lineBefore,
  lineAfter,
  handlers,
  onActivate,
  onKeyDown,
  onContextMenu,
}: {
  readonly spec: RailItemSpec;
  readonly dragging: boolean;
  readonly lineBefore: boolean;
  readonly lineAfter: boolean;
  readonly handlers: RailDragHandlers;
  readonly onActivate: () => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const translate = useTranslate();
  const label = translate(spec.titleKey);
  const { props, tip } = useShortcutTip(label, spec.shortcut);
  let line: 'before' | 'after' | undefined;
  if (lineBefore) {
    line = 'before';
  } else if (lineAfter) {
    line = 'after';
  }
  return (
    <>
      <button
        type="button"
        role="listitem"
        className="list-item settings-link"
        data-rail-id={spec.id}
        data-rail-group="settings"
        data-dragging={dragging ? 'true' : undefined}
        data-drop-line={line}
        onClick={onActivate}
        onKeyDown={onKeyDown}
        onContextMenu={onContextMenu}
        {...props}
        {...handlers}
      >
        <span className="icon">
          <spec.Icon size={14} />
        </span>
        <span className="label">{label}</span>
        <ChevronRightIcon size={12} />
      </button>
      {tip}
    </>
  );
}

// Whether the role can open the item: a view the role's Settings lists, a panel its access shows.
function specShown(
  spec: RailItemSpec,
  access: { readonly roleViews: readonly SettingsViewId[]; readonly componentOpen: boolean; readonly canOpenPanel: (panel: RailPanelId) => boolean },
): boolean {
  if (spec.kind === 'settingsView') {
    return access.roleViews.includes(spec.id);
  }
  if (spec.id === 'properties') {
    return access.componentOpen && access.canOpenPanel(spec.id);
  }
  return access.canOpenPanel(spec.id);
}
