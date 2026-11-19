// The frame of the Settings rail panel, shared by Desktop and hosted Studio: a title, the list of tabs on the
// left and the open tab's content on the right. The frame owns which tab is open and the panel width; what a
// tab shows is the caller's, because Desktop's tabs read files through the main process and Studio's cannot.
// One frame keeps the two editions looking and navigating the same.
import { useEffect, useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { requestPanelWidth } from '../../ui/panelWidthRequests';
import { ChevronRightIcon } from '../../ui/Icons';
import { PROJECT_SETTINGS_TABS, PROJECT_SETTINGS_TAB_DEFAULT, type ProjectSettingsTabId } from './settingsTabs';
import './projectSettings.css';

// The tab list and a row of secrets need more than the shared 260px left width.
const PANEL_WIDTH_PX = 560;

export default function ProjectSettingsShell({ renderTab }: { readonly renderTab: (tab: ProjectSettingsTabId) => ReactNode }) {
  const translate = useTranslate();
  const [tab, setTab] = useState<ProjectSettingsTabId>(PROJECT_SETTINGS_TAB_DEFAULT);
  useEffect(() => requestPanelWidth('left', { widthPx: PANEL_WIDTH_PX, onResize: () => {} }), []);
  assert(
    PROJECT_SETTINGS_TABS.some((entry) => entry.id === tab),
    'The open tab is a registered tab',
  );
  return (
    <div className="panel-section grow project-settings">
      <div className="panel-header">
        <h2>{translate('settings.title')}</h2>
      </div>
      <div className="project-settings-body">
        <nav className="project-settings-tabs" aria-label={translate('settings.sections')}>
          {PROJECT_SETTINGS_TABS.map(({ id, labelKey, Icon }) => (
            <button
              key={id}
              type="button"
              className={`project-settings-tab${tab === id ? ' on' : ''}`}
              aria-current={tab === id ? 'page' : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              <span>{translate(labelKey)}</span>
              {tab === id && <ChevronRightIcon size={12} />}
            </button>
          ))}
        </nav>
        <div className="project-settings-content">{renderTab(tab)}</div>
      </div>
    </div>
  );
}
