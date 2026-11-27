// The guided setup for one agent, for people who never open a terminal: its
// mark, one sentence, one primary button. Underneath, the agent's own CLI does
// each step (electron/handlers/ai/agentSetup.ts lists every command it runs).
// Signing in is SignInCard.tsx; this file keeps the install steps and the
// signed-in account row.
import { assert } from '../../../shared/core/assert';
import type { SetupAccount, SetupState } from '../../../shared/ipc/aiChat';
import { agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { Translator } from '../../lib/i18n/localeContext';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import { runSetup } from './aiStore';
import { signInSourceText } from './signInSource';

export function SetupCard({ setup }: { readonly setup: Exclude<SetupState, { readonly step: 'ready' | 'signed-out' | 'unchecked' | 'signing-in' }> }) {
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

/** "Timothy Ricks · Max"; without a name, "Claude Max"; never the email. */
export function accountLabel(agent: AgentId, account: SetupAccount, translate: Translator): string {
  const product = agent === 'claude' ? 'Claude' : 'ChatGPT';
  if (account.source !== 'account') {
    return signInSourceText(account.source, agentLabel(agent), translate).label;
  }
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
