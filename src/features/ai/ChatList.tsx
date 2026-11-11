// The project's chats: pinned first, then the most recent, with a simple
// search over titles. Each row renames in place, pins, and deletes after
// Stacki's own confirmation (never a native dialog).
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { agentLabel } from '../../../shared/properties/ai/agentIds';
import type { ChatSummary } from '../../../shared/properties/ai/chatModel';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { PencilIcon, PinIcon, TrashIcon } from '../../ui/Icons';
import { SearchField } from '../../ui/SearchField';
import { deleteChat, openChat, pinChat, renameChat } from './aiStore';

export function ChatList({ chats }: { readonly chats: readonly ChatSummary[] }) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<ChatSummary['id'] | undefined>(undefined);
  const shown = sortChats(filterChats(chats, query));
  return (
    <div className="ai-list">
      {chats.length > 0 && <SearchField label="Search chats" value={query} onChange={setQuery} placeholder="Search chats" />}
      {shown.length === 0 && <p className="ai-empty">{chats.length === 0 ? 'No chats yet. Start one below.' : 'No chat matches.'}</p>}
      <ul className="ai-list-rows">
        {shown.map((chat) => (
          <li key={chat.id} className="ai-list-row">
            {renaming === chat.id ? (
              <input
                autoFocus
                className="ai-rename"
                aria-label="Chat name"
                defaultValue={chat.title}
                maxLength={200}
                onBlur={(event) => {
                  const title = event.currentTarget.value.trim();
                  setRenaming(undefined);
                  if (title !== '' && title !== chat.title) {
                    void renameChat(chat.id, title);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.currentTarget.blur();
                  } else if (event.key === 'Escape') {
                    setRenaming(undefined);
                  }
                }}
              />
            ) : (
              <button className="ai-list-open" onClick={() => void openChat(chat.id)}>
                <span className="ai-list-title">{chat.title}</span>
                <span className="ai-list-meta">
                  {agentLabel(chat.agent)} · {relativeTime(chat.updatedAt, Date.now())}
                </span>
              </button>
            )}
            <span className="ai-list-actions">
              <button
                className={`ghost${chat.pinned ? ' on' : ''}`}
                aria-label={chat.pinned ? 'Unpin' : 'Pin'}
                title={chat.pinned ? 'Unpin' : 'Pin'}
                onClick={() => void pinChat(chat.id, { pinned: !chat.pinned })}
              >
                <PinIcon size={12} />
              </button>
              <button className="ghost" aria-label="Rename" title="Rename" onClick={() => setRenaming(chat.id)}>
                <PencilIcon size={12} />
              </button>
              <button className="ghost" aria-label="Delete" title="Delete" onClick={() => void confirmDelete(chat)}>
                <TrashIcon size={12} />
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

async function confirmDelete(chat: ChatSummary): Promise<void> {
  const answer = await confirmDialog({
    title: 'Delete this chat?',
    body: `“${chat.title}” and its history are removed from this computer. Files the agent changed stay as they are.`,
    confirmLabel: 'Delete chat',
    danger: true,
  });
  if (answer === true) {
    await deleteChat(chat.id);
  }
}

export function filterChats(chats: readonly ChatSummary[], query: string): readonly ChatSummary[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  const shown = chats.filter((chat) => words.every((word) => chat.title.toLowerCase().includes(word)));
  assert(shown.length <= chats.length, 'filterChats: a subset');
  return shown;
}

export function sortChats(chats: readonly ChatSummary[]): readonly ChatSummary[] {
  return [...chats].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
}

export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
