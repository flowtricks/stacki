// The quiet word about the sign-in under the composer, shown only when there is something to know: the sign-in
// could not be checked (pressing it checks again; nothing is blocked), or the agent is using a key, a token or a
// cloud provider rather than an account. The longer sentence is the tooltip; no value is ever shown.
import type { SetupState } from '../../../../shared/ipc/aiChat';
import { agentLabel, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { runSetup } from '../aiStore';
import { signInSourceText } from '../signInSource';

export function SignInNote({ agent, setup }: { readonly agent: AgentId; readonly setup: SetupState | undefined }) {
  const translate = useTranslate();
  if (setup?.step === 'unchecked') {
    const hint = translate('ai.signInCheck.hint', { agent: agentLabel(agent) });
    return (
      <button type="button" className="ghost ai-chip ai-chip-quiet ai-sign-in-note" title={hint} onClick={() => void runSetup(agent, { kind: 'detect' })}>
        <span className="ai-chip-text">{translate('ai.signInCheck.chip')}</span>
      </button>
    );
  }
  if (setup?.step !== 'ready' || setup.account.source === 'account') {
    return undefined;
  }
  const { label, hint } = signInSourceText(setup.account.source, agentLabel(agent), translate);
  return (
    <span className="ai-chip ai-chip-quiet ai-sign-in-note is-static" title={hint} aria-label={`${label}. ${hint}`}>
      <span className="ai-chip-text">{label}</span>
    </span>
  );
}
