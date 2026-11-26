// The AI chat panel: chats with the person's own Claude and Codex, driven
// through the Agent Client Protocol by the main process (electron/handlers/ai/).
// Stacki never asks for an API key or a password: an agent that needs signing
// in is signed in by the person, in Stacki's terminal, with the agent's own CLI.
//
// The panel is a frame-agnostic pair: `renderFrame` receives its header and
// body, so the app can put them in the docked left panel or a floating window
// (DockableWindow) without the panel knowing which.
//
// The panel measures its own body and lays itself out for that width (chatLayout.ts): one column that shows
// the list or a chat when narrow, and the list as a sidebar beside the chat when wide (an expanded panel or a
// wide window). Ctrl+Tab and Ctrl+Shift+Tab step through the chats in the list's order in either layout.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefCallback,
} from 'react';
import type { AgentAvailability, ReviewOutcome, SetupState } from '../../../shared/ipc/aiChat';
import type { WireMergeClash } from '../../../shared/ipc/ipcWire';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { AGENTS, AGENT_IDS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatId, TurnId } from '../../../shared/properties/ai/chatModel';
import type { Translator } from '../../lib/i18n/localeContext';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { PlusIcon } from '../../ui/Icons';
import {
  dismissAiError,
  EMPTY_DRAFT,
  installAgent,
  loadAiProject,
  newChat,
  openChat,
  preferredAgent,
  openStartingChat,
  runSetup,
  reviewChange,
  sendPrompt,
  setPanelVisibility,
  useAiState,
  type AiState,
} from './aiStore';
import { loadReviewMode } from './reviewChanges';
import { ChatComposer } from './composer/ChatComposer';
import { usePrewarm } from './prewarm';
import { agentBadge, type AgentBadge } from './agentSwitch';
import { SetupCard } from './SetupCard';
import { TrustCard } from './TrustCard';
import { McpSignInCard } from './McpSignInCard';
import { BillingWarning, billingWarning } from './BillingWarning';
import { SIGNED_IN_MS, SIGNED_IN_RETRY_MS, SignInCard, SignedInStrip, signInStage, useSignedInMoment, type SignInStage } from './SignInCard';
import { readSignInFailures } from './signInTranscript';
import { PlanCard } from './transcript/PlanCard';
import { RunningChip } from './transcript/RunningPanel';
import { ChatTranscript } from './transcript/SubagentPane';
import { ChatHeader, type PanelExpansion, type PanelWindow } from './sessions/ChatHeader';
import { SessionsView } from './sessions/SessionsView';
import { NoChats } from './sessions/ListStates';
import { groupSessions, listOrder } from './sessions/sessionsModel';
import { chatLayoutFor, chatStepFor, stepThrough, type ChatLayout } from './chatLayout';
import { EMPTY_CHAT } from './chatReducer';
import { AgentChoiceNotices, AgentChoicesDialog } from './AgentChoices';
import { loadAgentChoices } from './agentChoiceStore';
import './aiShell.css';
import { useAiHold } from './aiHold'; // Design mode (experimental): docs/design-mode/REMOVE.md

export interface AiPanelProps {
  readonly projectPath: string;
  /** Opens the terminal dock on a new tab running `command` (an agent's sign-in). */
  readonly onOpenTerminal: (command: string) => void;
  /** Shows the merge editor for an undo whose file moved on; `settle` hears the choice, or undefined when cancelled. */
  readonly onMerge: (clash: WireMergeClash, settle: (resolution: MergeResolution | undefined) => void) => void;
  readonly onOpenExternal: (url: string) => void;
  /** Shows a project file in the editor (the changes card's "Open file"); a path relative to the project. Without it the action is not offered. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly renderFrame: (header: ReactNode, body: ReactNode) => ReactNode;
  /** The host's expand toggle (the panel over the editor area); absent where the host has none. */
  readonly expansion?: PanelExpansion | undefined;
  /** The host's pop out / dock toggle, offered in the header's menu; absent where the host has none. */
  readonly windowToggle?: PanelWindow | undefined;
}

