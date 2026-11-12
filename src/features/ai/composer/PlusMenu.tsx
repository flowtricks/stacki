// The "+" at the left of the composer: what can be added to the message. Images are picked from disk
// (they can also be pasted or dropped, as before); "@" mentions a project file or skill as a chip in the
// input; "/" opens the agent's commands and skills.
import { FileIcon, PaperclipIcon, PlusIcon, SparkleIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger } from '../../../ui/Menu';

export function PlusMenu({
  disabled,
  canInsertSlash,
  onPickImages,
  onInsertSlash,
  onInsertMention,
}: {
  readonly disabled: boolean;
  /** The draft is empty, which is the only place a command can start. */
  readonly canInsertSlash: boolean;
  readonly onPickImages: () => void;
  readonly onInsertSlash: () => void;
  /** Starts a mention: types `@`, which opens the picker of the project's files and skills. */
  readonly onInsertMention: () => void;
}) {
  const trigger = useMenuTrigger();
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        className={`ghost ai-plus${trigger.open ? ' is-open' : ''}`}
        aria-label="Add to message"
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        title="Add images, or type / for commands"
        disabled={disabled}
        onClick={trigger.toggle}
      >
        <PlusIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label="Add to message"
        placement="above-start"
        onClose={trigger.close}
        entries={[
          { kind: 'item', id: 'images', label: 'Add image', icon: <PaperclipIcon size={14} />, onSelect: onPickImages },
          { kind: 'item', id: 'mention', label: 'Mention a file or skill', icon: <FileIcon size={14} />, shortcut: '@', onSelect: onInsertMention },
          {
            kind: 'item',
            id: 'commands',
            label: 'Commands and skills',
            icon: <SparkleIcon size={14} />,
            shortcut: '/',
            disabled: !canInsertSlash,
            onSelect: onInsertSlash,
          },
          { kind: 'note', id: 'note', text: 'You can also drop project files on the box, or paste images.' },
        ]}
      />
    </>
  );
}
