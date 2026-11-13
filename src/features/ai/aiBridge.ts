// The AI panel's side of the IPC boundary (shared/ipc/aiChat.ts): every payload
// is parsed before it is sent and every reply and push before a component sees
// it. A failed invoke (the main process threw) becomes a `Result` failure the
// panel can show, never an unhandled rejection.
import { err, type Result } from '../../../shared/core/result';
import { count } from '../../../shared/core/boundary';
import { parseIpcPayload, type IpcPayloads } from '../../../shared/ipc/ipcPayloads';
import {
  parseAgentAvailability,
  parseAiAgentsReply,
  parseAiEventsPush,
  parseAiResult,
  parseAiStatusPush,
  parseChatList,
  parseChatTranscript,
  parseCompactStarted,
  parseDiffReply,
  parseMentionReply,
  parsePromptTurn,
  parseSetupState,
  parseRememberedSettings,
  parseReviewOutcome,
  parseSteerReply,
  type AgentAvailability,
  type AiAgentsReply,
  type AiEventsPush,
  type AiFailure,
  type AiStatusPush,
  type ChatTranscript,
  type DiffReply,
  type ReviewOutcome,
  type SetupState,
  type SteerReply,
} from '../../../shared/ipc/aiChat';
import { parseChatSummary, type ChatList, type ChatSummary, type TurnId } from '../../../shared/properties/ai/chatModel';
import type { MentionCandidate } from '../../../shared/properties/ai/mentions';
import type { RememberedSettings } from '../../../shared/properties/ai/rememberedSettings';
import { described } from '../../../shared/properties/i18n/messageRef';
import { cleanError } from '../../lib/cleanError';

export type AiReply<T> = Result<T, AiFailure>;

async function call<T>(run: () => Promise<unknown>, parse: (input: unknown) => T): Promise<Result<T, AiFailure>> {
  let reply: unknown;
  try {
    reply = await run();
  } catch (error: unknown) {
    return err({ code: 'agent-failed', message: cleanError(error) });
  }
  try {
    return { ok: true, value: parse(reply) };
  } catch (error: unknown) {
    // A reply that does not parse is a failure the panel can show, not an exception that blanks it: the main
    // process and the renderer are built together, so this is a version mismatch or a bug worth a message.
    return err({ code: 'agent-failed', ...described('ai.bridge.unexpectedReply', { detail: cleanError(error) }) });
  }
}

async function callResult<T>(run: () => Promise<unknown>, parse: (input: unknown) => T): Promise<Result<T, AiFailure>> {
  const reply = await call(run, (input) => parseAiResult(input, parse));
  return reply.ok ? reply.value : reply;
}

export function aiAgents(projectPath: string): Promise<AiReply<AiAgentsReply>> {
  const payload = parseIpcPayload('ai:agents', { projectPath });
  return call(() => window.avb.aiAgents(payload), parseAiAgentsReply);
}

export function aiInstallAgent(input: IpcPayloads['ai:installAgent']): Promise<AiReply<AgentAvailability>> {
  const payload = parseIpcPayload('ai:installAgent', input);
  return callResult(() => window.avb.aiInstallAgent(payload), parseAgentAvailability);
}

export async function aiTrust(projectPath: string): Promise<AiReply<true>> {
  const payload = parseIpcPayload('ai:trust', { projectPath });
  return call(
    () => window.avb.aiTrust(payload),
    () => true as const,
  );
}

/**
 * Starts the agent early, or lets go of what an earlier start parked. Fire and forget: the reply
 * says nothing the panel shows, and a failure is the main process's log, never a message.
 */
export function aiPrewarm(input: IpcPayloads['ai:prewarm']): Promise<AiReply<true>> {
  const payload = parseIpcPayload('ai:prewarm', input);
  return call(
    () => window.avb.aiPrewarm(payload),
    () => true as const,
  );
}

/** The project's chats in display order, with its sections. */
export function aiChats(projectPath: string): Promise<AiReply<ChatList>> {
  const payload = parseIpcPayload('ai:chats', { projectPath });
  return call(() => window.avb.aiChats(payload), parseChatList);
}

export function aiChatCreate(input: IpcPayloads['ai:chatCreate']): Promise<AiReply<ChatSummary>> {
  const payload = parseIpcPayload('ai:chatCreate', input);
  return callResult(() => window.avb.aiChatCreate(payload), parseChatSummary);
}

export function aiChatUpdate(input: IpcPayloads['ai:chatUpdate']): Promise<AiReply<ChatSummary>> {
  const payload = parseIpcPayload('ai:chatUpdate', input);
  return callResult(() => window.avb.aiChatUpdate(payload), parseChatSummary);
}

export function aiChatDelete(input: IpcPayloads['ai:chatDelete']): Promise<AiReply<true>> {
  const payload = parseIpcPayload('ai:chatDelete', input);
  return call(
    () => window.avb.aiChatDelete(payload),
    () => true as const,
  );
}

export function aiChatRead(input: IpcPayloads['ai:chatRead']): Promise<AiReply<ChatTranscript>> {
  const payload = parseIpcPayload('ai:chatRead', input);
  return callResult(() => window.avb.aiChatRead(payload), parseChatTranscript);
}

