// The list of chats, Desktop's sessions list in Studio's words: pinned chats first, then the rest, each row with its
// age or a running loader, a menu (pin, rename, delete), and drag-to-reorder through the same sectioned-drag hook
// Desktop uses (a chat dropped into the pinned group is pinned; dropped out of it, unpinned). Desktop's custom
// sections, unread marks, fork and archive need its chat store and are not offered.
import { Fragment, useEffect, useRef, useState } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { confirmDialog } from '../../../vendor/stacki/src/ui/ConfirmDialog';
import { DropLine } from '../../../vendor/stacki/src/ui/DropLine';
import { MoreIcon, PinIcon, PlusIcon } from '../../../vendor/stacki/src/ui/Icons';
import { LoaderDots } from '../../../vendor/stacki/src/ui/LoaderDots';
import Menu, { useMenuTrigger } from '../../../vendor/stacki/src/ui/Menu';
import { SearchField } from '../../../vendor/stacki/src/ui/SearchField';
import { resolveDrop } from '../../../vendor/stacki/src/ui/sectionedDragModel';
import { useSectionedDrag, type DropTarget } from '../../../vendor/stacki/src/ui/useSectionedDrag';
import '../../../vendor/stacki/src/features/ai/sessions/sessions.css';
import { ageLabel } from './chatClock';
import {
  CHATS_MAX,
  CHATS_SECTION,
  CHAT_TITLE_CHARS_MAX,
  PINNED_SECTION,
  chatSections,
  deleteChat,
  moveChat,
  renameChat,
  selectChat,
  setPinned,
  type ChatThread,
} from './chatState';

export function ChatList({
  chats,
  active,
  onOpen,
  onNew,
}: {
  readonly chats: readonly ChatThread[];
  readonly active: string;
  readonly onOpen: () => void;
  readonly onNew: () => void;
}) {
  const [query, setQuery] = useState('');
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const sections = chatSections(chats);
  const drag = useSectionedDrag({ sections, onMove: moveChat, disabled: query.trim() !== '' });
  const now = Date.now();
  const needle = query.trim().toLowerCase();
  const visible = (chat: ChatThread): boolean => needle === '' || chat.title.toLowerCase().includes(needle);
  // The line shows only for a drop that would change the order.
  const line: DropTarget | undefined =
    drag.dragging === undefined || drag.drop === undefined || resolveDrop(sections, drag.dragging, drag.drop).kind !== 'move' ? undefined : drag.drop;
  assert(line === undefined || sections.some((section) => section.id === line.sectionId), 'ChatList: a drop line names a section of the list');
  const groups = [
    { id: PINNED_SECTION, name: 'Pinned', chats: chats.filter((chat) => chat.pinned && visible(chat)) },
    { id: CHATS_SECTION, name: 'Chats', chats: chats.filter((chat) => !chat.pinned && visible(chat)) },
  ];
  const matches = groups.some((group) => group.chats.length > 0);
  return (
    <div className="ai-sessions chat-sessions">
      <SearchField label="Search chats" className="ai-sessions-search" value={query} onChange={setQuery} />
      <div className="ai-list" ref={drag.containerRef}>
        {!matches && <div className="ai-empty ai-sessions-empty">{needle === '' ? <p>No chats yet.</p> : <p>No chat matches.</p>}</div>}
        {groups.map((group) => (
          <section key={group.id} className="ai-section" {...drag.sectionProps(group.id)}>
            {(group.id === CHATS_SECTION ? chats.some((chat) => chat.pinned) : true) && (
              <div className="ai-section-head is-static">
                <span className="ai-section-name">
                  {group.name} <span className="chat-count">{group.id === CHATS_SECTION ? `${chats.length}/${CHATS_MAX}` : ''}</span>
                </span>
              </div>
            )}
            <ul className="ai-list-rows">
              {group.chats.length === 0 && group.id === PINNED_SECTION && <li className="ai-section-empty">Drag a chat here to pin it.</li>}
              {group.chats.map((chat) => (
                <Fragment key={chat.id}>
                  {line?.sectionId === group.id && line.beforeId === chat.id && <DropSlot />}
                  <ChatRow
                    chat={chat}
                    active={chat.id === active}
                    now={now}
                    renaming={renaming === chat.id}
                    dragProps={drag.itemProps(chat.id)}
                    onOpen={() => {
                      selectChat(chat.id);
                      onOpen();
                    }}
                    onRenameStart={() => setRenaming(chat.id)}
                    onRenameEnd={() => setRenaming(undefined)}
                  />
                </Fragment>
              ))}
              {line?.sectionId === group.id && line.beforeId === undefined && <DropSlot />}
            </ul>
          </section>
        ))}
        <button
          className="ai-new-section"
          disabled={chats.length >= CHATS_MAX}
          title={chats.length >= CHATS_MAX ? 'Delete a chat to make room' : 'Start a new chat'}
          onClick={onNew}
        >
          <PlusIcon size={12} /> New chat
        </button>
      </div>
    </div>
  );
}

