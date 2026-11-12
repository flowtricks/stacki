// The MCP tab's calls to main (shared/properties/mcp.ts): each payload is checked before it leaves and each
// answer is parsed before use. A listing carries summaries only; a server's values come back from
// `revealMcpServer` alone, for a person who began editing it, and the file's text from `readMcpText` alone,
// for the JSON view.
import type { Digest } from '../../../shared/core/brand';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import {
  parseMcpCodexState,
  parseMcpConfigReply,
  parseMcpListing,
  parseMcpResult,
  parseMcpText,
  type McpChange,
  type McpCodexChange,
  type McpCodexState,
  type McpListing,
  type McpResult,
  type McpText,
} from '../../../shared/properties/mcp';
import type { McpServerConfig } from '../../../shared/properties/mcpConfig';

/**
 * The running app does not have the MCP channels: its main process or preload predates them (a development
 * app started before the update). Distinct from a read that failed, because the cure is a restart.
 */
export class McpUnavailableError extends Error {
  constructor() {
    super('The MCP channels are not available in this running app.');
    this.name = 'McpUnavailableError';
  }
}

// Runs a channel call, turning "not exposed by the preload" and "no handler in main" into McpUnavailableError.
async function call(exposed: unknown, run: () => Promise<unknown>): Promise<unknown> {
  if (typeof exposed !== 'function') {
    throw new McpUnavailableError();
  }
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof Error && /No handler registered/.test(error.message)) {
      throw new McpUnavailableError();
    }
    throw error;
  }
}

export async function readMcp(projectPath: string): Promise<McpResult<McpListing>> {
  const input = parseIpcPayload('mcp:read', { projectPath });
  return parseMcpResult(await call(window.avb.readMcp, () => window.avb.readMcp(input)), parseMcpListing);
}

export async function readMcpText(projectPath: string): Promise<McpResult<McpText>> {
  const input = parseIpcPayload('mcp:readText', { projectPath });
  return parseMcpResult(await call(window.avb.readMcpText, () => window.avb.readMcpText(input)), parseMcpText);
}

export async function revealMcpServer(projectPath: string, revision: Digest, name: string): Promise<McpResult<McpServerConfig>> {
  const input = parseIpcPayload('mcp:reveal', { projectPath, revision, name });
  return parseMcpResult(await call(window.avb.revealMcpServer, () => window.avb.revealMcpServer(input)), parseMcpConfigReply);
}

export async function applyMcpChange(projectPath: string, revision: Digest, change: McpChange): Promise<McpResult<McpListing>> {
  const input = parseIpcPayload('mcp:apply', { projectPath, revision, change });
  return parseMcpResult(await call(window.avb.applyMcpChange, () => window.avb.applyMcpChange(input)), parseMcpListing);
}

export async function saveMcpText(projectPath: string, revision: Digest, text: string): Promise<McpResult<McpListing>> {
  const input = parseIpcPayload('mcp:saveText', { projectPath, revision, text });
  return parseMcpResult(await call(window.avb.saveMcpText, () => window.avb.saveMcpText(input)), parseMcpListing);
}

export async function readMcpCodex(projectPath: string): Promise<McpCodexState> {
  const input = parseIpcPayload('mcp:readCodex', { projectPath });
  return parseMcpCodexState(await call(window.avb.readMcpCodex, () => window.avb.readMcpCodex(input)));
}

export async function revealMcpCodexServer(projectPath: string, revision: Digest, name: string): Promise<McpResult<McpServerConfig>> {
  const input = parseIpcPayload('mcp:revealCodex', { projectPath, revision, name });
  return parseMcpResult(await call(window.avb.revealMcpCodexServer, () => window.avb.revealMcpCodexServer(input)), parseMcpConfigReply);
}

export async function applyMcpCodexChange(
  projectPath: string,
  revision: Digest,
  projectRevision: Digest,
  change: McpCodexChange,
): Promise<McpResult<McpCodexState>> {
  const input = parseIpcPayload('mcp:applyCodex', { projectPath, revision, projectRevision, change });
  return parseMcpResult(await call(window.avb.applyMcpCodexChange, () => window.avb.applyMcpCodexChange(input)), parseMcpCodexState);
}
