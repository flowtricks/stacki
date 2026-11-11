// The guided setup for one agent, for people who never open a terminal: its
// mark, one sentence, one primary button. Underneath, the agent's own CLI does
// each step (electron/handlers/ai/agentSetup.ts lists every command it runs);
// the sign-in finishes in the browser, and Stacki never sees the credentials.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { SetupAccount, SetupState } from '../../../shared/ipc/aiChat';
import { SETUP_CODE_CHARS_MAX } from '../../../shared/ipc/aiChat';
import { agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import { MoreIcon } from '../../ui/Icons';
import { runSetup } from './aiStore';

export function SetupCard({
  setup,
  onOpenExternal,
}: {
  readonly setup: Exclude<SetupState, { readonly step: 'ready' }>;
  readonly onOpenExternal: (url: string) => void;
}) {
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
    case 'signed-out':
      return (
        <Card agent={agent} title={`Sign in to ${label}`} text={`Use your ${providerAccount(agent)} account. Your browser opens to finish.`}>
          <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'signIn' })}>
            {signInLabel(agent)}
          </button>
        </Card>
      );
    case 'signing-in':
      return (
        <Card agent={agent} title="Finish signing in in your browser…" text="When the page says you are signed in, come back here." busy>
          {setup.needsCode && <CodeField agent={agent} />}
          <div className="ai-gate-actions">
            {setup.url !== undefined && <button onClick={() => onOpenExternal(setup.url ?? '')}>Open the page again</button>}
            <button className="ghost" onClick={() => void runSetup(agent, { kind: 'cancel' })}>
              Cancel
            </button>
          </div>
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

/** Ready: who is signed in, by name and plan; the email only inside ⋯, with Sign out under it. */
export function AccountRow({ setup }: { readonly setup: Extract<SetupState, { readonly step: 'ready' }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ai-account">
      <AgentMark agent={setup.agent} />
      <span className="ai-account-name">{accountLabel(setup.agent, setup.account)}</span>
      <button className="ghost" aria-label="Account options" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <MoreIcon size={12} />
      </button>
      {open && (
        <div className="ai-account-menu" role="menu">
          {setup.account.email !== undefined && (
            <div className="ai-account-email" role="menuitem" aria-disabled="true">
              <span>Account</span>
              <span>{setup.account.email}</span>
            </div>
          )}
          <button role="menuitem" className="ghost" onClick={() => void runSetup(setup.agent, { kind: 'signOut' })}>
            Sign out
          </button>
        </div>
      )}
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

function CodeField({ agent }: { readonly agent: AgentId }) {
  const [code, setCode] = useState('');
  return (
    <form
      className="ai-code"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = code.trim();
        if (trimmed !== '') {
          void runSetup(agent, { kind: 'code', code: trimmed });
          setCode('');
        }
      }}
    >
      <input
        aria-label="Code from the browser"
        placeholder="Paste the code from your browser"
        maxLength={SETUP_CODE_CHARS_MAX}
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="ai-primary" disabled={code.trim() === ''}>
        Continue
      </button>
    </form>
  );
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

function signInLabel(agent: AgentId): string {
  return agent === 'claude' ? 'Sign in with Claude' : 'Sign in with ChatGPT';
}

function providerAccount(agent: AgentId): string {
  return agent === 'claude' ? 'Claude' : 'ChatGPT';
}
