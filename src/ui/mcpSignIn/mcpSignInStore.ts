// What the window knows about MCP server sign-ins, shared by the MCP settings tab and the AI panel so both show
// one answer and one waiting sign-in. It holds only the open project's entries; main does the work. What
// happened (signed in, failed, cancelled) is a toast, with Try again where trying again can help. The toast's
// words need the interface language, so the component that is on screen gives the teller (`useMcpSignInToasts`).
import { useEffect, useSyncExternalStore } from 'react';
import type { McpAuthEntry, McpAuthNotice, McpAuthRequest } from '../../../shared/properties/mcp';
import type { AgentId } from '../../../shared/properties/ai/agentIds';
import { canSignInToServers, onMcpAuth, requestMcpAuth } from '../../ipc/mcpAuthBridge';

export type NoticeTeller = (notice: McpAuthNotice, entry: McpAuthEntry, projectPath: string) => void;

interface SignInStore {
  readonly projectPath: string | undefined;
  readonly entries: readonly McpAuthEntry[];
}

let store: SignInStore = { projectPath: undefined, entries: [] };
const listeners = new Set<() => void>();
let teller: NoticeTeller | undefined;
let unsubscribe: (() => void) | undefined;

function set(next: SignInStore): void {
  store = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

const sameServer = (left: McpAuthEntry, right: Pick<McpAuthEntry, 'agent' | 'name'>): boolean => left.agent === right.agent && left.name === right.name;

function put(entry: McpAuthEntry): void {
  const known = store.entries.some((existing) => sameServer(existing, entry));
  const entries = known ? store.entries.map((existing) => (sameServer(existing, entry) ? entry : existing)) : [...store.entries, entry];
  set({ ...store, entries });
}

/** Another project forgets the last one's answers. */
function enter(projectPath: string): void {
  unsubscribe ??= onMcpAuth((push) => {
    if (push.projectPath === store.projectPath) {
      put(push.entry);
      if (push.notice !== undefined) {
        teller?.(push.notice, push.entry, push.projectPath);
      }
    }
  });
  if (store.projectPath !== projectPath) {
    set({ projectPath, entries: [] });
  }
}

export async function loadMcpSignIns(projectPath: string, freshness: 'cached' | 'fresh'): Promise<void> {
  if (!canSignInToServers()) {
    return;
  }
  enter(projectPath);
  const reply = await requestMcpAuth(projectPath, { kind: 'list', freshness });
  if (reply !== undefined && store.projectPath === projectPath) {
    // The list is the whole truth, except for a sign-in that began while it was being read.
    const waiting = store.entries.filter((entry) => entry.state === 'signing-in' && !reply.servers.some((server) => sameServer(server, entry)));
    set({ projectPath, entries: [...reply.servers, ...waiting] });
  }
}

/** One step for one server; answers where it stands afterwards. */
export async function runMcpSignIn(projectPath: string, request: Exclude<McpAuthRequest, { readonly kind: 'list' }>): Promise<McpAuthEntry | undefined> {
  if (!canSignInToServers()) {
    return undefined;
  }
  enter(projectPath);
  const reply = await requestMcpAuth(projectPath, request);
  const entry = reply?.servers[0];
  if (reply === undefined || entry === undefined || store.projectPath !== projectPath) {
    return undefined;
  }
  put(entry);
  if (reply.notice !== undefined) {
    teller?.(reply.notice, entry, projectPath);
  }
  return entry;
}

/** Asks about one server just added: the person's own act, so it may be contacted. */
export function checkMcpSignIn(projectPath: string, agent: AgentId, name: string): Promise<McpAuthEntry | undefined> {
  return runMcpSignIn(projectPath, { kind: 'check', agent, name });
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const NONE: readonly McpAuthEntry[] = [];

export function useMcpSignInEntries(projectPath: string): readonly McpAuthEntry[] {
  const current = useSyncExternalStore(subscribe, () => store);
  return current.projectPath === projectPath ? current.entries : NONE;
}

/** The latest mounted component's teller speaks; it stays after unmounting, so a result that arrives later is still told. */
export function useNoticeTeller(next: NoticeTeller): void {
  useEffect(() => {
    teller = next;
  }, [next]);
}

/** Tests start each case from nothing. */
export function resetMcpSignInStore(): void {
  unsubscribe?.();
  unsubscribe = undefined;
  teller = undefined;
  set({ projectPath: undefined, entries: [] });
}
