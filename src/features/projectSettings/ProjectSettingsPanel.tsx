// The Settings rail panel on Desktop: the shared frame (ProjectSettingsShell.tsx) with the project's own views.
// Secrets and MCP read and write files through the main process; the Instructions view belongs to another
// feature, which features may not import, so the app layer hands it in (src/app/shell/DesktopSettings.tsx).
// Not the app's Settings screen (src/app/settings), which opens from the menu. Hosted Studio draws the same
// frame with views of its own, because it has no main process to ask.
import type { ReactNode } from 'react';
import type { SettingsSectionsContext, SettingsViewId } from '../../lib/settingsSections';
import McpTab from './McpTab';
import ProjectSettingsShell from './ProjectSettingsShell';
import SecretsTab from './SecretsTab';

export interface ProjectSettingsPanelProps {
  readonly projectPath: string;
  /** The views the person's role may open, in the order the root lists them. */
  readonly views: readonly SettingsViewId[];
  /** Closes what a view opened in the main area when the person leaves it by Back or Escape. */
  readonly onLeaveView?: ((view: SettingsViewId) => void) | undefined;
  /** The chord that opens each view, shown on its root row. */
  readonly shortcuts?: Readonly<Partial<Record<SettingsViewId, string>>> | undefined;
  /** Draws the Instructions view's sections; called only for that view. */
  readonly renderInstructions: (context: SettingsSectionsContext) => ReactNode;
  /** Draws the Agents view (Settings > Agents, from the app layer); called only for that view. */
  readonly renderAgents?: (() => ReactNode) | undefined;
  /** Draws the root's rows (the app layer's reorderable list); the plain list of `views` when absent. */
  readonly renderRoot?: ((show: (view: SettingsViewId) => void) => ReactNode) | undefined;
}

export default function ProjectSettingsPanel({
  projectPath,
  views,
  renderInstructions,
  renderAgents,
  renderRoot,
  onLeaveView,
  shortcuts,
}: ProjectSettingsPanelProps) {
  return (
    // Keyed by project: switching projects drops every revealed value, unsaved form and search with the panel's state.
    <ProjectSettingsShell
      key={projectPath}
      projectKey={projectPath}
      views={views}
      refreshable
      onLeaveView={onLeaveView}
      shortcuts={shortcuts}
      renderRoot={renderRoot}
      renderView={(view, context) => {
        switch (view) {
          case 'secrets':
            return <SecretsTab projectPath={projectPath} />;
          case 'mcp':
            return <McpTab projectPath={projectPath} />;
          case 'instructions':
            return renderInstructions(context);
          case 'agents':
            return renderAgents?.();
          case 'roles':
            // Desktop's Roles are in its Settings dialog; its root never lists this view.
            return undefined;
          default: {
            const exhaustive: never = view;
            return exhaustive;
          }
        }
      }}
    />
  );
}
