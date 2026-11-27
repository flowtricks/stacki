// The AI panel's route to a server sign-in: above the composer, the MCP servers this chat's agent cannot use
// until the person signs in, each with its Sign in button, so nobody has to find the settings tab or a terminal.
// It asks when a chat opens, and again when the chat reaches for a server's sign-in (Claude offers a
// `mcp__<server>__authenticate` tool for one it cannot use) or a server's tool fails. Nothing is shown, and
// nothing asked, while the agent may not run here.
import { useEffect } from 'react';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { McpSignInControl, useMcpSignInAllowed, useMcpSignInToasts } from '../../ui/mcpSignIn/McpSignInControl';
import { loadMcpSignIns, useMcpSignInEntries } from '../../ui/mcpSignIn/mcpSignInStore';
import type { TranscriptItem } from './chatReducer';

/** Rows shown at once; the settings tab lists every server. */
const CARD_ROWS_MAX = 3;

/** How many times the chat has met a server it could not use: a change is a reason to ask again. */
export function serverRefusals(items: readonly TranscriptItem[]): number {
  return items.filter((item) => {
    if (item.kind !== 'tool' || item.toolName?.startsWith('mcp__') !== true) {
      return false;
    }
    return item.status === 'failed' || item.toolName.endsWith('__authenticate');
  }).length;
}

export function McpSignInCard({
  projectPath,
  agent,
  items,
  eligible,
}: {
  readonly projectPath: string;
  readonly agent: AgentId;
  readonly items: readonly TranscriptItem[];
  /** The agent is installed and allowed in this project, so its servers may be asked about. */
  readonly eligible: boolean;
}) {
  const allowed = useMcpSignInAllowed();
  const active = allowed && eligible;
  useMcpSignInToasts();
  const refusals = serverRefusals(items);
  useEffect(() => {
    if (active) {
      void loadMcpSignIns(projectPath, refusals === 0 ? 'cached' : 'fresh');
    }
  }, [active, projectPath, agent, refusals]);
  const waiting = useMcpSignInEntries(projectPath)
    .filter((entry) => entry.agent === agent && (entry.state === 'needs-sign-in' || entry.state === 'signing-in'))
    .slice(0, CARD_ROWS_MAX);
  if (!active || waiting.length === 0) {
    return undefined;
  }
  return (
    <div className="ai-mcp-signins">
      {waiting.map((entry) => (
        <McpSignInControl key={entry.name} projectPath={projectPath} entry={entry} label={entry.name} />
      ))}
    </div>
  );
}
