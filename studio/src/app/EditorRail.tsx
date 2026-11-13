import type { MessageKey } from '../../vendor/stacki/src/lib/i18n/localeContext';
import { useTranslate } from '../../vendor/stacki/src/lib/i18n/useTranslate';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { canStudioPanel } from '../features/roles/roleStore';
import { useStudioRole } from '../features/roles/useEditorRole';
import type { AppSummary } from '../../vendor/stacki/shared/properties/apps';
import { FEATURE_ICONS } from '../../vendor/stacki/src/app/featureIcons';
import { AppsRailBadge } from '../../vendor/stacki/src/features/apps/appUpdates';
import { AppTile } from '../../vendor/stacki/src/features/apps/AppTile';
import { RailAppFace, openPinnedApp, railAppId, usePinnedRailApps, useShownPinnedApp } from '../../vendor/stacki/src/app/railApps';
import { RailMore, type RailMoreItem } from '../../vendor/stacki/src/app/RailMore';
import { useRailOverflow, type RailOverflowItem } from '../../vendor/stacki/src/app/railOverflow';

// Each button draws its access feature's icon (featureIcons.tsx), shared with Desktop's
// rail and the Roles permission grid, so none of them can drift apart. As on Desktop,
// the apps the role pinned follow the panels after a line (railApps.tsx), and what a
// short window has no room for moves into a More menu (railOverflow.ts); the AI
// button stays anchored at the foot.
const panels = [
  { id: 'pages', labelKey: 'rail.pages', shortcut: 'P', Icon: FEATURE_ICONS['panel:pages'] },
  { id: 'navigator', labelKey: 'rail.navigator', shortcut: 'Z', Icon: FEATURE_ICONS['panel:navigator'] },
  { id: 'properties', labelKey: 'rail.properties', shortcut: 'K', Icon: FEATURE_ICONS['panel:properties'] },
  { id: 'components', labelKey: 'rail.components', shortcut: '⇧A', Icon: FEATURE_ICONS['panel:components'] },
  { id: 'assets', labelKey: 'rail.assets', shortcut: 'J', Icon: FEATURE_ICONS['panel:assets'] },
  { id: 'collections', labelKey: 'rail.collections', shortcut: '⌥C', Icon: FEATURE_ICONS['panel:cms'] },
  { id: 'variables', labelKey: 'rail.variables', shortcut: '⌥V', Icon: FEATURE_ICONS['panel:variables'] },
  { id: 'code', labelKey: 'rail.code', shortcut: 'C', Icon: FEATURE_ICONS['panel:code'] },
  { id: 'history', labelKey: 'rail.history', shortcut: '⌥H', Icon: FEATURE_ICONS['panel:history'] },
  { id: 'apps', labelKey: 'rail.apps', shortcut: 'E', Icon: FEATURE_ICONS['panel:apps'] },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly shortcut: string; readonly Icon: unknown }[];
export type Panel = (typeof panels)[number]['id'] | 'ai';
interface Props {
  readonly componentOpen: boolean;
  readonly panel: Panel | undefined;
  readonly toggle: (panel: Panel | undefined) => void;
  /** The project the apps are installed in (Studio names it), for the role's pinned apps. */
  readonly projectPath?: string | undefined;
}

