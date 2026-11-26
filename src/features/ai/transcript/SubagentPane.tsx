// The chat's transcript with its subagents: the strip of the current run's subagents above the
// transcript (a row takes the person to that subagent's unit in the transcript and opens it), and, when
// the person opens a unit's full transcript, that subagent's own transcript in the transcript's place,
// under a header with "Back to chat". The subagent's transcript is the same `Transcript` component fed a
// `ChatView` of the subagent's items (subagents.ts), so its messages, thoughts, tool calls and
// permission requests are drawn exactly as the chat's are, and it updates live as events arrive.
//
// There is no stop button for one subagent: the adapters Stacki drives cancel a whole turn (ai:cancel),
// and only a JetBrains AIR client is offered per-subagent sessions, which Stacki does not impersonate.
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import { ChevronLeftIcon } from '../../../ui/Icons';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { SignInReading } from '../signInTranscript';
import { deriveSubagents, findSubagent, subagentView } from '../subagents';
import { displayName, modelLabel, SubagentDot, SubagentStrip, SubagentTime } from './SubagentStrip';
import { Transcript } from './TranscriptView';

/** Which transcript the panel shows: the chat's, or one subagent's. */
export type SubagentFocus = { readonly kind: 'chat' } | { readonly kind: 'subagent'; readonly chat: string; readonly call: string };

/** Nothing of a subagent's transcript is a sign-in problem: the chat's own transcript reads those. */
const NO_SIGN_IN: SignInReading = { hidden: new Set(), details: undefined, interrupted: false };

export function ChatTranscript(props: ComponentProps<typeof Transcript>) {
  const { view, chatId, projectPath } = props;
  const translate = useTranslate();
  const [focus, setFocus] = useState<SubagentFocus>({ kind: 'chat' });
  const [reveal, setReveal] = useState<{ readonly chat: string; readonly call: string; readonly count: number } | undefined>(undefined);
  const list = useMemo(() => deriveSubagents(view), [view]);
  const openSubagent = useCallback((opened: string) => setFocus({ kind: 'subagent', chat: chatId, call: opened }), [chatId]);
  // A focus left from another chat is the chat's own transcript here.
  const call = focus.kind === 'subagent' && focus.chat === chatId ? focus.call : undefined;
  const sub = useMemo(() => (call === undefined ? undefined : subagentView(view, call)), [view, call]);
  const strip = (
    <SubagentStrip
      list={list}
      chatId={chatId}
      projectPath={projectPath}
      options={view.options}
      onOpen={(asked) => setReveal((previous) => ({ chat: chatId, call: asked, count: (previous?.count ?? 0) + 1 }))}
    />
  );
  if (call === undefined || sub === undefined) {
    return (
      <>
        {strip}
        <Transcript
          key="chat"
          {...props}
          reveal={reveal?.chat === chatId ? { call: reveal.call, count: reveal.count } : undefined}
          onOpenSubagent={openSubagent}
        />
      </>
    );
  }
  const agent = findSubagent(list, call);
  const root = view.items.find((item) => item.kind === 'tool' && item.call === call);
  const title = root?.kind === 'tool' ? displayName({ title: root.title, kind: agent?.kind ?? 'agent' }, projectPath, translate) : '';
  return (
    <>
      <div className="ai-agent-pane-head" role="group" aria-label={translate('ai.subagents.label')}>
        <button className="ai-agent-back" aria-label={translate('ai.subagents.back')} onClick={() => setFocus({ kind: 'chat' })}>
          <ChevronLeftIcon size={14} />
        </button>
        {agent !== undefined && <SubagentDot status={agent.status} />}
        <span className="ai-agent-name">{title}</span>
        {agent !== undefined && <span className="ai-agent-model">{modelLabel(agent.model, view.options)}</span>}
        {agent !== undefined && <SubagentTime status={agent.status} />}
      </div>
      <Transcript key={`agent:${call}`} {...props} view={sub} reading={NO_SIGN_IN} retryHeldByCard={true} empty={translate('ai.subagents.empty')} />
    </>
  );
}
