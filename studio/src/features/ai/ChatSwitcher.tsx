import { useState } from 'react';
import { selectChat, deleteChat, type ChatThread } from './chatState';
import { ChatIcon } from './ChatIcon';

export function ChatSwitcher({ chats, active }: { readonly chats: readonly ChatThread[]; readonly active: ChatThread }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-switcher">
      <button className="chat-switcher-button" aria-label="Chat history" aria-expanded={open} aria-controls="chat-history" onClick={() => setOpen(!open)}>
        <ChatIcon name="chat" />
        <span>{active.title}</span>
        <ChatIcon name="chevron" />
      </button>
      {open && (
        <>
          <button className="chat-menu-backdrop" aria-label="Close chat history" tabIndex={-1} onClick={() => setOpen(false)} />
          <div
            id="chat-history"
            className="chat-history"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
              }
            }}
          >
            <div className="chat-history-heading">
              Your chats <span>{chats.length}/20</span>
            </div>
            {[...chats].reverse().map((chat) => (
              <ChatRow key={chat.id} chat={chat} active={active.id} close={() => setOpen(false)} />
            ))}
          </div>
        </>
      )}
      <div className="chat-tabs" aria-label="Open chats">
        {chats.map((thread) => (
          <button key={thread.id} aria-current={thread.id === active.id ? 'page' : undefined} onClick={() => selectChat(thread.id)} title={thread.title}>
            {thread.status !== 'idle' && <span className="chat-running-dot" />}
            <span>{thread.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
function ChatRow({ chat, active, close }: { readonly chat: ChatThread; readonly active: string; readonly close: () => void }) {
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="chat-history-row">
      <button
        aria-current={chat.id === active ? 'page' : undefined}
        onClick={() => {
          selectChat(chat.id);
          close();
        }}
      >
        <span>{chat.title}</span>
        <small>{chat.status === 'idle' ? (chat.messages.length ? `${chat.messages.length} messages` : chat.draft || 'No messages yet') : 'Working…'}</small>
      </button>
      <button className="chat-icon-button" disabled={chat.status !== 'idle'} aria-label={`Delete ${chat.title}`} onClick={() => setDeleting(true)}>
        <ChatIcon name="trash" />
      </button>
      {deleting && (
        <div className="chat-delete-confirm">
          <span>Delete this chat?</span>
          <button
            onClick={() => {
              deleteChat(chat.id);
              setDeleting(false);
            }}
          >
            Delete
          </button>
          <button onClick={() => setDeleting(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