export default function AiPanel(props: AiPanelProps) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const state = useAiState();
  // Each time the panel opens: read the project's agents and chats, then go straight to a chat.
  useEffect(() => {
    void loadAiProject(props.projectPath).then(() => openStartingChat());
    // The agent chosen for each surface, and the project's definitions it is checked against.
    void loadAgentChoices(props.projectPath);
  }, [props.projectPath]);
  // Whether changes wait for Keep is the person's setting, read once the panel opens.
  useEffect(() => {
    void loadReviewMode();
  }, []);
  // The panel is on screen while it is mounted: a turn that ends in the open chat is read at once.
  useEffect(() => {
    setPanelVisibility('visible');
    return () => setPanelVisibility('hidden');
  }, []);
  const chat = state.open === undefined ? undefined : state.chats.find((candidate) => candidate.id === state.open);
  const { ref: bodyRef, widthPx } = useBodyWidth();
  // With no chats and no sections there is nothing for a sidebar to hold: a wide panel shows the one card, not two.
  const layout = state.chats.length === 0 && state.sections.length === 0 ? 'stacked' : chatLayoutFor(widthPx);
  const header = <ChatHeader chat={chat} layout={layout} expansion={props.expansion} windowToggle={props.windowToggle} />;
  const onBodyKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const direction = chatStepFor(event);
    if (direction === undefined || event.defaultPrevented) {
      return;
    }
    const order = listOrder(groupSessions(state.chats, state.sections, state.filter).groups).map((candidate) => candidate.id);
    const target = stepThrough(order, state.open, direction);
    event.preventDefault();
    if (target !== undefined) {
      void openChat(target);
    }
  };
  const body = (
    <div ref={bodyRef} className={`ai-body is-${layout}`} onKeyDown={onBodyKeyDown}>
      {state.error !== undefined && (
        <ErrorToast
          message={translateDescribed({ message: state.error, messageRef: state.errorRef })}
          recovery={[{ label: translate('ai.panel.dismiss'), run: dismissAiError }]}
        />
      )}
      {!state.loaded ? <ChatListSkeleton /> : <PanelContent {...props} layout={layout} state={state} chat={chat} />}
    </div>
  );
  return <>{props.renderFrame(header, body)}</>;
}

/** The panel's first paint, before the chat list is read: placeholders in the shape of its rows, an agent's mark and two lines. */
function ChatListSkeleton() {
  return (
    <div className="ai-skeleton">
      <SkeletonRows
        count={4}
        row={(widthPercent) => (
          <div className="ai-skeleton-row">
            <Skeleton width="16px" height="16px" />
            <span className="ai-skeleton-lines">
              <Skeleton width={`${widthPercent}%`} />
              <Skeleton width="30%" height="8px" />
            </span>
          </div>
        )}
      />
    </div>
  );
}

/**
 * The body's content for its layout. Stacked: the list, or the open chat. Split: the list as a sidebar on the
 * inline-start side with the open chat beside it, or, with none open, a line that says how to start. The sidebar
 * is the same list, so its search, grouping and menus are the ones the narrow panel has.
 */
function PanelContent(props: AiPanelProps & { readonly layout: ChatLayout; readonly state: AiState; readonly chat: AiState['chats'][number] | undefined }) {
  const { layout, state, chat } = props;
  const translate = useTranslate();
  if (layout === 'stacked') {
    return chat === undefined ? <SessionsView chats={state.chats} /> : <ChatPane {...props} state={state} chatId={chat.id} agent={chat.agent} />;
  }
  return (
    <>
      <nav className="ai-sidebar" aria-label={translate('ai.panel.chatList')}>
        <SessionsView chats={state.chats} selected={chat?.id} layout="split" />
      </nav>
      <div className="ai-main">
        {chat === undefined && state.chats.every((candidate) => candidate.archivedAt !== undefined) ? (
          <div className="ai-pick">
            <NoChats />
          </div>
        ) : chat === undefined ? (
          <div className="ai-pick">
            <p>{translate('ai.panel.pickChat')}</p>
            <button className="ai-primary ai-sessions-start" onClick={() => void newChat(preferredAgent())}>
              <PlusIcon size={12} /> {translate('ai.sessions.newChat')}
            </button>
          </div>
        ) : (
          // Keyed by chat, so a switch replaces the column in one frame instead of showing the old chat's state with the new one's data.
          <ChatPane key={chat.id} {...props} state={state} chatId={chat.id} agent={chat.agent} />
        )}
      </div>
    </>
  );
}

/**
 * The body's width, read before the first paint (a layout effect) and on every resize after, so a wide panel
 * opens split rather than drawing one column for a frame first.
 */
