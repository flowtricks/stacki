// One server's sign-in for one agent, as a short row: where it stands in two or three words and the one thing to
// do about it. The same row serves the MCP settings tab and the AI panel's note. The agent's own CLI signs in, in
// the browser (electron/handlers/ai/mcpSignIn.ts). Longer sentences are tooltips; outcomes are toasts. A server
// with no sign-in draws nothing.
import { useCallback, type ReactNode } from 'react';
import type { McpAuthEntry, McpAuthNotice } from '../../../shared/properties/mcp';
import { agentLabel } from '../../../shared/properties/ai/agentIds';
import { can } from '../../../shared/properties/projectRoles';
import { canSignInToServers } from '../../ipc/mcpAuthBridge';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { canPanel } from '../../lib/roleAccess';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { confirmDialog } from '../ConfirmDialog';
import { reportActionToast } from '../errorNotices';
import MoreMenu from '../MoreMenu';
import { runMcpSignIn, useNoticeTeller } from './mcpSignInStore';
import './mcpSignIn.css';

/** How long a sign-in waits, in minutes, as the tooltip says it (MCP_SIGN_IN_LIMITS.signInMsMax in main). */
export const MCP_SIGN_IN_MINUTES = 5;

/** Signing in changes what an agent can do, so it follows the AI panel's access; and the host must be able to do it. */
export function useMcpSignInAllowed(): boolean {
  const role = useCurrentRole();
  return canPanel(role, 'ai') && can(role, 'code:edit') && canSignInToServers();
}

const signIn = (projectPath: string, entry: McpAuthEntry): void => void runMcpSignIn(projectPath, { kind: 'signIn', agent: entry.agent, name: entry.name });

/** Offers a sign-in right after a server is added. */
export function offerMcpSignIn(projectPath: string, entry: McpAuthEntry, translate: Translator): void {
  if (entry.state !== 'needs-sign-in') {
    return;
  }
  const values = { agent: agentLabel(entry.agent), server: entry.name };
  reportActionToast(translate('settings.mcp.signIn.offer', values), 'success', [
    { label: translate('settings.mcp.signIn.action'), run: () => signIn(projectPath, entry) },
  ]);
}

function noticeText(notice: McpAuthNotice, entry: McpAuthEntry, translate: Translator): string {
  const values = { agent: agentLabel(entry.agent), server: entry.name };
  switch (notice) {
    case 'signed-in':
      return translate('settings.mcp.signIn.notice.signedIn', values);
    case 'signed-out':
      return translate('settings.mcp.signIn.notice.signedOut', values);
    case 'cancelled':
      return translate('settings.mcp.signIn.notice.cancelled', values);
    case 'failed':
      return translate('settings.mcp.signIn.notice.failed', values);
    case 'timed-out':
      return translate('settings.mcp.signIn.notice.timedOut', values);
    case 'unsafe-page':
      return translate('settings.mcp.signIn.notice.unsafePage', values);
    case 'unsupported-cli':
      return translate('settings.mcp.signIn.unsupported.hint', values);
    case 'blocked':
      return translate('settings.mcp.signIn.blocked.hint', values);
    case 'not-needed':
      return translate('settings.mcp.signIn.notice.notNeeded', values);
    case 'sign-out-failed':
      return translate('settings.mcp.signIn.notice.signOutFailed', values);
    case 'busy':
      return translate('settings.mcp.signIn.notice.busy', values);
    default: {
      const exhaustive: never = notice;
      return exhaustive;
    }
  }
}

/** Tells what happened as toasts; mounted wherever sign-ins can be started. */
export function useMcpSignInToasts(): void {
  const translate = useTranslate();
  useNoticeTeller(
    useCallback(
      (notice: McpAuthNotice, entry: McpAuthEntry, projectPath: string) => {
        const retry = notice === 'cancelled' || notice === 'failed' || notice === 'timed-out';
        const good = notice === 'signed-in' || notice === 'signed-out' || notice === 'cancelled' || notice === 'not-needed';
        reportActionToast(
          noticeText(notice, entry, translate),
          good ? 'success' : 'error',
          retry ? [{ label: translate('ai.common.tryAgain'), run: () => signIn(projectPath, entry) }] : [],
        );
      },
      [translate],
    ),
  );
}