export function aiPrompt(input: IpcPayloads['ai:prompt']): Promise<AiReply<{ readonly turn: TurnId }>> {
  const payload = parseIpcPayload('ai:prompt', input);
  return callResult(() => window.avb.aiPrompt(payload), parsePromptTurn);
}

/** Injects a message into the running turn (`ai:steer`); `unsupported` when the agent cannot. */
export function aiSteer(input: IpcPayloads['ai:steer']): Promise<AiReply<SteerReply>> {
  const payload = parseIpcPayload('ai:steer', input);
  return callResult(() => window.avb.aiSteer(payload), parseSteerReply);
}

export function aiCompact(input: IpcPayloads['ai:compact']): Promise<AiReply<{ readonly started: true }>> {
  const payload = parseIpcPayload('ai:compact', input);
  return callResult(() => window.avb.aiCompact(payload), parseCompactStarted);
}

export function aiChatFork(input: IpcPayloads['ai:chatFork']): Promise<AiReply<ChatSummary>> {
  const payload = parseIpcPayload('ai:chatFork', input);
  return callResult(() => window.avb.aiChatFork(payload), parseChatSummary);
}

/** Moves a chat; the reply is the whole list, which replaces the renderer's copy. */
export function aiChatMove(input: IpcPayloads['ai:chatMove']): Promise<AiReply<ChatList>> {
  const payload = parseIpcPayload('ai:chatMove', input);
  return callResult(() => window.avb.aiChatMove(payload), parseChatList);
}

export function aiSections(input: IpcPayloads['ai:sections']): Promise<AiReply<ChatList>> {
  const payload = parseIpcPayload('ai:sections', input);
  return callResult(() => window.avb.aiSections(payload), parseChatList);
}

/** A pending file's text before and after a turn. */
export function aiDiff(input: IpcPayloads['ai:diff']): Promise<AiReply<DiffReply>> {
  const payload = parseIpcPayload('ai:diff', input);
  return callResult(() => window.avb.aiDiff(payload), parseDiffReply);
}

export function aiMentions(input: IpcPayloads['ai:mentions']): Promise<AiReply<readonly MentionCandidate[]>> {
  const payload = parseIpcPayload('ai:mentions', input);
  return callResult(() => window.avb.aiMentions(payload), parseMentionReply);
}

export function aiCancel(input: IpcPayloads['ai:cancel']): Promise<AiReply<true>> {
  const payload = parseIpcPayload('ai:cancel', input);
  return call(
    () => window.avb.aiCancel(payload),
    () => true as const,
  );
}

export function aiPermission(input: IpcPayloads['ai:permission']): Promise<AiReply<unknown>> {
  const payload = parseIpcPayload('ai:permission', input);
  return callResult(
    () => window.avb.aiPermission(payload),
    () => true,
  );
}

export function aiSetOption(input: IpcPayloads['ai:setOption']): Promise<AiReply<unknown>> {
  const payload = parseIpcPayload('ai:setOption', input);
  return callResult(
    () => window.avb.aiSetOption(payload),
    () => true,
  );
}

/** Remembers a composer choice for the agent's next new chats, or forgets the agent's whole set; answers the set after the change. */
export function aiRemember(input: IpcPayloads['ai:remember']): Promise<AiReply<RememberedSettings>> {
  const payload = parseIpcPayload('ai:remember', input);
  return callResult(() => window.avb.aiRemember(payload), parseRememberedSettings);
}

export async function aiReview(input: IpcPayloads['ai:review']): Promise<ReviewOutcome> {
  const payload = parseIpcPayload('ai:review', input);
  const reply = await call(() => window.avb.aiReview(payload), parseReviewOutcome);
  return reply.ok ? reply.value : { tag: 'failed', message: reply.error.message, messageRef: reply.error.messageRef };
}

export function acknowledgeAiEvents(chars: number): void {
  window.avb.aiAck(count(chars));
}

export function onAiEvents(callback: (push: AiEventsPush) => void): () => void {
  return window.avb.onAiEvents((input) => {
    let push: AiEventsPush;
    try {
      push = parseAiEventsPush(input);
    } catch (error: unknown) {
      console.error('[ai] refused an events push:', error);
      return;
    }
    callback(push);
  });
}

export function onAiAgentStatus(callback: (push: AiStatusPush) => void): () => void {
  return window.avb.onAiAgentStatus((input) => {
    let push: AiStatusPush;
    try {
      push = parseAiStatusPush(input);
    } catch (error: unknown) {
      console.error('[ai] refused a status push:', error);
      return;
    }
    callback(push);
  });
}

export function aiSetup(input: IpcPayloads['ai:setup']): Promise<AiReply<SetupState>> {
  const payload = parseIpcPayload('ai:setup', input);
  return call(() => window.avb.aiSetup(payload), parseSetupState);
}

export function onAiSetup(callback: (state: SetupState) => void): () => void {
  return window.avb.onAiSetup((input) => {
    let state: SetupState;
    try {
      state = parseSetupState(input);
    } catch (error: unknown) {
      console.error('[ai] refused a setup push:', error);
      return;
    }
    callback(state);
  });
}