/** A zero-height row the drop line is drawn in, so showing it moves nothing. */
function DropSlot() {
  return (
    <li className="ai-drop-slot" aria-hidden="true">
      <DropLine />
    </li>
  );
}

interface RowProps {
  readonly chat: ChatThread;
  readonly active: boolean;
  readonly now: number;
  readonly renaming: boolean;
  readonly dragProps: ReturnType<ReturnType<typeof useSectionedDrag>['itemProps']>;
  readonly onOpen: () => void;
  readonly onRenameStart: () => void;
  readonly onRenameEnd: () => void;
}

function ChatRow({ chat, active, now, renaming, dragProps, onOpen, onRenameStart, onRenameEnd }: RowProps) {
  const trigger = useMenuTrigger();
  const running = chat.status !== 'idle';
  const { close: closeMenu } = trigger;
  // Renaming replaces the row, and its menu with it, before the menu can report that it closed.
  useEffect(() => {
    if (renaming) {
      closeMenu();
    }
  }, [renaming, closeMenu]);
  if (renaming) {
    return (
      <li className="ai-list-row is-renaming" data-chat={chat.id}>
        <span className="ai-row-lead" />
        <RenameField
          initial={chat.title}
          onCommit={(title) => {
            onRenameEnd();
            renameChat(chat.id, title);
          }}
          onCancel={onRenameEnd}
        />
      </li>
    );
  }
  const detail = chat.messages.length ? `${chat.messages.length} message${chat.messages.length === 1 ? '' : 's'}` : chat.draft || 'No messages yet';
  return (
    <li
      className={`ai-list-row${chat.pinned ? ' is-pinned' : ''}${trigger.open ? ' has-menu' : ''}`}
      data-chat={chat.id}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!trigger.open) {
          trigger.toggle();
        }
      }}
    >
      <button {...dragProps} className="ai-list-open" title={detail} aria-current={active ? 'page' : undefined} onClick={onOpen}>
        <span className="ai-row-lead" />
        <span className="ai-list-title">{chat.title}</span>
        <span className="ai-row-meta">
          {chat.pinned && <PinIcon size={11} aria-label="Pinned" />}
          {running ? <LoaderDots label="Working" dotPx={3} /> : <span className="ai-list-time">{ageLabel(chat.updatedAt, now)}</span>}
        </span>
      </button>
      <button
        ref={trigger.ref}
        className="ai-row-more"
        aria-label={`Actions for ${chat.title}`}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={`${chat.title} actions`}
        placement="below-end"
        onClose={trigger.close}
        entries={
          trigger.open
            ? [
                {
                  kind: 'item',
                  id: 'pin',
                  label: chat.pinned ? 'Unpin' : 'Pin',
                  shortcut: 'P',
                  accelerator: 'p',
                  onSelect: () => setPinned(chat.id, !chat.pinned),
                },
                { kind: 'item', id: 'rename', label: 'Rename', shortcut: 'R', accelerator: 'r', onSelect: onRenameStart },
                { kind: 'divider', id: 'divider-delete' },
                {
                  kind: 'item',
                  id: 'delete',
                  label: 'Delete',
                  shortcut: 'D',
                  accelerator: 'd',
                  danger: true,
                  disabled: running,
                  onSelect: () => void confirmDelete(chat),
                },
              ]
            : []
        }
      />
    </li>
  );
}

async function confirmDelete(chat: ChatThread): Promise<void> {
  const confirmed = await confirmDialog({
    title: `Delete “${chat.title}”?`,
    body: 'The conversation is removed from this browser. Changes already applied to the draft stay.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (confirmed) {
    deleteChat(chat.id);
  }
}

/** The in-place name field a row turns into while renaming: Enter commits, Escape cancels, leaving the field commits. */
function RenameField({ initial, onCommit, onCancel }: { readonly initial: string; readonly onCommit: (title: string) => void; readonly onCancel: () => void }) {
  // Refs, not state: Enter closes the field, which blurs it in the same event, and the blur must not commit a second time.
  const finished = useRef(false);
  const focused = useRef(false);
  const finish = (value: string): void => {
    if (finished.current) {
      return;
    }
    finished.current = true;
    const name = value.trim();
    if (name !== '' && name !== initial) {
      onCommit(name);
    } else {
      onCancel();
    }
  };
  return (
    <input
      ref={(element) => {
        // Once, when the field first mounts: focus it with the whole name selected, ready to type over.
        if (element !== null && !focused.current) {
          focused.current = true;
          element.focus();
          element.select();
        }
      }}
      className="ai-rename"
      aria-label="Chat name"
      defaultValue={initial}
      maxLength={CHAT_TITLE_CHARS_MAX}
      spellCheck={false}
      onBlur={(event) => finish(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (!finished.current) {
            finished.current = true;
            onCancel();
          }
        }
      }}
    />
  );
}