export function EditorRail({ panel, toggle, componentOpen, projectPath }: Props) {
  const translate = useTranslate();
  const role = useStudioRole();
  const [tip, setTip] = useState<{ label: string; left: number; top: number }>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const railRef = useRef<HTMLElement>(null);
  const anchoredRef = useRef<HTMLButtonElement>(null);
  const hide = () => {
    clearTimeout(timer.current);
    setTip(undefined);
  };
  const select = (next: Panel) => {
    hide();
    toggle(panel === next ? undefined : next);
  };
  const showSoon = (label: string) => (event: MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip({ label, left: rect.right + 10, top: rect.top + rect.height / 2 }), 500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useRailKeys({ panel, toggle, componentOpen });
  const shownPanels = panels.filter(({ id }) => (id !== 'properties' || componentOpen) && canStudioPanel(role, id));
  const pinned = usePinnedRailApps(projectPath, role, panel);
  // A pinned app the open Apps panel shows is the active button, in place of Apps itself.
  const shownApp = useShownPinnedApp(role, panel === 'apps' ? 'open' : 'closed');
  const activeApp = pinned.find((app) => app.manifest.id === shownApp);
  const activeId = activeApp === undefined ? panel : railAppId(activeApp.manifest.id);
  const items: readonly RailOverflowItem[] = [
    ...shownPanels.map((item): RailOverflowItem => ({ id: item.id, group: 'panel' })),
    ...pinned.map((app): RailOverflowItem => ({ id: railAppId(app.manifest.id), group: 'app' })),
  ];
  const ai = canStudioPanel(role, 'ai');
  const layout = useRailOverflow(railRef, ai ? anchoredRef : undefined, items, activeId);
  const shown = new Set(layout.visible);
  const visiblePanels = shownPanels.filter((item) => shown.has(item.id));
  const visibleApps = pinned.filter((app) => shown.has(railAppId(app.manifest.id)));
  const selectApp = (app: AppSummary) => {
    hide();
    if (app === activeApp) {
      // Like the active panel's button, the shown app's collapses the panel.
      toggle(undefined);
    } else if (projectPath !== undefined) {
      openPinnedApp(projectPath, app);
    }
  };
  const moreItems: readonly RailMoreItem[] = [
    ...shownPanels
      .filter((item) => !shown.has(item.id))
      .map(({ id, labelKey, shortcut, Icon }): RailMoreItem => ({
        id,
        label: translate(labelKey),
        icon: <Icon size={16} />,
        shortcut,
        select: () => select(id),
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
  return (
    <nav className="rail studio-rail" aria-label={translate('rail.editorPanels')} ref={railRef}>
      {visiblePanels.map(({ id, labelKey, shortcut, Icon }) => (
        <button
          key={id}
          aria-label={translate(labelKey)}
          aria-pressed={activeId === id}
          className={`rail-btn ${activeId === id ? 'on' : ''}`}
          onMouseEnter={showSoon(translate('rail.withShortcut', { label: translate(labelKey), shortcut }))}
          onMouseLeave={hide}
          onBlur={hide}
          onClick={() => select(id)}
        >
          <Icon size={20} />
          {id === 'apps' && <AppsRailBadge admin={role.isAdmin} />}
        </button>
      ))}
      {visiblePanels.length > 0 && visibleApps.length > 0 && <div className="rail-separator" role="separator" />}
      {visibleApps.map((app) => {
        const id = railAppId(app.manifest.id);
        return (
          <button
            key={id}
            aria-label={app.manifest.name}
            aria-pressed={activeId === id}
            className={`rail-btn rail-app ${activeId === id ? 'on' : ''}`}
            onMouseEnter={showSoon(app.manifest.name)}
            onMouseLeave={hide}
            onBlur={hide}
            onClick={() => selectApp(app)}
          >
            <RailAppFace app={app} />
          </button>
        );
      })}
      {moreItems.length > 0 && <RailMore items={moreItems} active={activeId} />}
      <div className="rail-spacer" />
      {ai && (
        <button
          ref={anchoredRef}
          className={`rail-btn ai-icon ${panel === 'ai' ? 'on' : ''}`}
          aria-label={translate('rail.ai')}
          aria-pressed={panel === 'ai'}
          title={translate('rail.ai')}
          onClick={() => select('ai')}
        >
          ✦
        </button>
      )}
      {tip && (
        <div role="tooltip" className="rail-tooltip" style={{ left: tip.left, top: tip.top }}>
          {tip.label}
        </div>
      )}
    </nav>
  );
}

function useRailKeys({ panel, toggle, componentOpen }: Props) {
  const role = useStudioRole();
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.repeat ||
        (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable=true], .cm-editor, [role=dialog]'))
      ) {
        return;
      }
      let next: Panel | undefined;
      if (event.altKey && !event.shiftKey) {
        if (event.code === 'KeyC') {
          next = 'collections';
        }
        if (event.code === 'KeyH') {
          next = 'history';
        }
        if (event.code === 'KeyV') {
          next = 'variables';
        }
      } else if (!event.altKey) {
        const value = event.key.toLowerCase();
        if (event.shiftKey && value === 'a') {
          next = 'components';
        }
        if (!event.shiftKey) {
          if (value === 'k' && componentOpen) {
            next = 'properties';
          }
          if (value === 'p') {
            next = 'pages';
          }
          if (value === 'z') {
            next = 'navigator';
          }
          if (value === 'j') {
            next = 'assets';
          }
          if (value === 'c') {
            next = 'code';
          }
          if (value === 'e') {
            next = 'apps';
          }
        }
      }
      if (next && canStudioPanel(role, next)) {
        event.preventDefault();
        toggle(panel === next ? undefined : next);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [panel, toggle, componentOpen, role]);
}
