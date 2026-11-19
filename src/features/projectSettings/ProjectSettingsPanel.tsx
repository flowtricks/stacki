// The Settings rail panel on Desktop: the shell (ProjectSettingsShell.tsx) with the project's own tabs, its
// secrets and MCP servers, which read and write files through the main process. Not the app's Settings screen
// (src/app/settings), which opens from the menu. Tabs are registered in settingsTabs.ts. Hosted Studio draws the
// same shell with its own tab content, because it has no main process to ask.
import { assert } from '../../../shared/core/assert';
import McpTab from './McpTab';
import ProjectSettingsShell from './ProjectSettingsShell';
import SecretsTab from './SecretsTab';
import { PROJECT_SETTINGS_TABS, type ProjectSettingsTabId } from './settingsTabs';

export default function ProjectSettingsPanel({ projectPath }: { readonly projectPath: string }) {
  return <ProjectSettingsShell renderTab={(tab) => <TabContent tab={tab} projectPath={projectPath} />} />;
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
