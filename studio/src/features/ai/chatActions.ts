import { request } from '../project/projectClient';
import { chatState, updateChat, parseProposal, type ChatThread, type ChatMessage } from './chatState';
import type { ChatContext } from './chatContracts';

const running = new Map<string, AbortController>();
function context(chat: ChatThread): readonly ChatContext[] {
  const history = chat.messages.slice(-12).map((message) => ({
    role: message.role,
    content: (message.content + (message.outcome ? `\n${message.outcome}` : '')).slice(0, 6000),
  }));
  while (JSON.stringify(history).length > 80_000) {
    history.shift();
  }
  return history;
}
export async function sendChat(id: string, file: string) {
  const chat = chatState().threads.find((thread) => thread.id === id);
  if (!chat || chat.status !== 'idle' || (!chat.draft.trim() && !chat.images.length) || !chat.model) {
    return;
  }
  if (running.size >= 3) {
    updateChat(id, (thread) => ({
      ...thread,
      error: 'Three chats are already working. Wait for one to finish.',
    }));
    return;
  }
  const controller = new AbortController();
  running.set(id, controller);
  const message: ChatMessage = {
    id: crypto.randomUUID(),
    role: 'user',
    content: chat.draft.trim(),
    images: chat.images,
  };
  const startedAt = Date.now();
  updateChat(id, (thread) => ({
    ...thread,
    draft: '',
    segments: [],
    images: [],
    status: 'working',
    startedAt,
    updatedAt: startedAt,
    error: '',
    title: thread.messages.length || thread.title !== 'New chat' ? thread.title : (message.content || 'Image conversation').slice(0, 60),
    messages: [...thread.messages, message].slice(-39),
  }));
  try {
    const proposal = await generateReply(chat, file, controller.signal);
    if (controller.signal.aborted) {
      return;
    }
    updateChat(id, (thread) => ({
      ...thread,
      messages: [
        ...thread.messages,
        {
          id: crypto.randomUUID(),
          role: 'assistant' as const,
          content: proposal.summary,
          images: [],
          durationMs: Date.now() - startedAt,
          ...(proposal.changes.length ? { proposal } : {}),
        },
      ].slice(-40),
    }));
  } catch (error) {
    updateChat(id, (thread) => ({
      ...thread,
      error: controller.signal.aborted ? 'Response stopped.' : error instanceof Error ? error.message : 'Could not send message.',
      draft: thread.draft || chat.draft,
      segments: thread.segments.length ? thread.segments : chat.segments,
      images: thread.images.length ? thread.images : chat.images,
    }));
  } finally {
    running.delete(id);
    updateChat(id, (thread) => ({ ...thread, status: 'idle', startedAt: undefined, updatedAt: Date.now() }));
  }
}
export function stopChat(id: string) {
  running.get(id)?.abort();
}
export function discardProposal(id: string, messageId: string) {
  finishProposal(id, messageId, 'Discarded. No changes were applied.');
}
function finishProposal(id: string, messageId: string, outcome: string) {
  updateChat(id, (thread) => ({
    ...thread,
    messages: thread.messages.map((message) => {
      if (message.id !== messageId) {
        return message;
      }
      const { proposal: _proposal, ...rest } = message;
      return { ...rest, outcome };
    }),
  }));
}
export async function applyProposal(id: string, messageId: string, refresh: () => void) {
  const thread = chatState().threads.find((thread) => thread.id === id);
  const proposal = thread?.messages.find((message) => message.id === messageId)?.proposal;
  if (!proposal || thread?.status !== 'idle') {
    return;
  }
  updateChat(id, (chat) => ({ ...chat, status: 'applying', error: '' }));
  try {
    await request('/studio/api/ai/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: proposal.id }),
    });
    finishProposal(id, messageId, 'Applied to the shared draft. Ready to preview.');
    refresh();
  } catch (error) {
    updateChat(id, (chat) => ({
      ...chat,
      error: error instanceof Error ? error.message : 'Could not apply changes.',
    }));
  } finally {
    updateChat(id, (chat) => ({ ...chat, status: 'idle' }));
  }
}

async function generateReply(chat: ChatThread, file: string, signal: AbortSignal) {
  return parseProposal(
    await request('/studio/api/ai/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(360_000)]),
      body: JSON.stringify({
        file,
        model: chat.model,
        prompt: chat.draft.trim() || 'Describe these images and how they relate to this page.',
        images: chat.images.length
          ? chat.images
          : ([...chat.messages].reverse().find((message) => message.role === 'user' && message.images.length)?.images ?? []),
        history: context(chat),
      }),
    }),
  );
}
