// The warning that Claude's work is charged beyond the subscription (a running session said so: agentSetup.ts). It
// stays while that is true: in the panel above the composer, and under the comment pins' bar, which starts work
// with the panel out of view. One short label with the details in the app's tip, and the way to sign in again.
import { createPortal } from 'react-dom';
import type { SetupState } from '../../../shared/ipc/aiChat';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import FittedTooltip from '../../ui/FittedTooltip';
import { WarningTriangleIcon } from '../../ui/Icons';
import { runSetup } from './aiStore';

/** What there is to warn about for `setup`: extra usage while the turns go on, or a turn stopped for its billing. */
export function billingWarning(setup: SetupState | undefined): 'extra-usage' | 'billed' | undefined {
  if (setup?.agent !== 'claude') {
    return undefined;
  }
  if (setup.step === 'ready') {
    return setup.billing;
  }
  return setup.step === 'signed-out' && setup.reason === 'billed' ? 'billed' : undefined;
}

export function BillingWarning({ kind }: { readonly kind: 'extra-usage' | 'billed' }) {
  const translate = useTranslate();
  const tip = useDelayedTooltip();
  const label = translate('ai.billing.label');
  const hint = translate(kind === 'extra-usage' ? 'ai.billing.extra.hint' : 'ai.billing.stopped');
  return (
    <div className="ai-billing" role="status">
      <span className="ai-billing-label" aria-label={`${label}. ${hint}`} onMouseEnter={tip.show} onMouseLeave={tip.hide}>
        <WarningTriangleIcon size={16} />
        <span>{label}</span>
      </span>
      <button type="button" className="ai-primary" onClick={() => void runSetup('claude', { kind: 'signIn' })}>
        {translate('ai.billing.signIn')}
      </button>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value}>
            {hint}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </div>
  );
}
