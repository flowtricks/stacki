// What choosing an item in a chat's menu does, and the menu's rows. The row's menu, a letter typed on a
// focused row and the open chat's header menu all go through here, so they cannot drift apart.
// Deleting always asks first, with Stacki's own dialog (never a native one).
import { assert } from '../../../../shared/core/assert';
import type { ChatSection, ChatSummary, SectionId } from '../../../../shared/properties/ai/chatModel';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import type { MenuEntry } from '../../../ui/Menu';
import { archiveChat, createSection, deleteChat, forkChat, markRead, markUnread, moveChat, pinChat, restoreChat } from '../aiStore';
import { uniqueSectionName } from './sessionsModel';
import type { ChatAction } from './sessionsModel';

/** What the caller supplies because it owns the screen state: starting an inline rename, and showing a new section for naming. */
export interface ChatActionHost {
  readonly rename: () => void;
  /** A section was just created; the list scrolls to it and lets the person name it. */
  readonly sectionCreated?: (section: SectionId) => void;
}

/** Runs `action` on `chat`. Rename is the host's (it edits in place); the rest go to the store. */
export async function runChatAction(action: ChatAction, chat: ChatSummary, host: ChatActionHost): Promise<void> {
  switch (action) {
    case 'pin':
      await pinChat(chat.id, { pinned: !chat.pinned });
      return;
    case 'unread':
      await (chat.unread ? markRead(chat.id) : markUnread(chat.id));
      return;
    case 'rename':
      host.rename();
      return;
    case 'fork':
      await forkChat(chat.id);
      return;
    case 'archive':
      await archiveChat(chat.id);
      return;
    case 'restore':
      await restoreChat(chat.id);
      return;
    case 'delete':
      await confirmDeleteChat(chat);
      return;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export async function confirmDeleteChat(chat: ChatSummary): Promise<void> {
  const answer = await confirmDialog({
    title: 'Delete this chat?',
    body: `“${chat.title}” and its history are removed from this computer. This cannot be undone. Files the agent changed stay as they are. To keep the chat out of the way without losing it, archive it instead.`,
    confirmLabel: 'Delete chat',
    danger: true,
  });
  if (answer === true) {
    await deleteChat(chat.id);
  }
}

/** Starts a section with a free default name and returns its id; the caller shows it for naming. */
export async function addSection(sections: readonly ChatSection[], host: Pick<ChatActionHost, 'sectionCreated'>): Promise<SectionId | undefined> {
  const created = await createSection(
    uniqueSectionName(
      sections.map((section) => section.name),
      'New section',
    ),
  );
  if (created !== undefined) {
    host.sectionCreated?.(created);
  }
  return created;
}

/** Puts the chat at the end of `section` (undefined: no section). */
export async function moveChatToSection(chat: ChatSummary, section: SectionId | undefined): Promise<void> {
  await moveChat(chat.id, { section, before: undefined });
}

/** The rows of a chat's menu. Letters work while it is open; the same letters work on a focused row. */
export function chatMenuEntries(chat: ChatSummary, sections: readonly ChatSection[], host: ChatActionHost): readonly MenuEntry[] {
  const run = (action: ChatAction) => (): void => void runChatAction(action, chat, host);
  if (chat.archivedAt !== undefined) {
    return [
      { kind: 'item', id: 'restore', label: 'Restore', shortcut: 'A', accelerator: 'a', onSelect: run('restore') },
      { kind: 'divider', id: 'divider-delete' },
      { kind: 'item', id: 'delete', label: 'Delete', shortcut: 'D', accelerator: 'd', danger: true, onSelect: run('delete') },
    ];
  }
  const placed = sections.find((section) => section.id === chat.section);
  const sectionRows: readonly MenuEntry[] = [
    ...[...sections]
      .sort((left, right) => left.rank - right.rank)
      .map((section): MenuEntry => ({
        kind: 'item',
        id: `section-${section.id}`,
        label: section.name,
        checked: placed?.id === section.id,
        onSelect: () => void moveChatToSection(chat, section.id),
      })),
    { kind: 'item', id: 'section-none', label: 'No section', checked: placed === undefined, onSelect: () => void moveChatToSection(chat, undefined) },
    { kind: 'divider', id: 'divider-new-section' },
    {
      kind: 'item',
      id: 'section-new',
      label: 'New section…',
      onSelect: () =>
        void addSection(sections, host).then((created) => {
          if (created !== undefined) {
            return moveChat(chat.id, { section: created, before: undefined });
          }
          return undefined;
        }),
    },
  ];
  assert(sectionRows.length <= sections.length + 3, 'chatMenuEntries: one row per section and the fixed rows');
  return [
    { kind: 'item', id: 'pin', label: chat.pinned ? 'Unpin' : 'Pin', shortcut: 'P', accelerator: 'p', onSelect: run('pin') },
    { kind: 'item', id: 'unread', label: chat.unread ? 'Mark as read' : 'Mark as unread', shortcut: 'U', accelerator: 'u', onSelect: run('unread') },
    { kind: 'item', id: 'rename', label: 'Rename', shortcut: 'R', accelerator: 'r', onSelect: run('rename') },
    { kind: 'item', id: 'fork', label: 'Fork', shortcut: 'F', accelerator: 'f', onSelect: run('fork') },
    { kind: 'divider', id: 'divider-move' },
    { kind: 'submenu', id: 'move', label: 'Move to section', value: placed?.name ?? 'No section', entries: sectionRows },
    { kind: 'divider', id: 'divider-archive' },
    { kind: 'item', id: 'archive', label: 'Archive', shortcut: 'A', accelerator: 'a', onSelect: run('archive') },
    { kind: 'item', id: 'delete', label: 'Delete', shortcut: 'D', accelerator: 'd', danger: true, onSelect: run('delete') },
  ];
}
