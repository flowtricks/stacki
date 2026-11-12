import type { MouseEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AppSummary } from '../../shared/properties/apps';
import { useCurrentRole } from '../lib/useCurrentRole';
import { canPanel } from '../lib/roleAccess';
import { FEATURE_ICONS } from './featureIcons';
import { AppsRailBadge } from '../features/apps/appUpdates';
import { AppTile } from '../features/apps/AppTile';
import { RailAppFace, openPinnedApp, railAppId, usePinnedRailApps, useShownPinnedApp } from './railApps';
import { useAppsRuntime } from '../features/apps/appsRuntime';
import { RailMore, type RailMoreItem } from './RailMore';
import { useRailOverflow, type RailOverflowItem } from './railOverflow';
import { useTranslate } from '../lib/i18n/useTranslate';

// Each button draws its access feature's icon (featureIcons.tsx), the same one the
// Roles permission grid shows, so the two cannot drift apart.
const TABS = [
  { id: 'pages', title: 'Pages', shortcut: 'P', Icon: FEATURE_ICONS['panel:pages'] },
  { id: 'navigator', title: 'Navigator', shortcut: 'Z', Icon: FEATURE_ICONS['panel:navigator'] },
  { id: 'properties', title: 'Properties', shortcut: 'K', Icon: FEATURE_ICONS['panel:properties'] },
  { id: 'components', title: 'Components', shortcut: '⇧A', Icon: FEATURE_ICONS['panel:components'] },
  { id: 'assets', title: 'Assets', shortcut: 'J', Icon: FEATURE_ICONS['panel:assets'] },
  { id: 'cms', title: 'CMS', shortcut: '⌥C', Icon: FEATURE_ICONS['panel:cms'] },
  { id: 'variables', title: 'Variables', shortcut: '⌥V', Icon: FEATURE_ICONS['panel:variables'] },
  { id: 'selectors', title: 'Style selectors', shortcut: 'G', Icon: FEATURE_ICONS['panel:selectors'] },
  { id: 'code', title: 'Code', shortcut: 'C', Icon: FEATURE_ICONS['panel:code'] },
  { id: 'history', title: 'Git', shortcut: '⌥H', Icon: FEATURE_ICONS['panel:history'] },
  { id: 'apps', title: 'Apps', shortcut: 'E', Icon: FEATURE_ICONS['panel:apps'] },
  { id: 'instructions', title: 'Instructions', shortcut: '⌥I', Icon: FEATURE_ICONS['panel:instructions'] },
  { id: 'audits', title: 'Audits', shortcut: '⌥A', Icon: FEATURE_ICONS['panel:audits'] },
] as const;
// The project's Settings panel (features/projectSettings) sits at the rail's foot, directly above the AI button,
// and like it never moves into More (railOverflow.ts measures the anchored pair). Not the app's Settings screen.
const SETTINGS_TAB = { id: 'projectSettings', shortcut: '⌥S', Icon: FEATURE_ICONS['panel:projectSettings'] } as const;
export type RailTab = (typeof TABS)[number]['id'] | typeof SETTINGS_TAB.id;

const TOOLTIP_DELAY = 500;
const AiRailIcon = FEATURE_ICONS['panel:ai'];

