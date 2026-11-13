// The guided setup for one agent, for people who never open a terminal: its
// mark, one sentence, one primary button. Underneath, the agent's own CLI does
// each step (electron/handlers/ai/agentSetup.ts lists every command it runs).
// Signing in is SignInCard.tsx; this file keeps the install steps and the
// signed-in account row.
import { assert } from '../../../shared/core/assert';
import type { SetupAccount, SetupState } from '../../../shared/ipc/aiChat';
import { agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import { ChevronDownIcon } from '../../ui/Icons';
import Menu, { useMenuTrigger } from '../../ui/Menu';
import { agentSwitchEntries, type AgentBadge } from './agentSwitch';
import MoreMenu from '../../ui/MoreMenu';
import { runSetup } from './aiStore';

export function SetupCard({ setup }: { readonly setup: Exclude<SetupState, { readonly step: 'ready' | 'signed-out' | 'signing-in' }> }) {
  const { agent } = setup;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const label = agentLabel(agent);
  switch (setup.step) {
    case 'missing':
      return (
        <Card agent={agent} title={translate('ai.setup.install.title', { agent: label })} text={translate('ai.setup.install.text', { agent: label })}>
          <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'install' })}>
            {translate('ai.setup.install.action', { agent: label })}
          </button>
        </Card>
      );
    case 'installing':
      return (
        <Card agent={agent} title={translate('ai.setup.installing.title', { agent: label })} text={translate('ai.setup.installing.text')} busy>
          {undefined}
        </Card>
      );
    case 'failed':
      return (
        <Card
          agent={agent}
          title={failedTitle(setup.during, label, translate)}
          text={translateDescribed({ message: setup.message, messageRef: setup.messageRef })}
        >
          <div className="ai-gate-actions">
            <button
              className="ai-primary"
              onClick={() => void runSetup(agent, { kind: setup.during === 'install' ? 'install' : setup.during === 'sign-in' ? 'signIn' : 'signOut' })}
            >
              {translate('ai.common.tryAgain')}
            </button>
            {setup.details !== '' && <button onClick={() => void navigator.clipboard.writeText(setup.details)}>{translate('ai.setup.copyDetails')}</button>}
          </div>
        </Card>
      );
    default: {
      const exhaustive: never = setup;
      return exhaustive;
    }
  }
}

function failedTitle(during: 'install' | 'sign-in' | 'sign-out', label: string, translate: Translator): string {
  switch (during) {
    case 'install':
      return translate('ai.setup.failed.install', { agent: label });
    case 'sign-in':
      return translate('ai.setup.failed.signIn');
    case 'sign-out':
      return translate('ai.setup.failed.signOut');
    default: {
      const exhaustive: never = during;
      return exhaustive;
    }
  }
}

/** Ready: who is signed in, by name and plan; the email only inside ⋯, with Sign out under it. The menu is the shared popup, drawn over the panel, never inline. */
export function AccountRow({
  setup,
  chat,
  started,
  badges,
}: {
  readonly setup: Extract<SetupState, { readonly step: 'ready' }>;
  readonly chat: ChatId;
  /** The chat has a message: choosing the other agent then opens a new chat. */
  readonly started: boolean;
  readonly badges: Readonly<Partial<Record<AgentId, AgentBadge>>>;
}) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const label = accountLabel(setup.agent, setup.account, translate);
  return (
    <div className="ai-account">
      {/* The mark and the name are one button: the way to change agent, so Codex is one click from the composer. */}
      <button
        ref={trigger.ref}
        type="button"
        className={`ai-account-switch${trigger.open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        aria-label={translate('ai.agent.switch.label', { agent: label })}
        title={translate('ai.agent.switch.title')}
        onClick={trigger.toggle}
      >
        <AgentMark agent={setup.agent} />
        <span className="ai-account-name">{label}</span>
        <ChevronDownIcon size={10} />
      </button>
      <span className="ai-account-spacer" />
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        entries={agentSwitchEntries({ agent: setup.agent, chat, started, badges, translate })}
        label={translate('ai.agent.switch.menu')}
        placement="below-start"
        onClose={trigger.close}
      />
      <MoreMenu
        className="ghost"
        title={translate('ai.account.options')}
        width={220}
        items={[
          // The email is context, not an action: a disabled first row names the account.
          setup.account.email !== undefined && { label: translate('ai.account.email', { email: setup.account.email }), disabled: true },
          { label: translate('ai.account.signOut'), onSelect: () => void runSetup(setup.agent, { kind: 'signOut' }) },
        ]}
      />
    </div>
  );
}

/** "Timothy Ricks · Max"; without a name, "Claude Max"; never the email. */
export function accountLabel(agent: AgentId, account: SetupAccount, translate: Translator): string {
  const product = agent === 'claude' ? 'Claude' : 'ChatGPT';
  if (account.name !== undefined) {
    return account.plan === undefined ? account.name : `${account.name} · ${account.plan}`;
  }
  return account.plan === undefined ? translate('ai.account.signedInTo', { product }) : `${product} ${account.plan}`;
}

function Card({
  agent,
  title,
  text,
  busy,
  children,
}: {
  readonly agent: AgentId;
  readonly title: string;
  readonly text: string;
  readonly busy?: boolean;
  readonly children: React.ReactNode;
}) {
  assert(title.length > 0, 'SetupCard: a step has a title');
  return (
    <div className="ai-gate ai-setup" role={busy === true ? 'status' : undefined}>
      <div className="ai-setup-head">
        <AgentMark agent={agent} />
        <strong>{title}</strong>
        {busy === true && <span className="ai-working-dot" />}
      </div>
      <p>{text}</p>
      {children}
    </div>
  );
}

function AgentMark({ agent }: { readonly agent: AgentId }) {
  return agent === 'claude' ? <ClaudeLogo size={18} /> : <CodexLogo size={18} className="ai-logo-codex" />;
}