export function McpSignInControl({
  projectPath,
  entry,
  label,
}: {
  readonly projectPath: string;
  readonly entry: McpAuthEntry;
  /** What the row is about: the agent's name on a server's card, the server's name in the AI panel. */
  readonly label: string;
}) {
  const translate = useTranslate();
  if (entry.state === 'none') {
    return undefined;
  }
  const { text, hint, actions } = rowFor(projectPath, entry, translate);
  return (
    <div className={`mcp-signin is-${entry.state}`} role="status">
      <span className="mcp-signin-text" title={hint}>
        <span className="mcp-signin-label">{label}</span>
        <span className="mcp-signin-state">{text}</span>
      </span>
      {actions}
    </div>
  );
}

interface Row {
  readonly text: string;
  readonly hint: string | undefined;
  readonly actions: ReactNode;
}

function rowFor(projectPath: string, entry: McpAuthEntry, translate: Translator): Row {
  const { agent, name, state } = entry;
  const values = { agent: agentLabel(agent), server: name };
  const step = (kind: 'check' | 'reopen' | 'cancel') => () => void runMcpSignIn(projectPath, { kind, agent, name });
  const small = (words: { readonly label: string; readonly tone?: 'primary' }, run: () => void) => (
    <button type="button" className={words.tone === 'primary' ? 'primary mcp-signin-button' : 'ghost mcp-signin-button'} onClick={run}>
      {words.label}
    </button>
  );
  switch (state) {
    case 'none':
      return { text: '', hint: undefined, actions: undefined };
    case 'needs-sign-in':
      return {
        text: translate('settings.mcp.signIn.needed'),
        hint: undefined,
        actions: small({ label: translate('settings.mcp.signIn.action'), tone: 'primary' }, () => signIn(projectPath, entry)),
      };
    case 'signing-in':
      return {
        text: translate('settings.mcp.signIn.waiting'),
        hint: translate('settings.mcp.signIn.waiting.hint', { minutes: MCP_SIGN_IN_MINUTES }),
        actions: (
          <>
            {small({ label: translate('settings.mcp.signIn.reopen') }, step('reopen'))}
            {small({ label: translate('ui.cancel') }, step('cancel'))}
          </>
        ),
      };
    case 'connected':
      return {
        text: translate('settings.mcp.signIn.connected'),
        hint: undefined,
        actions: (
          <MoreMenu
            title={translate('settings.mcp.signIn.menu', values)}
            items={[
              { label: translate('settings.mcp.signIn.again'), onSelect: () => signIn(projectPath, entry) },
              { label: translate('settings.mcp.signIn.signOut'), danger: true, onSelect: () => void confirmSignOut(projectPath, entry, translate) },
            ]}
          />
        ),
      };
    case 'unknown':
      return {
        text: translate('settings.mcp.signIn.unknown'),
        hint: undefined,
        actions: small({ label: translate('settings.mcp.signIn.check') }, step('check')),
      };
    case 'not-checked':
      return {
        text: translate('settings.mcp.signIn.notChecked'),
        hint: undefined,
        actions: small({ label: translate('settings.mcp.signIn.check') }, step('check')),
      };
    case 'unsupported-cli':
      return {
        text: translate('settings.mcp.signIn.unsupported', values),
        hint: translate('settings.mcp.signIn.unsupported.hint', values),
        actions: small({ label: translate('settings.mcp.signIn.check') }, step('check')),
      };
    case 'blocked':
      return { text: translate('settings.mcp.signIn.blocked'), hint: translate('settings.mcp.signIn.blocked.hint', values), actions: undefined };
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}

async function confirmSignOut(projectPath: string, entry: McpAuthEntry, translate: Translator): Promise<void> {
  const values = { agent: agentLabel(entry.agent), server: entry.name };
  const confirmed = await confirmDialog({
    title: translate('settings.mcp.signIn.signOut.title', values),
    body: translate('settings.mcp.signIn.signOut.body', values),
    confirmLabel: translate('settings.mcp.signIn.signOut'),
    cancelLabel: translate('ui.cancel'),
    danger: true,
  });
  if (confirmed === true) {
    await runMcpSignIn(projectPath, { kind: 'signOut', agent: entry.agent, name: entry.name });
  }
}