// Webflow-style icon rail. Clicking the active tab collapses the panel.
// Hovering a button for a moment shows a tooltip with its keyboard shortcut.
// Below the panels, after a line, come the apps the role pinned (railApps.tsx).
// Buttons a short window has no room for move into a More menu at the foot
// (railOverflow.ts); their shortcuts keep working, because the keys never ask
// what is drawn.
export default function LeftRail({
  active,
  onSelect,
  componentOpen = false,
  projectPath,
  aiButton,
}: {
  readonly componentOpen?: boolean;
  readonly active?: RailTab | undefined;
  /** The open project, whose installed apps the role's pins name. */
  readonly projectPath?: string | undefined;
  readonly onSelect: (tab: RailTab) => void;
  /** The AI chat button at the rail's foot; absent for a role without the panel. */
  readonly aiButton?: { readonly active: boolean; readonly onSelect: () => void } | undefined;
}) {
  const [tip, setTip] = useState<{ readonly label: string; readonly left: number; readonly top: number } | undefined>(undefined);
  const translate = useTranslate();
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const railRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  const showSoon = (label: string) => (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setTip({ label, left: rect.right + 10, top: rect.top + rect.height / 2 }), TOOLTIP_DELAY);
  };

  const hide = () => {
    clearTimeout(timerRef.current);
    setTip(undefined);
  };

  useEffect(() => () => clearTimeout(timerRef.current), []);

  // A panel the project's role hides has no button and no shortcut (roles/roleAccess.ts).
  const role = useCurrentRole();
  useRailKeys({ componentOpen }, (tab) => {
    if (canPanel(role, tab)) {
      onSelect(tab);
    }
  });
  const tabs = TABS.filter((tab) => tab.id !== 'properties' || componentOpen).filter((tab) => canPanel(role, tab.id));
  const pinned = usePinnedRailApps(projectPath, role, active);
  // A pinned app the open Apps panel shows is the active button, in place of Apps itself.
  const shownApp = useShownPinnedApp(role, active === 'apps' ? 'open' : 'closed');
  const activeApp = pinned.find((app) => app.manifest.id === shownApp);
  const openApps = useAppsRuntime().running;
  const activeId = activeApp === undefined ? active : railAppId(activeApp.manifest.id);
  const items: readonly RailOverflowItem[] = [
    ...tabs.map((tab): RailOverflowItem => ({ id: tab.id, group: 'panel' })),
    ...pinned.map((app): RailOverflowItem => ({ id: railAppId(app.manifest.id), group: 'app' })),
  ];
  const showSettings = canPanel(role, SETTINGS_TAB.id);
  const layout = useRailOverflow(railRef, aiButton === undefined && !showSettings ? undefined : anchorRef, items, activeId);
  const shown = new Set(layout.visible);
  const shownTabs = tabs.filter((tab) => shown.has(tab.id));
  const shownApps = pinned.filter((app) => shown.has(railAppId(app.manifest.id)));

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
    ...tabs
      .filter((tab) => !shown.has(tab.id))
      .map(({ id, title, shortcut, Icon }): RailMoreItem => ({ id, label: title, icon: <Icon size={16} />, shortcut, select: () => onSelect(id) })),
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

  return (
    <div className="rail" ref={railRef}>
      {shownTabs.map(({ id, Icon, title, shortcut }) => (
        <button
          key={id}
          aria-label={shortcut ? `${title} (${shortcut})` : title}
          aria-pressed={activeId === id}
          className={`rail-btn ${activeId === id ? 'on' : ''}`}
          onMouseEnter={showSoon(shortcut ? `${title} (${shortcut})` : title)}
          onMouseLeave={hide}
          onClick={() => {
            hide();
            onSelect(id);
          }}
        >
          <Icon size={20} />
          {id === 'apps' && <AppsRailBadge admin={role.isAdmin} />}
        </button>
      ))}
      {shownTabs.length > 0 && shownApps.length > 0 && <div className="rail-separator" role="separator" />}
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
      {moreItems.length > 0 && <RailMore items={moreItems} active={activeId} />}
      {(aiButton !== undefined || showSettings) && (
        // Anchored at the foot like Studio's AI button: these never move into More (railOverflow.ts).
        // Settings comes first, so it sits directly above the AI button.
        <div className="rail-anchor" ref={anchorRef}>
          {showSettings && (
            <button
              aria-label={`${translate('rail.settings')} (${SETTINGS_TAB.shortcut})`}
              aria-pressed={active === SETTINGS_TAB.id}
              className={`rail-btn ${active === SETTINGS_TAB.id ? 'on' : ''}`}
              onMouseEnter={showSoon(translate('rail.settings'))}
              onMouseLeave={hide}
              onClick={() => {
                hide();
                onSelect(SETTINGS_TAB.id);
              }}
            >
              <SETTINGS_TAB.Icon size={20} />
            </button>
          )}
          {aiButton !== undefined && (
            <button
              aria-label="AI chat"
              aria-pressed={aiButton.active}
              className={`rail-btn ${aiButton.active ? 'on' : ''}`}
              onMouseEnter={showSoon('AI chat')}
              onMouseLeave={hide}
              onClick={() => {
                hide();
                aiButton.onSelect();
              }}
            >
              <AiRailIcon size={20} />
            </button>
          )}
        </div>
      )}
      {tip && (
        <div className="rail-tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.label}
        </div>
      )}
    </div>
  );
}

function useRailKeys({ componentOpen }: { readonly componentOpen: boolean }, onSelect: (tab: RailTab) => void): void {
  // P / Z / ⇧A / J / G / E / ⌥C / ⌥V / ⌥H / ⌥I / ⌥A / ⌥S toggle the panels (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }
      if (event.altKey) {
        // Matched on the physical key: Option rewrites e.key ("ç" for C,
        // "˙" for H), so e.key would never equal the letter.
        if (event.code === 'KeyC') {
          event.preventDefault();
          onSelect('cms');
        } else if (event.code === 'KeyV') {
          event.preventDefault();
          onSelect('variables');
        } else if (event.code === 'KeyH') {
          event.preventDefault();
          onSelect('history');
        } else if (event.code === 'KeyI') {
          event.preventDefault();
          onSelect('instructions');
        } else if (event.code === 'KeyA') {
          event.preventDefault();
          onSelect('audits');
        } else if (event.code === 'KeyS') {
          event.preventDefault();
          onSelect('projectSettings');
        }
        return;
      }
      const key = event.key.toLowerCase();
      let id: RailTab | undefined;
      if (key === 'p' && !event.shiftKey) {
        id = 'pages';
      } else if (key === 'z' && !event.shiftKey) {
        id = 'navigator';
      } else if (key === 'a' && event.shiftKey) {
        id = 'components';
      } else if (key === 'k' && !event.shiftKey && componentOpen) {
        id = 'properties';
      } else if (key === 'j' && !event.shiftKey) {
        id = 'assets';
      } else if (key === 'c' && !event.shiftKey) {
        id = 'code';
      } else if (key === 'g' && !event.shiftKey) {
        id = 'selectors';
      } else if (key === 'e' && !event.shiftKey) {
        // E alone: ⌘E is the insert palette's (appKeys.ts) and is skipped above.
        id = 'apps';
      }
      if (id) {
        event.preventDefault();
        onSelect(id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSelect, componentOpen]);
}
