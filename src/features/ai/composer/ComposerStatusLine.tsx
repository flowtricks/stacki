// The quiet line under the composer box: the model chip ("Sonnet 5.5  Medium"), the mode chip ("Manual")
// and, at the far right, the context ring. Each opens a Menu or panel (ModelMenu, ModeMenu, ContextRing);
// this file decides what the chats's settings are and what picking one does.
//
// Every choice (mode, model, effort, switches) is remembered for the agent, last writer wins, and a new chat
// starts with what was remembered; the main process applies it when the session starts. A chat that has not
// started has no session yet, so it shows the remembered values (already in the store with the options, so the
// first frame is right) and a pick only changes what is remembered. A live chat changes a setting by asking
// the agent, and that change is remembered too once it went through. "Reset to defaults" forgets the set.
import { AGENT_IDS, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { AGENT_PRESENTATION } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId, ChatOption } from '../../../../shared/properties/ai/chatModel';
import { usableSettings } from '../../../../shared/properties/ai/rememberedSettings';
import { agentBadge } from '../agentSwitch';
import { rememberChoice, resetRememberedSettings, setChatOption, type AiState } from '../aiStore';
import type { ChatView } from '../chatReducer';
import { ContextRing } from './ContextRing';
import { optionById, type ComposerSettings } from './composerSettings';
import { ModeMenu } from './ModeMenu';
import { ModelMenu } from './ModelMenu';

export function ComposerStatusLine({
  state,
  chatId,
  agent,
  view,
}: {
  readonly state: AiState;
  readonly chatId: ChatId;
  readonly agent: AgentId;
  readonly view: ChatView;
}) {
  const started = view.items.some((item) => item.kind === 'user');
  const live = view.options.length > 0;
  const running = view.running !== undefined;
  const rememberedForAgent = state.remembered[agent];
  const agentOptions = state.agentOptions.get(agent) ?? [];
  // Only a value the agent still offers counts; the rest reads as the agent's own default.
  const remembered = new Map(usableSettings(agentOptions, rememberedForAgent).map((setting) => [setting.option, setting.value]));
  // Only a chat that has not started takes the remembered values: a chat with messages resumes its own session, which keeps its own.
  const valueOf = (option: ChatOption): string => (live || started ? option.currentValue : (remembered.get(option.id) ?? option.currentValue));
  const options = (live ? view.options : agentOptions).map((option) => ({ ...option, currentValue: valueOf(option) }));
  const pick = (optionId: string, value: string): void => {
    if (live) {
      void setChatOption(chatId, optionId, value);
    } else {
      void rememberChoice(agent, optionId, value);
    }
  };
  const reset = (): void => {
    void resetRememberedSettings(agent);
  };
  const agentBadges = Object.fromEntries(
    AGENT_IDS.flatMap((id) => {
      const badge = agentBadge(state, id);
      return badge === undefined ? [] : [[id, badge]];
    }),
  );
  const settings: ComposerSettings = { agent, chat: chatId, started, running, options, pick, reset, canReset: rememberedForAgent.length > 0, agentBadges };
  const summary = state.chats.find((candidate) => candidate.id === chatId);
  const usage = view.usage ?? summary?.context;
  const modeKnown = optionById(options, AGENT_PRESENTATION[agent].modes.optionId) !== undefined;
  return (
    <div className="ai-status-line">
      <ModelMenu settings={settings} />
      {modeKnown && <ModeMenu settings={settings} />}
      <span className="ai-status-spacer" />
      <ContextRing chat={chatId} agent={agent} usage={usage} running={running} compacting={view.compaction?.status === 'in_progress'} />
    </div>
  );
}
