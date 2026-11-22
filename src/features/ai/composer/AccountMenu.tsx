// The "⋯" at the far end of the line under the composer: which agent the chat runs as (Claude or Codex, each with
// its state) and, below a divider, the signed-in account with Sign out. It replaces the account row that used to sit
// above the composer, so the panel keeps one quiet line of settings. The active agent and account are told in the
// button's tooltip; the menu opens upward, over the composer.
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { agentLabel } from '../../../../shared/properties/ai/agentIds';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { LockIcon, MailIcon, MoreIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { accountLabel } from '../SetupCard';
import { agentSwitchEntries, type AgentBadge } from '../agentSwitch';
import { runSetup, useAiState } from '../aiStore';

export function AccountMenu({
  agent,
  chat,
  started,
  badges,
}: {
  readonly agent: AgentId;
  readonly chat: ChatId;
  /** The chat has a message: choosing the other agent then opens a new chat. */
  readonly started: boolean;
  readonly badges: Readonly<Partial<Record<AgentId, AgentBadge>>>;
}) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const { setups } = useAiState();
  const setup = setups.get(agent);
  const account = setup?.step === 'ready' ? setup.account : undefined;
  const entries: MenuEntry[] = [...agentSwitchEntries({ agent, chat, started, badges, translate })];
  if (account !== undefined) {
    entries.push({ kind: 'divider', id: 'divider-account' });
    if (account.email !== undefined) {
      // The email is context, not an action: a muted row that names the account.
      entries.push({
        kind: 'item',
        id: 'account-email',
        label: translate('ai.account.email', { email: account.email }),
        icon: <MailIcon size={14} />,
        disabled: true,
        onSelect: () => undefined,
      });
    }
    entries.push({
      kind: 'item',
      id: 'sign-out',
      label: translate('ai.account.signOut'),
      icon: <LockIcon size={14} />,
      onSelect: () => void runSetup(agent, { kind: 'signOut' }),
    });
  }
  const title = account === undefined ? agentLabel(agent) : `${agentLabel(agent)} · ${accountLabel(agent, account, translate)}`;
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        className={`ghost ai-chip ai-account-more${trigger.open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        aria-label={translate('ai.account.options')}
        title={title}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        entries={trigger.open ? entries : []}
        label={translate('ai.account.options')}
        placement="above-end"
        onClose={trigger.close}
      />
    </>
  );
}
