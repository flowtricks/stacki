// The one place the panel says "this agent needs you to sign in". Whatever the
// reason (never signed in, a session that expired mid-chat, a sign-in underway
// or one that did not finish) it is this single card above the composer, on a
// filled surface: an icon, a title, one sentence, one primary action and a quiet
// way out. The agent's raw error never headlines it; it sits behind Details.
// Stacki never sees credentials: the agent's own CLI signs in, in the browser
// (electron/handlers/ai/agentSetup.ts).
import { useEffect, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageRef } from '../../../shared/core/i18n/messageReference';
import { SETUP_CODE_CHARS_MAX, type SetupState } from '../../../shared/ipc/aiChat';
import { AGENTS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import { centralIcon } from '../../ui/central/CentralIcon';
import { lock as centralLock } from '../../ui/central/centralGeometry';
import { CheckIcon, CopyIcon, ExternalIcon, TerminalIcon } from '../../ui/Icons';
import { runSetup } from './aiStore';

const LockGlyph = centralIcon(centralLock);

/** How long "Signed in" stays when there is nothing to retry; with a message to retry it stays until the person acts or this long. */
export const SIGNED_IN_MS = 2500;
export const SIGNED_IN_RETRY_MS = 12_000;

/** Where a sign-in stands, from the agent's CLI (`setup`) and the agent's own answer (`expired`). */
export type SignInStage =
  | { readonly kind: 'start'; readonly expired: boolean }
  | { readonly kind: 'waiting'; readonly expired: boolean; readonly url: string | undefined; readonly needsCode: boolean; readonly output: string }
  | {
      readonly kind: 'failed';
      readonly expired: boolean;
      readonly message: string;
      readonly messageRef: MessageRef | undefined;
      readonly details: string;
    };

/**
 * The sign-in stage the agent is in, or undefined when it needs none. `expired`: the agent refused the
 * person's saved sign-in (availability 'sign-in'), as opposed to never having been signed in.
 */
export function signInStage({ setup, expired }: { readonly setup: SetupState | undefined; readonly expired: boolean }): SignInStage | undefined {
  if (setup?.step === 'signing-in') {
    return { kind: 'waiting', expired, url: setup.url, needsCode: setup.needsCode, output: setup.output };
  }
  if (setup?.step === 'failed' && setup.during === 'sign-in') {
    return { kind: 'failed', expired, message: setup.message, messageRef: setup.messageRef, details: setup.details };
  }
  if (setup?.step === 'signed-out') {
    return { kind: 'start', expired: false };
  }
  return expired ? { kind: 'start', expired: true } : undefined;
}

export function SignInCard({
  agent,
  stage,
  details,
  onOpenExternal,
  onOpenTerminal,
}: {
  readonly agent: AgentId;
  readonly stage: SignInStage;
  /** The agent's own words about the failure, kept for support behind Details. */
  readonly details: string | undefined;
  readonly onOpenExternal: (url: string) => void;
  readonly onOpenTerminal: (command: string) => void;
}) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const label = agentLabel(agent);
  assert(label.length > 0, 'SignInCard: the agent has a name');
  const terminal = (
    <button className="ghost" onClick={() => onOpenTerminal(AGENTS[agent].signInCommand)}>
      <TerminalIcon size={12} /> {translate('ai.signIn.useTerminal')}
    </button>
  );
  switch (stage.kind) {
    case 'start':
      return (
        <Frame
          icon={<LockGlyph size={16} />}
          title={translate('ai.signIn.title', { agent: label })}
          text={stage.expired ? translate('ai.signIn.expired') : translate('ai.signIn.toStart')}
          details={details}
        >
          <div className="ai-signin-actions">
            <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'signIn' })}>
              {translate('ai.signIn.action')}
            </button>
            {terminal}
          </div>
        </Frame>
      );
    case 'waiting':
      return (
        <Frame
          icon={<Spinner />}
          title={translate('ai.signIn.waiting.title')}
          text={stage.needsCode ? translate('ai.signIn.waiting.code') : translate('ai.signIn.waiting.text')}
          busy
          details={joinDetails(stage.output, details)}
        >
          {stage.needsCode && <CodeField agent={agent} />}
          <div className="ai-signin-actions">
            {stage.url !== undefined && (
              <button onClick={() => onOpenExternal(stage.url ?? '')}>
                <ExternalIcon size={12} /> {translate('ai.signIn.reopen')}
              </button>
            )}
            {stage.url !== undefined && <CopyLinkButton url={stage.url} />}
            <button className="ghost" onClick={() => void runSetup(agent, { kind: 'cancel' })}>
              {translate('ui.cancel')}
            </button>
          </div>
        </Frame>
      );
    case 'failed':
      return (
        <Frame
          icon={<LockGlyph size={16} />}
          title={translate('ai.setup.failed.signIn')}
          text={translateDescribed({ message: stage.message, messageRef: stage.messageRef })}
          details={joinDetails(stage.details, details)}
        >
          <div className="ai-signin-actions">
            <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'signIn' })}>
              {translate('ai.common.tryAgain')}
            </button>
            {terminal}
          </div>
        </Frame>
      );
    default: {
      const exhaustive: never = stage;
      return exhaustive;
    }
  }
}

