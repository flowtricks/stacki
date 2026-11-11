// The AI chat panel: chats with the person's own Claude and Codex, driven
// through the Agent Client Protocol by the main process (electron/handlers/ai/).
// Stacki never asks for an API key or a password: an agent that needs signing
// in is signed in by the person, in Stacki's terminal, with the agent's own CLI.
//
// The panel is a frame-agnostic pair: `renderFrame` receives its header and
// body, so the app can put them in the docked left panel or a floating window
// (DockableWindow) without the panel knowing which.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentAvailability, ReviewOutcome, SetupState } from '../../../shared/ipc/aiChat';
import type { WireMergeClash } from '../../../shared/ipc/ipcWire';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { AGENTS, AGENT_IDS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatId, ChatOption, TurnId, TurnStop } from '../../../shared/properties/ai/chatModel';
import { ClaudeLogo, CodexLogo } from '../../ui/agentLogos';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import { ChevronLeftIcon, PlusIcon, SparkleIcon, TerminalIcon } from '../../ui/Icons';
import {
  answerPermission,
  dismissAiError,
  installAgent,
  loadAiProject,
  newChat,
  openChat,
  openStartingChat,
  preferredAgent,
  rememberAgent,
  rememberedSettings,
  rememberSetting,
  setChatOption,
  switchProvider,
  updateChatSettings,
  runSetup,
  reviewChange,
  sendPrompt,
  trustProject,
  useAiState,
  type AiState,
} from './aiStore';
import { ChatComposer } from './ChatComposer';
import { AccountRow, SetupCard } from './SetupCard';
import { EffortControl, isEffort } from './EffortControl';
import { ChangesCard, PermissionCard, PlanStrip, ToolCard } from './ChatItems';
import { ChatList } from './ChatList';
import { ChatText } from './ChatText';
import { EMPTY_CHAT, type ChatView, type TranscriptItem } from './chatReducer';
import './ai.css';

export interface AiPanelProps {
  readonly projectPath: string;
  /** Opens the terminal dock on a new tab running `command` (an agent's sign-in). */
  readonly onOpenTerminal: (command: string) => void;
  /** Shows the merge editor for an undo whose file moved on; `settle` hears the choice, or undefined when cancelled. */
  readonly onMerge: (clash: WireMergeClash, settle: (resolution: MergeResolution | undefined) => void) => void;
  readonly onOpenExternal: (url: string) => void;
  readonly renderFrame: (header: ReactNode, body: ReactNode) => ReactNode;
}

export default function AiPanel(props: AiPanelProps) {
  const state = useAiState();
  // Each time the panel opens: read the project's agents and chats, then go straight to a chat.
  useEffect(() => {
    void loadAiProject(props.projectPath).then(() => openStartingChat());
  }, [props.projectPath]);
  const chat = state.open === undefined ? undefined : state.chats.find((candidate) => candidate.id === state.open);
  const header = (
    <div className="ai-header">
      {chat !== undefined && (
        <button className="ghost" aria-label="All chats" title="All chats" onClick={() => void openChat(undefined)}>
          <ChevronLeftIcon size={12} />
        </button>
      )}
      <SparkleIcon size={14} />
      <h2 title={chat?.title}>{chat?.title ?? 'AI chat'}</h2>
      <button className="ghost" aria-label="New chat" title="New chat" onClick={() => void newChat(preferredAgent())}>
        <PlusIcon size={14} />
      </button>
    </div>
  );
  const body = (
    <div className="ai-body">
      {state.error !== undefined && <ErrorToast message={state.error} recovery={[{ label: 'Dismiss', run: dismissAiError }]} />}
      {!state.loaded ? (
        <p className="ai-empty">Loading…</p>
      ) : chat === undefined ? (
        <>
          <ChatList chats={state.chats} />
        </>
      ) : (
        <ChatPane {...props} state={state} chatId={chat.id} agent={chat.agent} />
      )}
    </div>
  );
  return <>{props.renderFrame(header, body)}</>;
}