function useBodyWidth(): { readonly ref: RefCallback<HTMLDivElement>; readonly widthPx: number | undefined } {
  const [element, setElement] = useState<HTMLDivElement | undefined>(undefined);
  // React hands a callback ref the platform's null when the element goes; the state says absence with undefined.
  const ref = useCallback<RefCallback<HTMLDivElement>>((next) => setElement(next ?? undefined), []);
  const [widthPx, setWidthPx] = useState<number | undefined>(undefined);
  const observer = useRef<ResizeObserver | undefined>(undefined);
  useLayoutEffect(() => {
    if (element === undefined) {
      return undefined;
    }
    setWidthPx(Math.floor(element.getBoundingClientRect().width));
    observer.current = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry !== undefined) {
        setWidthPx(Math.floor(entry.contentRect.width));
      }
    });
    observer.current.observe(element);
    return () => observer.current?.disconnect();
  }, [element]);
  return { ref, widthPx };
}

function ChatPane(props: AiPanelProps & { readonly state: AiState; readonly chatId: ChatId; readonly agent: AgentId }) {
  const { state, chatId, agent, projectPath } = props;
  const translate = useTranslate();
  const view = state.views.get(chatId) ?? EMPTY_CHAT;
  const draft = state.drafts.get(chatId) ?? EMPTY_DRAFT;
  const availability = state.agents.find((entry) => entry.agent === agent);
  const setup = state.setups.get(agent);
  const reading = useMemo(() => readSignInFailures(view.items), [view.items]);
  const stage = signInStage({ setup, expired: availability?.state === 'sign-in' });
  const retryText = view.running === undefined && reading.interrupted ? view.lastPrompt?.text : undefined;
  const moment = useSignedInMoment({ agent, needed: stage !== undefined, holdMs: retryText === undefined ? SIGNED_IN_MS : SIGNED_IN_RETRY_MS });
  const started = view.items.some((item) => item.kind === 'user');
  const [choosingAgents, setChoosingAgents] = useState(false);
  const badges = Object.fromEntries(
    AGENT_IDS.flatMap((id) => {
      const badge = agentBadge(state, id);
      return badge === undefined ? [] : [[id, badge]];
    }),
  );
  const hold = useAiHold(); // Design mode (experimental): docs/design-mode/REMOVE.md
  const blocked = hold ?? (!state.trusted ? translate('ai.panel.trustFirst') : composerBlock({ agent, availability, stage, started, translate }));
  const review = (turn: TurnId, path: string, action: 'keep' | 'undo'): Promise<void> => runReview(props, chatId, turn, path, action);
  const retry = retryText === undefined ? undefined : (): void => void sendPrompt(chatId, retryText);
  // Start the agent early, invisibly, once it is installed, signed in and allowed here; let go when the chat starts or the panel closes.
  usePrewarm({
    projectPath,
    agent,
    eligible: hold === undefined && state.trusted && availability?.state === 'ready' && setup?.step === 'ready' && stage === undefined && !started,
  });
  // Where the agent's CLI stands is read again each time a chat with it opens, and after each step.
  useEffect(() => {
    if (hold === undefined) {
      void runSetup(agent, { kind: 'detect' });
    }
  }, [agent, chatId, hold]);
  useRecheckOnFocus(agent, hold === undefined && setup?.step === 'unchecked' ? 'while-unchecked' : 'never');
  return (
    <>
      <AgentChoiceNotices onChoose={() => setChoosingAgents(true)} />
      {choosingAgents && <AgentChoicesDialog onClose={() => setChoosingAgents(false)} />}
      {view.plan !== undefined && view.plan.entries.length > 0 && <PlanCard plan={view.plan} chat={chatId} />}
      <ChatTranscript
        view={view}
        reading={reading}
        retryHeldByCard={stage !== undefined || moment.shown}
        projectPath={projectPath}
        chatId={chatId}
        onReview={review}
        onOpenFile={props.onOpenFile}
      />
      {hold !== undefined ? undefined : !state.trusted ? (
        <TrustCard />
      ) : moment.shown ? (
        <SignedInStrip
          onRetry={
            retry === undefined
              ? undefined
              : () => {
                  moment.dismiss();
                  retry();
                }
          }
        />
      ) : (
        <AgentGate
          {...props}
          availability={availability}
          agent={agent}
          chatId={chatId}
          started={started}
          badges={badges}
          setup={setup}
          stage={stage}
          details={reading.interrupted ? reading.details : undefined}
        />
      )}
      <McpSignInCard
        projectPath={projectPath}
        agent={agent}
        items={view.items}
        eligible={hold === undefined && state.trusted && availability?.state === 'ready'}
      />
      {/* A stopped turn's warning is the sign-in card itself; extra usage goes on, so its warning stands here. */}
      {billingWarning(setup) === 'extra-usage' && <BillingWarning kind="extra-usage" />}
      <RunningChip view={view} chatId={chatId} projectPath={projectPath} />
      <ChatComposer chat={chatId} agent={agent} view={view} draft={draft} projectPath={projectPath} disabled={blocked} state={state} />
    </>
  );
}

