// The Settings rail panel: a list of tabs on the left, the open tab's content on the right. It is
// the project's own settings (its secrets and MCP servers), not the app's Settings screen
// (src/app/settings), which opens from the menu. Tabs are registered in settingsTabs.ts.
import { useEffect, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { requestPanelWidth } from '../../ui/panelWidthRequests';
import { ChevronRightIcon } from '../../ui/Icons';
import McpTab from './McpTab';
import SecretsTab from './SecretsTab';
import { PROJECT_SETTINGS_TABS, PROJECT_SETTINGS_TAB_DEFAULT, type ProjectSettingsTabId } from './settingsTabs';
import './projectSettings.css';

// The tab list and a row of secrets need more than the shared 260px left width.
const PANEL_WIDTH_PX = 560;

export default function ProjectSettingsPanel({ projectPath }: { readonly projectPath: string }) {
  const translate = useTranslate();
  const [tab, setTab] = useState<ProjectSettingsTabId>(PROJECT_SETTINGS_TAB_DEFAULT);
  useEffect(() => requestPanelWidth('left', { widthPx: PANEL_WIDTH_PX, onResize: () => {} }), []);
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
        <div className="project-settings-content">
          <TabContent tab={tab} projectPath={projectPath} />
        </div>
      </div>
    </div>
  );
}

function TabContent({ tab, projectPath }: { readonly tab: ProjectSettingsTabId; readonly projectPath: string }) {
  assert(
    PROJECT_SETTINGS_TABS.some((entry) => entry.id === tab),
    'The open tab is a registered tab',
  );
  switch (tab) {
    case 'secrets':
      // Keyed by project: switching projects drops every revealed value with the tab's state.
      return <SecretsTab key={projectPath} projectPath={projectPath} />;
    case 'mcp':
      // Keyed by project: switching projects drops any unsaved form with the tab's state.
      return <McpTab key={projectPath} projectPath={projectPath} />;
    default: {
      const exhaustive: never = tab;
      return exhaustive;
    }
  }
}
