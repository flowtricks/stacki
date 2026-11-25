import type { MessageKey } from '../../vendor/stacki/src/lib/i18n/localeContext';
import { railActionOf, shortcutOf } from '../../vendor/stacki/src/app/railShortcuts';
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
  { id: 'pages', labelKey: 'rail.pages', shortcut: shortcutOf('pages'), Icon: FEATURE_ICONS['panel:pages'] },
  { id: 'navigator', labelKey: 'rail.navigator', shortcut: shortcutOf('navigator'), Icon: FEATURE_ICONS['panel:navigator'] },
  { id: 'properties', labelKey: 'rail.properties', shortcut: shortcutOf('properties'), Icon: FEATURE_ICONS['panel:properties'] },
  { id: 'components', labelKey: 'rail.components', shortcut: shortcutOf('components'), Icon: FEATURE_ICONS['panel:components'] },
  { id: 'assets', labelKey: 'rail.assets', shortcut: shortcutOf('assets'), Icon: FEATURE_ICONS['panel:assets'] },
  { id: 'collections', labelKey: 'rail.collections', shortcut: shortcutOf('cms'), Icon: FEATURE_ICONS['panel:cms'] },
  { id: 'variables', labelKey: 'rail.variables', shortcut: shortcutOf('variables'), Icon: FEATURE_ICONS['panel:variables'] },
  { id: 'code', labelKey: 'rail.code', shortcut: shortcutOf('code'), Icon: FEATURE_ICONS['panel:code'] },
  { id: 'history', labelKey: 'rail.history', shortcut: shortcutOf('history'), Icon: FEATURE_ICONS['panel:history'] },
  { id: 'apps', labelKey: 'rail.apps', shortcut: shortcutOf('apps'), Icon: FEATURE_ICONS['panel:apps'] },
] as const satisfies readonly { readonly id: string; readonly labelKey: MessageKey; readonly shortcut: string; readonly Icon: unknown }[];
// The project's Settings sits at the foot above the AI button, as on Desktop (LeftRail.tsx), gated by the
// same `panel:projectSettings` feature (admin until a role is given it) and never moved into More.
const SETTINGS_PANEL = {
  id: 'projectSettings',
  labelKey: 'rail.settings',
  shortcut: shortcutOf('projectSettings'),
  Icon: FEATURE_ICONS['panel:projectSettings'],
} as const;
export type Panel = (typeof panels)[number]['id'] | 'ai' | typeof SETTINGS_PANEL.id;
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
  const anchoredRef = useRef<HTMLDivElement>(null);
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
  const settings = canStudioPanel(role, SETTINGS_PANEL.id);
  const layout = useRailOverflow(railRef, ai || settings ? anchoredRef : undefined, items, activeId);
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
      {(ai || settings) && (
        // Anchored at the foot like Desktop's: these never move into More (railOverflow.ts measures the pair).
        <div className="rail-anchor" ref={anchoredRef}>
          {settings && (
            <button
              aria-label={translate(SETTINGS_PANEL.labelKey)}
              aria-pressed={panel === SETTINGS_PANEL.id}
              className={`rail-btn ${panel === SETTINGS_PANEL.id ? 'on' : ''}`}
              onMouseEnter={showSoon(translate('rail.withShortcut', { label: translate(SETTINGS_PANEL.labelKey), shortcut: SETTINGS_PANEL.shortcut }))}
              onMouseLeave={hide}
              onBlur={hide}
              onClick={() => select(SETTINGS_PANEL.id)}
            >
              <SETTINGS_PANEL.Icon size={20} />
            </button>
          )}
          {ai && (
            <button
              className={`rail-btn ai-icon ${panel === 'ai' ? 'on' : ''}`}
              aria-label={translate('rail.ai')}
              aria-pressed={panel === 'ai'}
              onMouseEnter={showSoon(translate('rail.withShortcut', { label: translate('rail.ai'), shortcut: shortcutOf('ai') }))}
              onMouseLeave={hide}
              onBlur={hide}
              onClick={() => select('ai')}
            >
              ✦
            </button>
          )}
        </div>
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
      const action = railActionOf(event)?.action;
      // Studio's rail has some of Desktop's panels; the CMS is its `collections`. Properties has a key only while a component is open.
      const id = action === 'cms' ? 'collections' : action;
      let next: Panel | undefined = [...panels, SETTINGS_PANEL].find((item) => item.id === id)?.id;
      if (id === 'ai') {
        next = 'ai';
      }
      if (next === 'properties' && !componentOpen) {
        next = undefined;
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
