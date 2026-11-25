// The Settings rail panel on Desktop, composed here because it draws the sections of two features that may not
// import each other: the project's Secrets and MCP (features/projectSettings) and its Instructions, the skills,
// rules and docs that used to have a panel of their own (features/instructions). The frame, the search and the
// folding are the first feature's; this file only tells it which views the person's role may open and how to
// draw the Instructions one. A role with only `panel:instructions` sees Settings with just that link.
// The root's rows are the rail order's Settings list (SettingsRailRows.tsx): reorderable, and shared with the rail.
import { settingsViewsOf } from '../../lib/roleAccess';
import { selectInstruction } from '../../features/instructions/instructionSelection';
import { shortcutOf } from '../railShortcuts';
import { useCurrentRole } from '../../lib/useCurrentRole';
import InstructionsSections from '../../features/instructions/InstructionsSections';
import ProjectSettingsPanel from '../../features/projectSettings/ProjectSettingsPanel';
import { AgentsSettings } from '../settings/AgentsSettings';
import { SettingsRailRows } from '../SettingsRailRows';
import type { RailPanelId } from '../railItems';

export default function DesktopSettings({
  projectPath,
  showToast,
  onOpenPanel,
  componentOpen,
}: {
  readonly projectPath: string;
  readonly showToast: (message: string, kind?: 'info' | 'success' | 'warning' | 'error') => void;
  /** Opens a rail panel a person moved into Settings, in the panel area. */
  readonly onOpenPanel: (panel: RailPanelId) => void;
  readonly componentOpen: boolean;
}) {
  const views = settingsViewsOf(useCurrentRole());
  return (
    <ProjectSettingsPanel
      projectPath={projectPath}
      views={views}
      // Back closes the instruction opened from the list, as its own close button does: its edits are saved as it unmounts.
      onLeaveView={(view) => {
        if (view === 'instructions') {
          selectInstruction(undefined);
        }
      }}
      shortcuts={{ secrets: shortcutOf('secrets'), mcp: shortcutOf('mcp'), instructions: shortcutOf('instructions'), agents: shortcutOf('agents') }}
      renderInstructions={(context) => <InstructionsSections projectPath={projectPath} context={context} showToast={showToast} />}
      // The Agents view: the project's agent definitions; one opens in the Instructions editor over the canvas.
      renderAgents={() => <AgentsSettings projectPath={projectPath} />}
      renderRoot={(show) => <SettingsRailRows show={show} onOpenPanel={onOpenPanel} componentOpen={componentOpen} />}
    />
  );
}