// The composer's own settings, as Claude's and ChatGPT's composers have them: the provider (with its
// mark), then the model and effort it offers. Before the chat's first message the provider and the
// settings apply to this chat; after it, another provider starts a new chat and keeps this one, and a
// model or effort change applies to the next message (both agents change them mid-session).
function ComposerSettings({
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
  const remembered = new Map(rememberedSettings(agent).map((setting) => [setting.option, setting.value]));
  const offered = (live ? view.options : (state.agentOptions.get(agent) ?? [])).filter(
    (option) => option.category === 'model' || option.category === 'thought_level' || (live && option.category === 'mode'),
  );
  const ordered = [...offered].sort((left, right) => optionRank(left) - optionRank(right));
  const running = view.running !== undefined;
  return (
    <>
      <Dropdown
        ariaLabel="Agent"
        className="ai-option ai-provider"
        value={agent}
        disabled={running}
        livePreview={false}
        menuWidthMin={200}
        options={AGENT_IDS.map((id) => ({
          value: id,
          label: agentLabel(id),
          icon: <AgentLogo agent={id} />,
          ...(started && id !== agent ? { hint: 'Switches to a new chat' } : {}),
        }))}
        onChange={(next) => {
          if (next !== agent) {
            rememberAgent(next);
            void switchProvider(chatId, next, { started });
          }
        }}
      />
      {ordered.map((option) => {
        const value = live ? option.currentValue : remembered.get(option.id);
        const current = value !== undefined && option.choices.some((choice) => choice.value === value) ? value : option.currentValue;
        const pick = (chosen: string): void => {
          rememberSetting(agent, option.id, chosen);
          setRevision((revision) => revision + 1);
          void (live ? setChatOption(chatId, option.id, chosen) : updateChatSettings(chatId, agent));
        };
        return isEffort(option) ? (
          <EffortControl key={option.id} option={option} value={current} disabled={running} onPick={pick} />
        ) : (
          <Dropdown
            key={option.id}
            ariaLabel={option.name}
            className="ai-option"
            value={current}
            disabled={running}
            livePreview={false}
            optionLayout="stacked"
            menuWidthMin={240}
            options={option.choices.map((choice) => ({
              value: choice.value,
              label: choice.name,
              ...(choice.description === undefined ? {} : { description: choice.description }),
            }))}
            onChange={pick}
          />
        );
      })}
    </>
  );
}

function optionRank(option: ChatOption): number {
  const order = ['model', 'thought_level', 'mode'];
  const index = order.indexOf(option.category ?? option.id);
  return index === -1 ? order.length : index;
}

function AgentLogo({ agent }: { readonly agent: AgentId }) {
  switch (agent) {
    case 'claude':
      return <ClaudeLogo size={16} />;
    case 'codex':
      return <CodexLogo size={16} className="ai-logo-codex" />;
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

function ChatPane(props: AiPanelProps & { readonly state: AiState; readonly chatId: ChatId; readonly agent: AgentId }) {
  const { state, chatId, agent, projectPath } = props;
  const view = state.views.get(chatId) ?? EMPTY_CHAT;
  const draft = state.drafts.get(chatId) ?? { text: '', attachments: [] };
  const availability = state.agents.find((entry) => entry.agent === agent);
  const blocked = !state.trusted ? 'Allow agents in this project first' : availability?.state === 'ready' ? undefined : `${agentLabel(agent)} is not ready`;
  const review = (turn: TurnId, path: string, action: 'keep' | 'undo'): void => void runReview(props, chatId, turn, path, action);
  // Where the agent's CLI stands is read again each time a chat with it opens, and after each step.
  useEffect(() => {
    void runSetup(agent, { kind: 'detect' });
  }, [agent, chatId]);
  return (
    <>
      {view.plan !== undefined && view.plan.entries.length > 0 && <PlanStrip plan={view.plan} />}
      <Transcript view={view} projectPath={projectPath} chatId={chatId} onReview={review} />
      {!state.trusted ? <TrustCard /> : <AgentGate {...props} availability={availability} agent={agent} setup={state.setups.get(agent)} />}
      <ChatComposer
        chat={chatId}
        agent={agent}
        view={view}
        draft={draft}
        projectPath={projectPath}
        disabled={blocked}
        settings={<ComposerSettings state={state} chatId={chatId} agent={agent} view={view} />}
      />
      {view.usage !== undefined && view.usage.size > 0 && (
        <div className="ai-usage" title="Context used">
          {Math.round((view.usage.used / view.usage.size) * 100)}% of context used
        </div>
      )}
    </>
  );
}

function Transcript({
  view,
  projectPath,
  chatId,
  onReview,
}: {
  readonly view: ChatView;
  readonly projectPath: string;
  readonly chatId: ChatId;
  readonly onReview: (turn: TurnId, path: string, action: 'keep' | 'undo') => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const element = scroll.current;
    if (element === null) {
      return;
    }
    if (follow.current) {
      element.scrollTop = element.scrollHeight;
    } else {
      setBehind(true);
    }
  }, [view.items]);
  const lastEnd = [...view.items].reverse().find((item) => item.kind === 'turn-end');
  const canRetry = view.running === undefined && lastEnd?.kind === 'turn-end' && lastEnd.stop !== 'end_turn' && view.lastPrompt !== undefined;
  return (
    <div
      className="ai-transcript"
      ref={scroll}
      role="log"
      aria-label="Conversation"
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (follow.current) {
          setBehind(false);
        }
      }}
    >
      {view.items.length === 0 && <p className="ai-empty">Ask for a change, or a question about this project.</p>}
      {view.items.map((item, index) => (
        <Item key={index} item={item} projectPath={projectPath} chatId={chatId} onReview={onReview} />
      ))}
      {view.running !== undefined && (
        <div className="ai-working" role="status">
          <span className="ai-working-dot" />
          Working…
        </div>
      )}
      {canRetry && view.lastPrompt !== undefined && (
        <button className="ai-retry" onClick={() => void sendPrompt(chatId, view.lastPrompt?.text ?? '')}>
          Retry
        </button>
      )}
      {behind && (
        <button
          className="ai-latest"
          onClick={() => {
            const element = scroll.current;
            if (element !== null) {
              element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
            }
            follow.current = true;
            setBehind(false);
          }}
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}

function Item({
  item,
  projectPath,
  chatId,
  onReview,
}: {
  readonly item: TranscriptItem;
  readonly projectPath: string;
  readonly chatId: ChatId;
  readonly onReview: (turn: TurnId, path: string, action: 'keep' | 'undo') => void;
}) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="ai-message ai-message-user">
          <div className="ai-user-text">{item.text}</div>
          {item.attachments.length > 0 && <div className="ai-message-attachments">{item.attachments.map((attachment) => attachment.name).join(', ')}</div>}
        </div>
      );
    case 'text':
      return item.role === 'thought' ? (
        <details className="ai-thought">
          <summary>Thinking</summary>
          <ChatText text={item.text} />
        </details>
      ) : (
        <div className="ai-message ai-message-agent">
          <ChatText text={item.text} />
        </div>
      );
    case 'tool':
      return <ToolCard item={item} projectPath={projectPath} />;
    case 'permission':
      return <PermissionCard item={item} onAnswer={(optionId) => void answerPermission(chatId, item.request, optionId)} />;
    case 'changes':
      return <ChangesCard files={item.files} projectPath={projectPath} onReview={(path, action) => onReview(item.turn, path, action)} />;
    case 'notice':
      return <div className={`ai-notice ai-notice-${item.severity}`}>{item.text}</div>;
    case 'turn-end':
      return item.stop === 'end_turn' ? undefined : <div className="ai-notice ai-notice-warning">{turnEndText(item.stop, item.message)}</div>;
    case 'unsupported':
      return <div className="ai-notice ai-notice-info">{item.label}</div>;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}

function TrustCard() {
  return (
    <div className="ai-gate">
      <strong>Let agents work in this project?</strong>
      <p>Claude and Codex can read, change and run anything in this project. Their edits apply right away, and you keep or undo each file after.</p>
      <button className="ai-primary" onClick={() => void trustProject()}>
        Allow in this project
      </button>
    </div>
  );
}

function AgentGate(
  props: AiPanelProps & { readonly availability: AgentAvailability | undefined; readonly agent: AgentId; readonly setup: SetupState | undefined },
) {
  const { availability, agent, setup } = props;
  const label = agentLabel(agent);
  // The person's own CLI first (install, sign in), by buttons; then Stacki's connector.
  if (setup !== undefined && setup.step !== 'ready') {
    return <SetupCard setup={setup} onOpenExternal={props.onOpenExternal} />;
  }
  if (availability === undefined || availability.state === 'ready') {
    return setup?.step === 'ready' ? <AccountRow setup={setup} /> : undefined;
  }
  switch (availability.state) {
    case 'missing-cli':
      return (
        <div className="ai-gate">
          <strong>{label} is not installed</strong>
          <p>Install {label} on this computer, then sign in to it once. Stacki uses your own installation.</p>
          <button onClick={() => props.onOpenExternal(AGENTS[agent].installURL)}>How to install {label}</button>
        </div>
      );
    case 'needs-install':
      return (
        <div className="ai-gate">
          <strong>Connect {label}</strong>
          <p>
            Stacki needs a small connector to talk to {label} (about {availability.downloadMegabytes} MB, version {availability.adapterVersion}).
          </p>
          <button className="ai-primary" onClick={() => void installAgent(agent)}>
            Download and connect
          </button>
        </div>
      );
    case 'installing':
      return (
        <div className="ai-gate" role="status">
          <strong>Connecting {label}…</strong>
        </div>
      );
    case 'sign-in':
      // The CLI says it is signed in, but the agent refused: an expired sign-in. Sign in again, by button.
      return (
        <div className="ai-gate">
          <strong>Sign in to {label} again</strong>
          <p>Your {label} sign-in has expired. Your browser opens to finish.</p>
          <div className="ai-gate-actions">
            <button className="ai-primary" onClick={() => void runSetup(agent, { kind: 'signIn' })}>
              Sign in again
            </button>
            <button className="ghost" onClick={() => props.onOpenTerminal(AGENTS[agent].signInCommand)}>
              <TerminalIcon size={12} /> Use the terminal instead
            </button>
          </div>
        </div>
      );
    case 'failed':
      return (
        <div className="ai-gate">
          <strong>{label} could not start</strong>
          <p>{availability.message}</p>
          <button onClick={() => void installAgent(agent)}>Try again</button>
        </div>
      );
    default: {
      const exhaustive: never = availability;
      return exhaustive;
    }
  }
}

async function runReview(props: AiPanelProps, chat: ChatId, turn: TurnId, path: string, action: 'keep' | 'undo'): Promise<void> {
  const outcome: ReviewOutcome = await reviewChange(chat, turn, path, { kind: action });
  if (outcome.tag !== 'drifted') {
    return;
  }
  // The file moved on since the agent's edit: the person settles it in the merge editor.
  const resolution = await new Promise<MergeResolution | undefined>((resolve) => props.onMerge(outcome.clash, resolve));
  if (resolution !== undefined) {
    await reviewChange(chat, turn, path, { kind: 'resolve', resolution });
  }
}

function turnEndText(stop: TurnStop, message: string | undefined): string {
  switch (stop) {
    case 'cancelled':
      return 'Stopped.';
    case 'max_tokens':
      return 'The reply reached its length limit.';
    case 'max_turn_requests':
      return 'The agent reached its step limit for one message.';
    case 'refusal':
      return 'The agent declined this request.';
    case 'end_turn':
      return 'Done.';
    case 'error':
      return message ?? 'Something went wrong.';
    default: {
      const exhaustive: never = stop;
      return exhaustive;
    }
  }
}
