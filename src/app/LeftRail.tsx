import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AppSummary } from '../../shared/properties/apps';
import { useCurrentRole } from '../lib/useCurrentRole';
import { canPanel, canRailTab, canSettingsPanel, settingsViewsOf } from '../lib/roleAccess';
import { shownSettingsView, subscribeShownSettingsView, type SettingsFocusTarget } from '../lib/settingsSections';
import { shortcutOf, railActionOf, type RailAction } from './railShortcuts';
import { FEATURE_ICONS, type FeatureIconComponent } from './featureIcons';
import { AppsRailBadge } from '../features/apps/appUpdates';
import { AppTile } from '../features/apps/AppTile';
import { RailAppFace, openPinnedApp, railAppId, usePinnedRailApps, useShownPinnedApp } from './railApps';
import { useAppsRuntime } from '../features/apps/appsRuntime';
import { RailMore, type RailMoreItem } from './RailMore';
import { useRailOverflow, type RailOverflowItem } from './railOverflow';
import { useTranslate } from '../lib/i18n/useTranslate';
import { tooltipAnchor, useTipTimer, type TooltipAnchor } from '../ui/delayedTooltip';
import FittedTooltip from '../ui/FittedTooltip';
import { crossRailItem, isRailFixedId, railPosition, sameRailOrder, shiftRailItem, visibleRailOrder, type RailGroup, type RailOrder } from './railOrder';
import { useRailOrder } from './railOrderStore';
import { DEFAULT_RAIL_ORDER } from './railDefaults';
import { useRailDrag } from './railDrag';
import { orderAfterDrop } from './railDragModel';
import { RAIL_PANEL_TABS, RAIL_SETTINGS_VIEWS, isRailSettingsViewId, movedKey, railItemSpec, type RailPanelId } from './railItems';
import { animateRailReflow, readRailRows } from './railReflow';

// Each panel button's label, icon and chord are railItems.ts's, read by the Settings panel's root rows too, so a
// panel moved into Settings looks the same there.
// The project's Settings panel (features/projectSettings) sits at the rail's foot, directly above the AI button,
// and like it never moves into More (railOverflow.ts measures the anchored pair). Not the app's Settings screen.
// It holds the Instructions too (their own rail button became ⌥I, which opens Settings at them).
const SETTINGS_TAB = { id: 'projectSettings', shortcut: shortcutOf('projectSettings'), Icon: FEATURE_ICONS['panel:projectSettings'] } as const;
export type RailTab = RailPanelId | typeof SETTINGS_TAB.id;

// The order each person arranges by dragging (railOrder.ts): the top list holds most panels, the bottom list
// holds Style selectors, Audits, the project's Settings and the AI button. The default is the source of truth for which buttons exist.
const AI_ID = 'ai';

/** One rail button, whichever list it is in. */
interface RailEntry {
  readonly id: string;
  readonly label: string;
  readonly shortcut: string | undefined;
  readonly Icon: FeatureIconComponent;
  /** The tooltip's text after a pause on the button. */
  readonly tooltip: string;
  readonly pressed: boolean;
  readonly select: () => void;
  readonly badge: ReactNode;
}

const AiRailIcon = FEATURE_ICONS['panel:ai'];

