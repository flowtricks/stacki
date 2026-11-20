// The frame of the Settings rail panel, shared by Desktop and hosted Studio. Its root is a short list of links,
// one per view (Secrets, MCP, Instructions), each a full-width row with its icon, its name and a chevron. A
// link replaces the panel with that view, under a header with a back button and the view's title, the way the
// Collections panel's item view opens. Back, or Escape outside a field, returns to the root; the panel always
// opens on the root unless something asked for a view (the Instructions shortcut, a link to an instruction
// file: requestSettingsSection). A view with foldable sections (Instructions) also gets the panel's usual
// header actions and a search box; the frame owns that search text, which sections the person folded
// (remembered per project), and the bulk fold and refresh requests. What a view draws is the caller's, because
// Desktop's views read files through the main process and Studio's cannot.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { isSearching } from '../../lib/searchText';
import {
  SETTINGS_VIEW_TITLE_KEYS,
  loadFoldedSections,
  publishSettingsView,
  saveFoldedSections,
  sectionsOfView,
  settingsRequestSerial,
  subscribeSettingsRequests,
  takeSettingsRequest,
  viewOfTarget,
  type SettingsBulkRequest,
  type SettingsSectionId,
  type SettingsSectionsContext,
  type SettingsViewId,
} from '../../lib/settingsSections';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { ChevronRightIcon, CollapseVerticalIcon, ExpandVerticalIcon, InstructionsIcon, LockIcon, PlugIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import { centralIcon } from '../../ui/central/CentralIcon';
import { roles as centralRoles } from '../../ui/central/centralGeometry';
import { PanelSearch } from '../../ui/PanelSearch';
import './projectSettings.css';
import { PanelHeader } from '../../ui/PanelHeader';

export interface ProjectSettingsShellProps {
  /** What the folded sections are remembered under: Desktop's project path, Studio's `studio`. */
  readonly projectKey: string;
  /** The views this host and role list on the root, in order. */
  readonly views: readonly SettingsViewId[];
  /** What the open view draws; a foldable view draws its sections through the context. */
  readonly renderView: (view: SettingsViewId, context: SettingsSectionsContext) => ReactNode;
  /** Called when the person leaves a view by Back or Escape, so a view that opened something elsewhere can close it. */
  readonly onLeaveView?: ((view: SettingsViewId) => void) | undefined;
  /** The chord that opens each view, shown muted on its root row; a host with none leaves it out. */
  readonly shortcuts?: Readonly<Partial<Record<SettingsViewId, string>>> | undefined;
  /** Whether the menu offers Refresh: only a host whose views read from disk has anything to read again. */
  readonly refreshable: boolean;
}

const RolesIcon = centralIcon(centralRoles);
const LINK_ICONS = { secrets: LockIcon, mcp: PlugIcon, instructions: InstructionsIcon, roles: RolesIcon } as const satisfies Record<
  SettingsViewId,
  typeof LockIcon
>;

const NO_REPORTS: Readonly<Partial<Record<SettingsSectionId, number | undefined>>> = {};

export default function ProjectSettingsShell({ projectKey, views, renderView, refreshable, onLeaveView, shortcuts }: ProjectSettingsShellProps) {
  assert(views.length > 0, 'The Settings panel lists at least one view');
  const translate = useTranslate();
  const [view, setView] = useState<SettingsViewId | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [folded, setFolded] = useState<ReadonlySet<SettingsSectionId>>(() => loadFoldedSections(projectKey));
  const [bulk, setBulk] = useState<SettingsBulkRequest>({ serial: 0, mode: undefined });
  const [refreshSerial, setRefreshSerial] = useState(0);
  const [reports, setReports] = useState(NO_REPORTS);
  const [scrollTarget, setScrollTarget] = useState<SettingsSectionId | undefined>(undefined);
  const searching = isSearching(query);

  const show = useCallback((next: SettingsViewId | undefined): void => {
    setQuery('');
    setReports(NO_REPORTS);
    setView(next);
  }, []);
  // Back and Escape return to the root and tell the host which view was left; opening a view does not.
  const leave = (): void => {
    if (view !== undefined) {
      onLeaveView?.(view);
    }
    show(undefined);
  };
  // A shortcut asks which view is showing; the panel closing is no view.
  useEffect(() => {
    publishSettingsView(view);
    return () => publishSettingsView(undefined);
  }, [view]);
  const persist = useCallback(
    (next: ReadonlySet<SettingsSectionId>): void => {
      setFolded(next);
      saveFoldedSections(projectKey, next);
    },
    [projectKey],
  );
  const toggle = useCallback(
    (id: SettingsSectionId): void => {
      const next = new Set(folded);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      persist(next);
    },
    [folded, persist],
  );
  const open = useCallback(
    (id: SettingsSectionId): void => {
      if (folded.has(id)) {
        persist(new Set([...folded].filter((each) => each !== id)));
      }
    },
    [folded, persist],
  );
  const report = useCallback((id: SettingsSectionId, matches: number | undefined): void => {
    setReports((current) => (current[id] === matches ? current : { ...current, [id]: matches }));
  }, []);
  const clearSearch = useCallback((): void => setQuery(''), []);

  // A request to open Settings at a view: another part of the app asked (a shortcut, a link to a file).
  const requestSerial = useSyncExternalStore(subscribeSettingsRequests, settingsRequestSerial, settingsRequestSerial);
  // The request is read as the panel stands when it arrives, so the effect depends on the request alone.
  const standing = useRef({ folded, views });
  standing.current = { folded, views };
  useEffect(() => {
    const target = takeSettingsRequest();
    if (target === undefined) {
      return;
    }
    const wanted = viewOfTarget(target);
    if (!standing.current.views.includes(wanted.view)) {
      return;
    }
    show(wanted.view);
    persist(new Set([...standing.current.folded].filter((id) => !wanted.open.includes(id))));
    setScrollTarget(wanted.scrollTo);
  }, [requestSerial, persist, show]);
  useEffect(() => {
    if (scrollTarget === undefined) {
      return;
    }
    document.querySelector(`[data-panel-section="${scrollTarget}"]`)?.scrollIntoView?.({ block: 'nearest' });
    setScrollTarget(undefined);
  }, [scrollTarget]);

  const sections = view === undefined ? [] : sectionsOfView(view);
  const anyOpen = sections.some((id) => !folded.has(id));
  const expandAll = (): void => {
    persist(new Set());
    setBulk((current) => ({ serial: current.serial + 1, mode: 'expand' }));
  };
  const collapseAll = (): void => {
    persist(new Set(sections));
    setBulk((current) => ({ serial: current.serial + 1, mode: 'collapse' }));
  };

  const context = useMemo<SettingsSectionsContext>(
    () => ({ query, searching, refreshSerial, bulk, isOpen: (id) => searching || !folded.has(id), toggle, open, report, clearSearch }),
    [query, searching, refreshSerial, bulk, folded, toggle, open, report, clearSearch],
  );

  if (view === undefined) {
    return (
      <div className="panel-section grow settings-panel">
        <PanelHeader title={translate('settings.title')} />
        <div className="panel-body settings-body" role="list" aria-label={translate('settings.sections')}>
          {views.map((id) => {
            const Icon = LINK_ICONS[id];
            return (
              <button key={id} type="button" role="listitem" className="list-item settings-link" onClick={() => show(id)}>
                <span className="icon">
                  <Icon size={14} />
                </span>
                <span className="label">{translate(SETTINGS_VIEW_TITLE_KEYS[id])}</span>
                {shortcuts?.[id] !== undefined && <span className="settings-link-key">{shortcuts[id]}</span>}
                <ChevronRightIcon size={12} />
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  const noMatch = searching && sections.length > 0 && sections.every((id) => reports[id] === 0);
  return (
    <div
      className="panel-section grow settings-panel"
      onKeyDown={(event) => {
        // Escape leaves the view, unless a field or a menu has it (a form's own Escape cancels the form).
        const target = event.target;
        const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
        if (event.key === 'Escape' && !event.defaultPrevented && !typing) {
          leave();
        }
      }}
    >
      <PanelHeader
        back={{ label: translate('settings.back'), onBack: leave }}
        title={translate(SETTINGS_VIEW_TITLE_KEYS[view])}
        actions={
          sections.length > 0 && (
            <>
              <button
                type="button"
                className="ghost"
                title={anyOpen ? translate('settings.collapseAll') : translate('settings.expandAll')}
                aria-label={anyOpen ? translate('settings.collapseAll') : translate('settings.expandAll')}
                onClick={anyOpen ? collapseAll : expandAll}
              >
                {anyOpen ? <CollapseVerticalIcon size={13} /> : <ExpandVerticalIcon size={13} />}
              </button>
              <MoreMenu
                className="ghost"
                title={translate('settings.options')}
                width={170}
                items={[
                  { label: translate('settings.expandAll'), onSelect: expandAll },
                  { label: translate('settings.collapseAll'), onSelect: collapseAll },
                  refreshable && { label: translate('settings.refresh'), onSelect: () => setRefreshSerial((count) => count + 1) },
                ]}
              />
            </>
          )
        }
      />
      {sections.length > 0 && <PanelSearch value={query} placeholder={translate('settings.instructions.search.placeholder')} onChange={setQuery} />}
      <div className={sections.length > 0 ? 'panel-body settings-body' : 'panel-body settings-detail'}>
        {renderView(view, context)}
        {noMatch && <div className="props-empty">{translate('settings.instructions.search.noMatch')}</div>}
      </div>
    </div>
  );
}
