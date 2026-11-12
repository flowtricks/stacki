// The quiet line under the composer box: the model chip ("Sonnet 5.5  Medium"), the mode chip ("Manual")
// and, at the far right, the context ring. Each opens a Menu or panel (ModelMenu, ModeMenu, ContextRing);
// this file decides what the chats's settings are and what picking one does.
//
// Live chats (the agent has reported its options) change a setting by asking the agent. A chat that has
// not started has no session yet: model, effort and switches are remembered for the agent and stored with
// the chat so they apply when the session starts, as before. The mode is stored with the chat only, never
// remembered: a new chat always begins in the mode that asks first, because the agent applies the chat's
// stored settings after that default and a remembered "Bypass permissions" would silently carry over.
import { useEffect, useState } from 'react';
import { AGENT_IDS, type AgentId } from '../../../../shared/properties/ai/agentIds';
import { AGENT_PRESENTATION } from '../../../../shared/properties/ai/agentPresentation';
import type { ChatId, ChatOption } from '../../../../shared/properties/ai/chatModel';
import { aiChatUpdate } from '../aiBridge';
import { agentBadge } from '../agentSwitch';
import { rememberedSettings, rememberSetting, setChatOption, type AiState } from '../aiStore';
import type { ChatView } from '../chatReducer';
import { ContextRing } from './ContextRing';
import { modeOptionIds, optionById, type ComposerSettings } from './composerSettings';
import { ModeMenu } from './ModeMenu';
import { ModelMenu } from './ModelMenu';

/** The mode a new chat starts in, mirroring `ADAPTERS[*].askMode` in the main process (the one that asks before it changes anything). */
const NEW_CHAT_MODE: Readonly<Record<AgentId, string>> = { claude: 'default', codex: 'read-only' };

/** Modes chosen before the chat started, per chat and option; applied to the chat's session when it starts. */
const startModes = new Map<string, string>();
const startKey = (chat: ChatId, optionId: string): string => `${chat}:${optionId}`;

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
  const [, setRevision] = useState(0);
  const started = view.items.some((item) => item.kind === 'user');
  const live = view.options.length > 0;
  const running = view.running !== undefined;
  // Once the session is live the agent holds the mode; what was chosen before it is no longer needed.
  useEffect(() => {
    if (live) {
      for (const optionId of modeOptionIds(agent)) {
        startModes.delete(startKey(chatId, optionId));
      }
    }
  }, [live, agent, chatId]);
  const remembered = new Map(rememberedSettings(agent).map((setting) => [setting.option, setting.value]));
  const modeIds = modeOptionIds(agent);
  const valueOf = (option: ChatOption): string => {
    if (live) {
      return option.currentValue;
    }
    // A new chat's mode is the one that asks first (and Codex's plan switch is off), not whatever the last session ended on.
    const modeDefault = option.id === AGENT_PRESENTATION[agent].modes.optionId ? NEW_CHAT_MODE[agent] : 'default';
    const chosen = modeIds.includes(option.id) ? (startModes.get(startKey(chatId, option.id)) ?? modeDefault) : remembered.get(option.id);
    // Only a value the agent still offers counts.
    const offered = chosen !== undefined && option.choices.some((choice) => choice.value === chosen);
    return offered ? chosen : option.currentValue;
  };
  const options = (live ? view.options : (state.agentOptions.get(agent) ?? [])).map((option) => ({ ...option, currentValue: valueOf(option) }));
  const storeBeforeStart = (): void => {
    const projectPath = state.projectPath;
    if (projectPath === undefined) {
      return;
    }
    const settings = [
      ...rememberedSettings(agent).filter((setting) => !modeIds.includes(setting.option)),
      ...modeIds.flatMap((optionId) => {
        const value = startModes.get(startKey(chatId, optionId));
        return value === undefined ? [] : [{ option: optionId, value }];
      }),
    ];
    void aiChatUpdate({ projectPath, chat: chatId, settings });
  };
  const pick = (optionId: string, value: string): void => {
    const isMode = modeIds.includes(optionId);
    if (live) {
      if (!isMode) {
        rememberSetting(agent, optionId, value);
      }
      void setChatOption(chatId, optionId, value);
    } else if (isMode) {
      startModes.set(startKey(chatId, optionId), value);
      storeBeforeStart();
    } else {
      rememberSetting(agent, optionId, value);
      storeBeforeStart();
    }
    setRevision((revision) => revision + 1);
  };
  const agentBadges = Object.fromEntries(
    AGENT_IDS.flatMap((id) => {
      const badge = agentBadge(state, id);
      return badge === undefined ? [] : [[id, badge]];
    }),
  );
  const settings: ComposerSettings = { agent, chat: chatId, started, running, options, pick, agentBadges };
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
