// The guided setup for one agent, for people who never open a terminal: its
// mark, one sentence, one primary button. Underneath, the agent's own CLI does
// each step (electron/handlers/ai/agentSetup.ts lists every command it runs).
// Signing in is SignInCard.tsx; this file keeps the install steps and the
// signed-in account row.
import { assert } from '../../../shared/core/assert';
import type { SetupAccount, SetupState } from '../../../shared/ipc/aiChat';
import { agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import MoreMenu from '../../ui/MoreMenu';
import { runSetup } from './aiStore';

export function SetupCard({ setup }: { readonly setup: Exclude<SetupState, { readonly step: 'ready' | 'signed-out' | 'signing-in' }> }) {
  const { agent } = setup;
  const label = agentLabel(agent);
  switch (setup.step) {
    case 'missing':
      return (
        <Card agent={agent} title={`Install ${label}`} text={`${label} isn’t on this computer yet. Stacki installs it for you; it takes a minute.`}>
          <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'install' })}>
            Install {label}
          </button>
        </Card>
      );
    case 'installing':
      return (
        <Card agent={agent} title={`Installing ${label}…`} text="This can take a minute. You can keep working meanwhile." busy>
          {undefined}
        </Card>
      );
    case 'failed':
      return (
        <Card
          agent={agent}
          title={setup.during === 'install' ? `${label} wasn’t installed` : setup.during === 'sign-in' ? 'Sign-in didn’t finish' : 'Sign-out didn’t finish'}
          text={setup.message}
        >
          <div className="ai-gate-actions">
            <button
              className="ai-primary"
              onClick={() => void runSetup(agent, { kind: setup.during === 'install' ? 'install' : setup.during === 'sign-in' ? 'signIn' : 'signOut' })}
            >
              Try again
            </button>
            {setup.details !== '' && <button onClick={() => void navigator.clipboard.writeText(setup.details)}>Copy details</button>}
          </div>
        </Card>
      );
    default: {
      const exhaustive: never = setup;
      return exhaustive;
    }
  }
}

/** Ready: who is signed in, by name and plan; the email only inside ⋯, with Sign out under it. The menu is the shared popup, drawn over the panel, never inline. */
export function AccountRow({ setup }: { readonly setup: Extract<SetupState, { readonly step: 'ready' }> }) {
  return (
    <div className="ai-account">
      <AgentMark agent={setup.agent} />
      <span className="ai-account-name">{accountLabel(setup.agent, setup.account)}</span>
      <MoreMenu
        className="ghost"
        title="Account options"
        width={220}
        items={[
          // The email is context, not an action: a disabled first row names the account.
          setup.account.email !== undefined && { label: `Account  ${setup.account.email}`, disabled: true },
          { label: 'Sign out', onSelect: () => void runSetup(setup.agent, { kind: 'signOut' }) },
        ]}
      />
    </div>
  );
}

/** "Timothy Ricks · Max"; without a name, "Claude Max"; never the email. */
export function accountLabel(agent: AgentId, account: SetupAccount): string {
  const product = agent === 'claude' ? 'Claude' : 'ChatGPT';
  if (account.name !== undefined) {
    return account.plan === undefined ? account.name : `${account.name} · ${account.plan}`;
  }
  return account.plan === undefined ? `Signed in to ${product}` : `${product} ${account.plan}`;
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
