// The renderer's side of MCP server sign-in (shared/properties/mcp.ts): each request is checked before it leaves,
// each reply and push before anything sees it. A host without the channel (Studio, an app that predates it) has
// no sign-in to offer, so nothing is drawn there rather than a button that cannot work.
import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseMcpAuthPush, parseMcpAuthReply, type McpAuthPush, type McpAuthReply, type McpAuthRequest } from '../../shared/properties/mcp';

export function canSignInToServers(): boolean {
  const bridge: unknown = Reflect.get(globalThis, 'window');
  if (typeof bridge !== 'object' || bridge === null) {
    return false;
  }
  return typeof window.avb?.aiMcpAuth === 'function' && typeof window.avb.onAiMcpAuth === 'function';
}

/** The reply, or undefined when main could not answer (the caller keeps what it knew and may ask again). */
export async function requestMcpAuth(projectPath: string, request: McpAuthRequest): Promise<McpAuthReply | undefined> {
  const payload = parseIpcPayload('ai:mcpAuth', { projectPath, request });
  try {
    return parseMcpAuthReply(await window.avb.aiMcpAuth(payload));
  } catch (error: unknown) {
    console.error('[mcp-sign-in] the request was not answered:', error);
    return undefined;
  }
}

export function onMcpAuth(callback: (push: McpAuthPush) => void): () => void {
  return window.avb.onAiMcpAuth((input) => {
    let push: McpAuthPush;
    try {
      push = parseMcpAuthPush(input);
    } catch (error: unknown) {
      console.error('[mcp-sign-in] refused a push:', error);
      return;
    }
    callback(push);
  });
}