// Webflow-style icon rail. Clicking the active tab collapses the panel.
// Hovering a button for a moment shows a tooltip with its keyboard shortcut.
// Below the panels, after a line, come the apps the role pinned (railApps.tsx).
// Buttons a short window has no room for move into a More menu at the foot
// (railOverflow.ts); their shortcuts keep working, because the keys never ask
// what is drawn.
// Each person arranges the buttons (railOrder.ts): drag one to reorder it or to move it between the top
// list and the bottom list at the foot, or use Alt+arrows on a focused button. The order is kept per
// person for every project (railOrderStore.ts).
// A button can also go into the Settings panel, as one of its root rows: dropped on the middle of the Settings
// button, or between the rows once resting there has opened the panel (railDrag.ts). A Settings view dragged out of that panel (SettingsRailRows.tsx) becomes a button here that opens
// Settings at the view. Settings and the AI button never go inside Settings.
export default function LeftRail({
  active,
  onSelect,
  onOpenSettings,
  componentOpen = false,
  projectPath,
  aiButton,
}: {
  readonly componentOpen?: boolean;
  readonly active?: RailTab | undefined;
  /** The open project, whose installed apps the role's pins name. */
  readonly projectPath?: string | undefined;
  readonly onSelect: (tab: RailTab) => void;
  /** Opens Settings at a section and keeps it open when it already is: what ⌥I does for the Instructions. */
  readonly onOpenSettings: (target: SettingsFocusTarget) => void;
  /** The AI chat button at the rail's foot; absent for a role without the panel. */
  readonly aiButton?: { readonly active: boolean; readonly onSelect: () => void } | undefined;
}) {
  const [tip, setTip] = useState<{ readonly label: string; readonly anchor: TooltipAnchor } | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');
  const translate = useTranslate();
  const tipTimer = useTipTimer();
  const railRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const reflowRef = useRef<ReadonlyMap<string, number> | undefined>(undefined);
  const focusAfterRef = useRef<string | undefined>(undefined);
  const { order, change } = useRailOrder(DEFAULT_RAIL_ORDER);

  const hide = () => {
    tipTimer.cancel();
    setTip(undefined);
  };

  const showSoon = (label: string) => (event: MouseEvent<HTMLButtonElement>) => {
    const button = event.currentTarget;
    const rect = button.getBoundingClientRect();
    tipTimer.wait(button, () => setTip({ label, anchor: tooltipAnchor(rect) }), hide);
  };

  // A panel the project's role hides has no button and no shortcut (roles/roleAccess.ts).
  const role = useCurrentRole();
  useRailKeys({ componentOpen }, (action) => {
    if (action === 'ai') {
      // The AI chat toggles like a panel; a role without it has no button, so no key.
      aiButton?.onSelect();
    } else if (isRailSettingsViewId(action)) {
      // A view of Settings: opens Settings at it, or, when that view is already showing, toggles the panel closed.
      if (settingsViewsOf(role).includes(action)) {
        if (active === 'projectSettings' && shownSettingsView() === action) {
          onSelect('projectSettings');
        } else {
          onOpenSettings(action);
        }
      }
    } else if (canRailTab(role, action)) {
      onSelect(action);
    }
  });
  const tabs = RAIL_PANEL_TABS.filter((tab) => tab.id !== 'properties' || componentOpen).filter((tab) => canPanel(role, tab.id));
  const shownView = useSyncExternalStore(subscribeShownSettingsView, shownSettingsView, shownSettingsView);
  const pinned = usePinnedRailApps(projectPath, role, active);
  // A pinned app the open Apps panel shows is the active button, in place of Apps itself.
  const shownApp = useShownPinnedApp(role, active === 'apps' ? 'open' : 'closed');
  const activeApp = pinned.find((app) => app.manifest.id === shownApp);
  const openApps = useAppsRuntime().running;
  const activeId = activeApp === undefined ? active : railAppId(activeApp.manifest.id);

  // Every button this role has, by id; the order only arranges them.
  const entries = new Map<string, RailEntry>();
  for (const { id, titleKey, shortcut, Icon } of tabs) {
    entries.set(id, {
      id,
      label: translate(titleKey),
      shortcut,
      Icon,
      tooltip: translate('rail.withShortcut', { label: translate(titleKey), shortcut }),
      pressed: activeId === id,
      select: () => onSelect(id),
      badge: id === 'apps' ? <AppsRailBadge admin={role.isAdmin} /> : undefined,
    });
  }
  // A Settings view moved onto the rail opens Settings at it, and closes the panel when that view already shows.
  const roleViews = settingsViewsOf(role);
  for (const view of RAIL_SETTINGS_VIEWS.filter((each) => roleViews.includes(each))) {
    const spec = railItemSpec(view);
    if (spec !== undefined) {
      const label = translate(spec.titleKey);
      entries.set(view, {
        id: view,
        label,
        shortcut: spec.shortcut,
        Icon: spec.Icon,
        tooltip: translate('rail.withShortcut', { label, shortcut: spec.shortcut }),
        pressed: active === SETTINGS_TAB.id && shownView === view,
        select: () => {
          if (active === SETTINGS_TAB.id && shownSettingsView() === view) {
            onSelect(SETTINGS_TAB.id);
          } else {
            onOpenSettings(view);
          }
        },
        badge: undefined,
      });
    }
  }
  // Settings shows for a role with a view of its own, or with any item a person moved into it.
  const settingsHolds = order.settings.filter((id) => entries.has(id));
  const activeInSettings = active !== undefined && active !== SETTINGS_TAB.id && order.settings.includes(active);
  if (canSettingsPanel(role) || settingsHolds.length > 0) {
    entries.set(SETTINGS_TAB.id, {
      id: SETTINGS_TAB.id,
      label: translate('rail.settings'),
      shortcut: SETTINGS_TAB.shortcut,
      Icon: SETTINGS_TAB.Icon,
      tooltip: translate('rail.withShortcut', { label: translate('rail.settings'), shortcut: SETTINGS_TAB.shortcut }),
      // A panel opened from a Settings row lights Settings, the button it was reached from.
      pressed: active === SETTINGS_TAB.id || activeInSettings,
      select: () => onSelect(SETTINGS_TAB.id),
      badge: undefined,
    });
  }
  if (aiButton !== undefined) {
    entries.set(AI_ID, {
      id: AI_ID,
      label: translate('rail.ai'),
      shortcut: shortcutOf('ai'),
      Icon: AiRailIcon,
      tooltip: translate('rail.withShortcut', { label: translate('rail.ai'), shortcut: shortcutOf('ai') }),
      pressed: aiButton.active,
      select: aiButton.onSelect,
      badge: undefined,
    });
  }
  const shownIds = new Set(entries.keys());
  const visible = visibleRailOrder(order, shownIds);
  const entryOf = (id: string): RailEntry | undefined => entries.get(id);
  const topEntries = visible.top.map(entryOf).filter((entry): entry is RailEntry => entry !== undefined);
  const bottomEntries = visible.bottom.map(entryOf).filter((entry): entry is RailEntry => entry !== undefined);

  const items: readonly RailOverflowItem[] = [
    ...topEntries.map((entry): RailOverflowItem => ({ id: entry.id, group: 'panel' })),
    ...pinned.map((app): RailOverflowItem => ({ id: railAppId(app.manifest.id), group: 'app' })),
  ];
  const overflowActive = aiButton?.active === true ? AI_ID : activeId;
  const layout = useRailOverflow(railRef, bottomEntries.length === 0 ? undefined : anchorRef, items, overflowActive);
  const shown = new Set(layout.visible);
  const shownTopEntries = topEntries.filter((entry) => shown.has(entry.id));
  const shownApps = pinned.filter((app) => shown.has(railAppId(app.manifest.id)));

  // A new order is committed here: the rows are read first so the layout effect below can slide the buttons.
  const commitOrder = (next: RailOrder, id: string, focusAfter: 'focus' | 'none') => {
    if (!sameRailOrder(next, order)) {
      reflowRef.current = readRailRows(railRef.current ?? undefined);
      if (focusAfter === 'focus') {
        focusAfterRef.current = id;
      }
      change(next);
      const place = railPosition(next, shownIds, id);
      const label = entries.get(id)?.label;
      if (place !== undefined && label !== undefined) {
        setAnnouncement(translate(movedKey(place.group), { label, position: place.position, count: place.count }));
      }
    }
  };
  useLayoutEffect(() => {
    const before = reflowRef.current;
    reflowRef.current = undefined;
    if (before !== undefined) {
      animateRailReflow(railRef.current ?? undefined, before);
    }
    const focusId = focusAfterRef.current;
    focusAfterRef.current = undefined;
    if (focusId !== undefined) {
      for (const button of railRef.current?.querySelectorAll<HTMLElement>('[data-rail-id]') ?? []) {
        if (button.dataset['railId'] === focusId) {
          button.focus();
        }
      }
    }
  }, [order]);

  const drag = useRailDrag({
    origin: 'rail',
    railRef,
    canEnterSettings: (id) => !isRailFixedId(id),
    onStart: hide,
    // Resting on Settings mid-drag opens it, so the button can be dropped between its rows.
    onSpring: () => {
      if (active !== SETTINGS_TAB.id) {
        onSelect(SETTINGS_TAB.id);
      }
    },
    onDrop: (id, dropSlot) => commitOrder(orderAfterDrop(order, id, dropSlot), id, 'none'),
  });
  const dragView = drag.view;
  // The ghost is the surface's that started the drag: a Settings row dragged over the rail draws its own.
  const dragEntry = dragView?.origin === 'rail' ? entries.get(dragView.id) : undefined;
  const slot = dragView?.slot;
  const railSlot = slot !== undefined && (slot.group === 'top' || slot.group === 'bottom') ? slot : undefined;
  // The line shows only where a drop would change what is drawn.
  const dropChanges =
    dragView !== undefined && railSlot !== undefined && !sameRailOrder(visibleRailOrder(orderAfterDrop(order, dragView.id, railSlot), shownIds), visible);
  // While a movable item is dragged, Settings is lit as a place to drop it, and lit more while the pointer is on it.
  const settingsDropReady = dragView !== undefined && !isRailFixedId(dragView.id) && dragView.id !== SETTINGS_TAB.id;

  const moveByKey = (event: ReactKeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    let next: RailOrder | undefined;
    if (event.key === 'ArrowUp') {
      next = shiftRailItem(order, shownIds, id, 'up');
    } else if (event.key === 'ArrowDown') {
      next = shiftRailItem(order, shownIds, id, 'down');
    } else if (event.key === 'ArrowLeft') {
      next = crossRailItem(order, id, 'top');
    } else if (event.key === 'ArrowRight') {
      next = crossRailItem(order, id, 'bottom');
    }
    if (next !== undefined) {
      event.preventDefault();
      hide();
      commitOrder(next, id, 'focus');
    }
  };

  const selectApp = (app: AppSummary) => {
    hide();
    if (app === activeApp) {
      // Like the active panel's button, the shown app's collapses the panel.
      onSelect('apps');
    } else if (projectPath !== undefined) {
      openPinnedApp(projectPath, app);
    }
  };
  const moreItems: readonly RailMoreItem[] = [
    ...topEntries
      .filter((entry) => !shown.has(entry.id))
      .map((entry): RailMoreItem => ({
        id: entry.id,
        label: entry.label,
        icon: <entry.Icon size={16} />,
        shortcut: entry.shortcut,
        select: entry.select,
      })),
    ...pinned
      .filter((app) => !shown.has(railAppId(app.manifest.id)))
      .map((app): RailMoreItem => ({
        id: railAppId(app.manifest.id),
        label: app.manifest.name,
        icon: <AppTile manifest={app.manifest} size={16} />,
        shortcut: undefined,
        select: () => selectApp(app),
      })),
  ];

  const renderButton = (entry: RailEntry, group: RailGroup) => {
    const dragged = dragView?.id === entry.id;
    return (
      <button
        key={entry.id}
        aria-label={entry.shortcut === undefined ? entry.label : translate('rail.withShortcut', { label: entry.label, shortcut: entry.shortcut })}
        aria-pressed={entry.pressed}
        className={`rail-btn ${entry.pressed ? 'on' : ''}`}
        data-rail-id={entry.id}
        data-rail-group={group}
        data-dragging={dragged ? 'true' : undefined}
        data-drop-ready={entry.id === SETTINGS_TAB.id && settingsDropReady ? 'true' : undefined}
        data-drop-target={entry.id === SETTINGS_TAB.id && slot?.group === 'settingsButton' ? 'true' : undefined}
        onMouseEnter={showSoon(entry.tooltip)}
        onMouseLeave={hide}
        onClickCapture={(event) => {
          // The click that ends a drag is not a choice of the panel.
          if (drag.takeSuppressedClick()) {
            event.preventDefault();
            event.stopPropagation();
          }
        }}
        onClick={() => {
          hide();
          entry.select();
        }}
        onKeyDown={(event) => moveByKey(event, entry.id)}
        {...drag.handlersFor(entry.id)}
      >
        <entry.Icon size={20} />
        {entry.badge}
      </button>
    );
  };

  return (
    <div
      className="rail"
      ref={railRef}
      data-dragging={dragView === undefined ? undefined : 'true'}
      // A Settings row dragged out lights the rail as the place to drop it.
      data-drop-ready={dragView?.origin === 'settings' ? 'true' : undefined}
      // Right-clicking a button does nothing: no menu of ours, and no native one either. The order changes by dragging,
      // Alt+arrows, or Settings > rail order.
      onContextMenu={(event) => event.preventDefault()}
    >
      {shownTopEntries.map((entry) => renderButton(entry, 'top'))}
      {shownTopEntries.length > 0 && shownApps.length > 0 && <div className="rail-separator" role="separator" />}
      {shownApps.map((app) => {
        const id = railAppId(app.manifest.id);
        return (
          <button
            key={id}
            aria-label={app.manifest.name}
            aria-pressed={activeId === id}
            className={`rail-btn rail-app ${activeId === id ? 'on' : ''}`}
            data-open={openApps.some((running) => running.app.manifest.id === app.manifest.id)}
            onMouseEnter={showSoon(app.manifest.name)}
            onMouseLeave={hide}
            onClick={() => selectApp(app)}
          >
            <RailAppFace app={app} />
          </button>
        );
      })}
      {moreItems.length > 0 && <RailMore items={moreItems} active={overflowActive} />}
      {/* Drawn before the anchored list so that list stays the rail's last element. */}
      {dragView !== undefined && dragEntry !== undefined && (
        <div className="rail-ghost" ref={drag.ghostRef} aria-hidden="true" data-rail-float="true" data-outside={slot === undefined ? 'true' : undefined}>
          <dragEntry.Icon size={20} />
        </div>
      )}
      {dragView !== undefined && railSlot !== undefined && dropChanges && (
        <div className="rail-drop-line" aria-hidden="true" data-rail-float="true" style={{ top: railSlot.lineY - dragView.railTop - 1 }} />
      )}
      <div className="rail-live" role="status" aria-live="polite" data-rail-float="true">
        {announcement}
      </div>
      {bottomEntries.length > 0 ? (
        // Anchored at the foot like Studio's AI button: these never move into More (railOverflow.ts).
        // The default order puts Settings first, so it sits directly above the AI button.
        <div className="rail-anchor" ref={anchorRef}>
          {bottomEntries.map((entry) => renderButton(entry, 'bottom'))}
        </div>
      ) : (
        // While a button is dragged, an empty bottom list is still somewhere to drop it.
        dragView !== undefined && (
          <div className="rail-anchor rail-drop-zone">
            <div className="rail-slot-empty" />
          </div>
        )
      )}
      {tip && (
        // The tip opens on the rail's inner side: its right in a left-to-right interface, its left when the interface is
        // mirrored. FittedTooltip keeps it inside the window, so a button at the foot of the rail never has its tip cut off.
        <FittedTooltip anchor={tip.anchor} preferred={document.documentElement.dir === 'rtl' ? 'left' : 'right'}>
          {tip.label}
        </FittedTooltip>
      )}
    </div>
  );
}

function useRailKeys({ componentOpen }: { readonly componentOpen: boolean }, onAction: (action: RailAction) => void): void {
  // The chords are the table's (railShortcuts.ts); they are ignored while typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      const shortcut = railActionOf(event);
      // Properties has a button, and so a key, only while a component is open.
      if (shortcut === undefined || (shortcut.action === 'properties' && !componentOpen)) {
        return;
      }
      event.preventDefault();
      onAction(shortcut.action);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onAction, componentOpen]);
}