/** The brief confirmation after signing in; the message the sign-in interrupted can be sent again from here. */
export function SignedInStrip({ onRetry }: { readonly onRetry: (() => void) | undefined }) {
  const translate = useTranslate();
  return (
    <div className="ai-signin ai-signin-done" role="status">
      <span className="ai-signin-badge ai-signin-badge-done">
        <CheckIcon size={12} />
      </span>
      <span className="ai-signin-done-text">{translate('ai.signIn.done')}</span>
      {onRetry !== undefined && (
        <button className="ai-primary" onClick={onRetry}>
          {translate('ai.signIn.retryMessage')}
        </button>
      )}
    </div>
  );
}

/**
 * True for a moment after `needed` turns false for the same agent: a sign-in just finished. Switching agents
 * or chats never counts, and nothing shows the first time the panel opens already signed in.
 */
export function useSignedInMoment({ agent, needed, holdMs }: { readonly agent: AgentId; readonly needed: boolean; readonly holdMs: number }): {
  readonly shown: boolean;
  readonly dismiss: () => void;
} {
  const [shown, setShown] = useState(false);
  const previous = useRef({ agent, needed });
  useEffect(() => {
    const before = previous.current;
    previous.current = { agent, needed };
    if (before.agent !== agent) {
      setShown(false);
    } else if (before.needed && !needed) {
      setShown(true);
    } else if (needed) {
      setShown(false);
    }
  }, [agent, needed]);
  useEffect(() => {
    if (!shown) {
      return undefined;
    }
    const timer = setTimeout(() => setShown(false), holdMs);
    return () => clearTimeout(timer);
  }, [shown, holdMs]);
  return { shown, dismiss: () => setShown(false) };
}

function Frame({
  icon,
  title,
  text,
  busy,
  details,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly text: string;
  readonly busy?: boolean;
  readonly details: string | undefined;
  readonly children: React.ReactNode;
}) {
  assert(title.length > 0, 'SignInCard: a stage has a title');
  const translate = useTranslate();
  return (
    <div className="ai-signin" role={busy === true ? 'status' : undefined}>
      <span className="ai-signin-badge">{icon}</span>
      <div className="ai-signin-body">
        <strong>{title}</strong>
        <p>{text}</p>
        {children}
        {details !== undefined && details.trim() !== '' && (
          <details className="ai-details">
            <summary>{translate('ai.common.details')}</summary>
            <pre>{details}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

function joinDetails(first: string, second: string | undefined): string | undefined {
  const parts = [first.trim(), second?.trim() ?? ''].filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join('\n');
}

function Spinner() {
  return (
    <svg className="ai-spinner" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeDasharray="22 16" />
    </svg>
  );
}

/** The sign-in link on the clipboard, for a browser the page will not open in (any browser takes it pasted). */
function CopyLinkButton({ url }: { readonly url: string }) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(url).then(
          () => setCopied(true),
          () => setCopied(false),
        );
      }}
    >
      {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />} {copied ? translate('ai.common.copied') : translate('ai.signIn.copyLink')}
    </button>
  );
}

function CodeField({ agent }: { readonly agent: AgentId }) {
  const translate = useTranslate();
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
        aria-label={translate('ai.signIn.codeLabel')}
        placeholder={translate('ai.signIn.codePlaceholder')}
        maxLength={SETUP_CODE_CHARS_MAX}
        value={code}
        onChange={(event) => setCode(event.target.value)}
      />
      <button type="submit" className="ai-primary" disabled={code.trim() === ''}>
        {translate('ui.continue')}
      </button>
    </form>
  );
}
