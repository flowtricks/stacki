// The "+" at the left of the composer: what can be added to the message. Images are picked from disk
// (they can also be pasted or dropped, as before); "@" mentions a project file or skill as a chip in the
// input; "/" opens the agent's commands and skills. Below them, what acts on the chat itself: find in
// it, and copy it as Markdown. Shortcuts are told in each row's tooltip (Menu.tsx), never printed.
import { currentDesktopPlatform } from '../../../lib/shortcutLabel';
import { ComponentIcon, CopyIcon, FileIcon, PaperclipIcon, PlusIcon, SearchIcon, SparkleIcon } from '../../../ui/Icons';
import { chatShortcutLabel } from '../chatShortcuts';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { useSelectedElementOffer } from '../addToChat';
import { useTranslate } from '../../../lib/i18n/useTranslate';

export function PlusMenu({
  disabled,
  canInsertSlash,
  onPickImages,
  onInsertSlash,
  onInsertMention,
  onFind,
  onCopyChat,
  canCopyChat,
}: {
  readonly disabled: boolean;
  /** The draft is empty, which is the only place a command can start. */
  readonly canInsertSlash: boolean;
  readonly onPickImages: () => void;
  readonly onInsertSlash: () => void;
  /** Starts a mention: types `@`, which opens the picker of the project's files and skills. */
  readonly onInsertMention: () => void;
  /** Opens the find bar of the chat's transcript. */
  readonly onFind: () => void;
  /** Copies the chat as Markdown. */
  readonly onCopyChat: () => void;
  /** The chat has a message to copy. */
  readonly canCopyChat: boolean;
}) {
  const translate = useTranslate();
  // The same "Add to chat" as the element menus and ⌘L: the selected element's code and the file it is in.
  const selected = useSelectedElementOffer();
  // A row that cannot be used now is not shown: the selection with nothing selected, a command with a draft started, a copy of an empty chat.
  const selectionEntries =
    selected === undefined
      ? []
      : [
          {
            kind: 'item' as const,
            id: 'selection',
            label: selected.name === undefined ? translate('ai.selection.addNone') : translate('ai.selection.addSelected', { name: selected.name }),
            icon: <ComponentIcon size={14} />,
            onSelect: selected.add,
          },
        ];
  const commandEntries: readonly MenuEntry[] = canInsertSlash
    ? [{ kind: 'item', id: 'commands', label: translate('ai.composer.add.commands'), icon: <SparkleIcon size={14} />, shortcut: '/', onSelect: onInsertSlash }]
    : [];
  const copyEntries: readonly MenuEntry[] = canCopyChat
    ? [{ kind: 'item', id: 'copy-chat', label: translate('ai.composer.add.copyChat'), icon: <CopyIcon size={14} />, onSelect: onCopyChat }]
    : [];
  const trigger = useMenuTrigger();
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        className={`ghost ai-plus${trigger.open ? ' is-open' : ''}`}
        aria-label={translate('ai.composer.add.label')}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        title={translate('ai.composer.add.title')}
        disabled={disabled}
        onClick={trigger.toggle}
      >
        <PlusIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.composer.add.label')}
        placement="above-start"
        onClose={trigger.close}
        entries={[
          ...selectionEntries,
          {
            kind: 'item',
            id: 'images',
            label: translate('ai.composer.add.images'),
            icon: <PaperclipIcon size={14} />,
            tooltip: translate('ai.composer.add.note'),
            onSelect: onPickImages,
          },
          { kind: 'item', id: 'mention', label: translate('ai.composer.add.mention'), icon: <FileIcon size={14} />, shortcut: '@', onSelect: onInsertMention },
          ...commandEntries,
          { kind: 'divider', id: 'divider-chat' },
          {
            kind: 'item',
            id: 'find',
            label: translate('ai.composer.add.find'),
            icon: <SearchIcon size={14} />,
            shortcut: chatShortcutLabel('find', currentDesktopPlatform()),
            onSelect: onFind,
          },
          ...copyEntries,
        ]}
      />
    </>
  );
}
