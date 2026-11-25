// Settings > Agents and the AI panel's agent choice ask main through these calls
// (shared/ipc/projectAgentChannels.ts): each payload is checked before it leaves and each
// answer is parsed before use. A main process that predates the channels has no
// `listAgents` on the bridge; that reads as `AgentsUnavailableError`, so the panel
// can say "restart Stacki" instead of showing a failed read.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import type { AgentId } from '../../shared/properties/ai/agentIds';
import {
  parseAgentListing,
  parseAgentWriteResult,
  type AgentDeleteTarget,
  type AgentFields,
  type AgentListing,
  type AgentWriteResult,
} from '../../shared/properties/projectAgents';

export class AgentsUnavailableError extends Error {
  // A field, as mcpBridge.ts and secretsBridge.ts name theirs: readonly, and never read as an edit of a page node.
  override readonly name = 'AgentsUnavailableError';
  constructor() {
    super('Restart Stacki to manage agents.');
  }
}

function bridgeHasAgents(): boolean {
  return typeof Reflect.get(window.avb, 'listAgents') === 'function';
}

export async function listProjectAgents(projectPath: string): Promise<AgentListing> {
  if (!bridgeHasAgents()) {
    throw new AgentsUnavailableError();
  }
  const input = parseIpcPayload('agents:list', { projectPath });
  return parseAgentListing(await window.avb.listAgents(input));
}

export async function saveProjectAgent(
  projectPath: string,
  request: { readonly fields: AgentFields; readonly mode: 'create' | 'update'; readonly overwrite: readonly AgentId[] },
): Promise<AgentWriteResult> {
  if (!bridgeHasAgents()) {
    throw new AgentsUnavailableError();
  }
  const input = parseIpcPayload('agents:save', { projectPath, ...request });
  return parseAgentWriteResult(await window.avb.saveAgent(input));
}

export async function deleteProjectAgent(projectPath: string, target: AgentDeleteTarget): Promise<AgentWriteResult> {
  if (!bridgeHasAgents()) {
    throw new AgentsUnavailableError();
  }
  const input = parseIpcPayload('agents:delete', { projectPath, target });
  return parseAgentWriteResult(await window.avb.deleteAgent(input));
}

// The Settings tab and the AI panel are separate trees; a write in one lists the other again.
type AgentsListener = () => void;
const listeners = new Set<AgentsListener>();
/** One window has one Settings tab and one AI panel; a handful of listeners at most. */
const LISTENERS_MAX = 16;

/** Hears the app's own agent writes. Returns the unsubscribe. */
export function onProjectAgentsChanged(listener: AgentsListener): () => void {
  if (listeners.size >= LISTENERS_MAX) {
    throw new Error('Too many agents listeners');
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function announceProjectAgentsChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}