/** While the sign-in could not be checked, coming back to the window checks it again. */
function useRecheckOnFocus(agent: AgentId, recheck: 'while-unchecked' | 'never'): void {
  useEffect(() => {
    if (recheck === 'never') {
      return undefined;
    }
    const detect = (): void => void runSetup(agent, { kind: 'detect' });
    window.addEventListener('focus', detect);
    return () => window.removeEventListener('focus', detect);
  }, [agent, recheck]);
}

/** Why the composer cannot send, in words that say what to do; undefined when it can. */
function composerBlock({
  agent,
  availability,
  stage,
  started,
  translate,
}: {
  readonly agent: AgentId;
  readonly availability: AgentAvailability | undefined;
  readonly stage: SignInStage | undefined;
  readonly started: boolean;
  readonly translate: Translator;
}): string | undefined {
  const label = agentLabel(agent);
  if (stage !== undefined) {
    return started ? translate('ai.panel.signInToKeep', { agent: label }) : translate('ai.panel.signInToStart', { agent: label });
  }
  return availability?.state === 'ready' ? undefined : translate('ai.panel.setUpToStart', { agent: label });
}

function AgentGate(
  props: AiPanelProps & {
    readonly availability: AgentAvailability | undefined;
    readonly agent: AgentId;
    readonly chatId: ChatId;
    readonly started: boolean;
    readonly badges: Readonly<Partial<Record<AgentId, AgentBadge>>>;
    readonly setup: SetupState | undefined;
    readonly stage: SignInStage | undefined;
    readonly details: string | undefined;
  },
) {
  const { availability, agent, setup, stage } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const { formatNumber } = useFormat();
  const label = agentLabel(agent);
  // A sign-in, whatever its cause, is one card (SignInCard): never also a notice, a retry and a second card.
  if (stage !== undefined) {
    return <SignInCard agent={agent} stage={stage} details={props.details} onOpenExternal={props.onOpenExternal} onOpenTerminal={props.onOpenTerminal} />;
  }
  // The person's own CLI first (install), by buttons; then Stacki's connector.
  // A sign-in that could not be checked is no gate: the note under the composer says so, and the person can send.
  if (setup !== undefined && setup.step !== 'ready' && setup.step !== 'signed-out' && setup.step !== 'unchecked' && setup.step !== 'signing-in') {
    return <SetupCard setup={setup} />;
  }
  if (availability === undefined || availability.state === 'ready') {
    return undefined;
  }
  switch (availability.state) {
    case 'missing-cli':
      return (
        <div className="ai-gate">
          <strong>{translate('ai.gate.missing.title', { agent: label })}</strong>
          <p>{translate('ai.gate.missing.text', { agent: label })}</p>
          <button onClick={() => props.onOpenExternal(AGENTS[agent].installURL)}>{translate('ai.gate.missing.how', { agent: label })}</button>
        </div>
      );
    case 'needs-install':
      return (
        <div className="ai-gate">
          <strong>{translate('ai.gate.connect.title', { agent: label })}</strong>
          <p>
            {translate('ai.gate.connect.text', {
              agent: label,
              megabytes: formatNumber(availability.downloadMegabytes),
              version: availability.adapterVersion,
            })}
          </p>
          <button className="ai-primary" onClick={() => void installAgent(agent)}>
            {translate('ai.gate.connect.action')}
          </button>
        </div>
      );
    case 'installing':
      return (
        <div className="ai-gate" role="status">
          <strong>{translate('ai.gate.connecting', { agent: label })}</strong>
        </div>
      );
    case 'sign-in':
      return undefined; // Unreachable: `stage` already covers an expired sign-in.
    case 'failed':
      return (
        <div className="ai-gate">
          <strong>{translate('ai.gate.failed.title', { agent: label })}</strong>
          <p>{translateDescribed({ message: availability.message, messageRef: availability.messageRef })}</p>
          <button onClick={() => void installAgent(agent)}>{translate('ai.common.tryAgain')}</button>
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
