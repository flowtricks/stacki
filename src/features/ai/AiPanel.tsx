// The AI chat panel: chats with the person's own Claude and Codex, driven
// through the Agent Client Protocol by the main process (electron/handlers/ai/).
// Stacki never asks for an API key or a password: an agent that needs signing
// in is signed in by the person, in Stacki's terminal, with the agent's own CLI.
//
// The panel is a frame-agnostic pair: `renderFrame` receives its header and
// body, so the app can put them in the docked left panel or a floating window
// (DockableWindow) without the panel knowing which.
import { useEffect, useMemo, type ReactNode } from 'react';
import type { AgentAvailability, ReviewOutcome, SetupState } from '../../../shared/ipc/aiChat';
import type { WireMergeClash } from '../../../shared/ipc/ipcWire';
import type { MergeResolution } from '../../../shared/ipc/mergeResolution';
import { AGENTS, agentLabel, type AgentId } from '../../../shared/properties/ai/agentIds';
import type { ChatId, TurnId } from '../../../shared/properties/ai/chatModel';
import { ErrorToast } from '../../ui/ErrorToast';
import {
  dismissAiError,
  EMPTY_DRAFT,
  installAgent,
  loadAiProject,
  openStartingChat,
  runSetup,
  reviewChange,
  sendPrompt,
  setPanelVisibility,
  trustProject,
  useAiState,
  type AiState,
} from './aiStore';
import { ChatComposer } from './composer/ChatComposer';
import { AccountRow, SetupCard } from './SetupCard';
import { SIGNED_IN_MS, SIGNED_IN_RETRY_MS, SignInCard, SignedInStrip, signInStage, useSignedInMoment, type SignInStage } from './SignInCard';
import { readSignInFailures } from './signInTranscript';
import { PlanCard } from './transcript/PlanCard';
import { Transcript } from './transcript/TranscriptView';
import { ChatHeader } from './sessions/ChatHeader';
import { SessionsView } from './sessions/SessionsView';
import { EMPTY_CHAT } from './chatReducer';
import './aiShell.css';

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
}

export default function AiPanel(props: AiPanelProps) {
  const state = useAiState();
  // Each time the panel opens: read the project's agents and chats, then go straight to a chat.
  useEffect(() => {
    void loadAiProject(props.projectPath).then(() => openStartingChat());
  }, [props.projectPath]);
  // The panel is on screen while it is mounted: a turn that ends in the open chat is read at once.
  useEffect(() => {
    setPanelVisibility('visible');
    return () => setPanelVisibility('hidden');
  }, []);
  const chat = state.open === undefined ? undefined : state.chats.find((candidate) => candidate.id === state.open);
  const header = <ChatHeader chat={chat} />;
  const body = (
    <div className="ai-body">
      {state.error !== undefined && <ErrorToast message={state.error} recovery={[{ label: 'Dismiss', run: dismissAiError }]} />}
      {!state.loaded ? (
        <div className="ai-skeleton" role="status" aria-label="Loading chats">
          {[0, 1, 2].map((row) => (
            <span key={row} className="ai-skeleton-row" />
          ))}
        </div>
      ) : chat === undefined ? (
        <SessionsView chats={state.chats} />
      ) : (
        <ChatPane {...props} state={state} chatId={chat.id} agent={chat.agent} />
      )}
    </div>
  );
  return <>{props.renderFrame(header, body)}</>;
}

function ChatPane(props: AiPanelProps & { readonly state: AiState; readonly chatId: ChatId; readonly agent: AgentId }) {
  const { state, chatId, agent, projectPath } = props;
  const view = state.views.get(chatId) ?? EMPTY_CHAT;
  const draft = state.drafts.get(chatId) ?? EMPTY_DRAFT;
  const availability = state.agents.find((entry) => entry.agent === agent);
  const setup = state.setups.get(agent);
  const reading = useMemo(() => readSignInFailures(view.items), [view.items]);
  const stage = signInStage({ setup, expired: availability?.state === 'sign-in' });
  const retryText = view.running === undefined && reading.interrupted ? view.lastPrompt?.text : undefined;
  const moment = useSignedInMoment({ agent, needed: stage !== undefined, holdMs: retryText === undefined ? SIGNED_IN_MS : SIGNED_IN_RETRY_MS });
  const started = view.items.some((item) => item.kind === 'user');
  const blocked = !state.trusted ? 'Allow agents in this project first' : composerBlock({ agent, availability, stage, started });
  const review = (turn: TurnId, path: string, action: 'keep' | 'undo'): Promise<void> => runReview(props, chatId, turn, path, action);
  const retry = retryText === undefined ? undefined : (): void => void sendPrompt(chatId, retryText);
  // Where the agent's CLI stands is read again each time a chat with it opens, and after each step.
  useEffect(() => {
    void runSetup(agent, { kind: 'detect' });
  }, [agent, chatId]);
  return (
    <>
      {view.plan !== undefined && view.plan.entries.length > 0 && <PlanCard plan={view.plan} chat={chatId} />}
      <Transcript
        view={view}
        reading={reading}
        retryHeldByCard={stage !== undefined || moment.shown}
        projectPath={projectPath}
        chatId={chatId}
        onReview={review}
        onOpenFile={props.onOpenFile}
      />
      {!state.trusted ? (
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
          setup={setup}
          stage={stage}
          details={reading.interrupted ? reading.details : undefined}
        />
      )}
      <ChatComposer chat={chatId} agent={agent} view={view} draft={draft} projectPath={projectPath} disabled={blocked} state={state} />
    </>
  );
}

/** Why the composer cannot send, in words that say what to do; undefined when it can. */
function composerBlock({
  agent,
  availability,
  stage,
  started,
}: {
  readonly agent: AgentId;
  readonly availability: AgentAvailability | undefined;
  readonly stage: SignInStage | undefined;
  readonly started: boolean;
}): string | undefined {
  const label = agentLabel(agent);
  if (stage !== undefined) {
    return started ? `Sign in to ${label} to keep chatting` : `Sign in to ${label} to start chatting`;
  }
  return availability?.state === 'ready' ? undefined : `Set up ${label} to start chatting`;
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
  props: AiPanelProps & {
    readonly availability: AgentAvailability | undefined;
    readonly agent: AgentId;
    readonly setup: SetupState | undefined;
    readonly stage: SignInStage | undefined;
    readonly details: string | undefined;
  },
) {
  const { availability, agent, setup, stage } = props;
  const label = agentLabel(agent);
  // A sign-in, whatever its cause, is one card (SignInCard): never also a notice, a retry and a second card.
  if (stage !== undefined) {
    return <SignInCard agent={agent} stage={stage} details={props.details} onOpenExternal={props.onOpenExternal} onOpenTerminal={props.onOpenTerminal} />;
  }
  // The person's own CLI first (install), by buttons; then Stacki's connector.
  if (setup !== undefined && setup.step !== 'ready' && setup.step !== 'signed-out' && setup.step !== 'signing-in') {
    return <SetupCard setup={setup} />;
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
      return undefined; // Unreachable: `stage` already covers an expired sign-in.
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
