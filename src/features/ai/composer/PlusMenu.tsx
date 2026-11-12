// The "+" at the left of the composer: what can be added to the message. Images are picked from disk
// (they can also be pasted or dropped, as before); "@" mentions a project file or skill as a chip in the
// input; "/" opens the agent's commands and skills.
import { FileIcon, PaperclipIcon, PlusIcon, SparkleIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import { useTranslate } from '../../../lib/i18n/useTranslate';

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
  const translate = useTranslate();
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
          { kind: 'item', id: 'images', label: translate('ai.composer.add.images'), icon: <PaperclipIcon size={14} />, onSelect: onPickImages },
          { kind: 'item', id: 'mention', label: translate('ai.composer.add.mention'), icon: <FileIcon size={14} />, shortcut: '@', onSelect: onInsertMention },
          {
            kind: 'item',
            id: 'commands',
            label: translate('ai.composer.add.commands'),
            icon: <SparkleIcon size={14} />,
            shortcut: '/',
            disabled: !canInsertSlash,
            onSelect: onInsertSlash,
          },
          { kind: 'note', id: 'note', text: translate('ai.composer.add.note') },
        ]}
      />
    </>
  );
}
