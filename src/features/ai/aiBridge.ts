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
  parseChatSummaries,
  parseChatTranscript,
  parsePromptTurn,
  parseSetupState,
  parseReviewOutcome,
  type AgentAvailability,
  type AiAgentsReply,
  type AiEventsPush,
  type AiFailure,
  type AiStatusPush,
  type ChatTranscript,
  type ReviewOutcome,
  type SetupState,
} from '../../../shared/ipc/aiChat';
import { parseChatSummary, type ChatSummary, type TurnId } from '../../../shared/properties/ai/chatModel';
import { cleanError } from '../../lib/cleanError';

export type AiReply<T> = Result<T, AiFailure>;

async function call<T>(run: () => Promise<unknown>, parse: (input: unknown) => T): Promise<Result<T, AiFailure>> {
  let reply: unknown;
  try {
    reply = await run();
  } catch (error: unknown) {
    return err({ code: 'agent-failed', message: cleanError(error) });
  }
  return { ok: true, value: parse(reply) };
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

export function aiChats(projectPath: string): Promise<AiReply<readonly ChatSummary[]>> {
  const payload = parseIpcPayload('ai:chats', { projectPath });
  return call(() => window.avb.aiChats(payload), parseChatSummaries);
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

export async function aiReview(input: IpcPayloads['ai:review']): Promise<ReviewOutcome> {
  const payload = parseIpcPayload('ai:review', input);
  const reply = await call(() => window.avb.aiReview(payload), parseReviewOutcome);
  return reply.ok ? reply.value : { tag: 'failed', message: reply.error.message };
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
