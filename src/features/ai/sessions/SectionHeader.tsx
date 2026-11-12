// A section's header in the sessions list: its name and a chevron that folds the rows away, with a "⋯" menu on
// hover (rename, move up, move down, delete) and a double click to rename in place. The implicit first section
// ("No section") has no stored state, so it has a name only: it cannot fold, rename or be deleted.
import { useEffect } from 'react';
import type { ChatSection } from '../../../../shared/properties/ai/chatModel';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { ChevronDownIcon, ChevronRightIcon, MoreIcon } from '../../../ui/Icons';
import Menu, { useMenuTrigger } from '../../../ui/Menu';
import type { MenuEntry } from '../../../ui/Menu';
import { collapseSection, deleteSection, moveSection, renameSection } from '../aiStore';
import { RenameField } from './RenameField';
import { SECTION_NAME_CHARS_MAX, sectionStep } from './sessionsModel';

export interface SectionHeaderProps {
  readonly name: string;
  /** Undefined for the implicit first section. */
  readonly section: ChatSection | undefined;
  readonly sections: readonly ChatSection[];
  /** How many chats the section holds, archived ones included; the delete question says so. */
  readonly chatCount: number;
  readonly collapsed: boolean;
  readonly renaming: boolean;
  readonly onRenameStart: () => void;
  readonly onRenameEnd: () => void;
}

export function SectionHeader(props: SectionHeaderProps) {
  const { section } = props;
  const trigger = useMenuTrigger();
  // Renaming replaces the header, and its menu with it, before the menu can report that it closed.
  const { close: closeMenu } = trigger;
  const { renaming } = props;
  useEffect(() => {
    if (renaming) {
      closeMenu();
    }
  }, [renaming, closeMenu]);
  if (section === undefined) {
    return (
      <div className="ai-section-head is-static">
        <span className="ai-section-name">{props.name}</span>
      </div>
    );
  }
  if (props.renaming) {
    return (
      <div className="ai-section-head is-renaming">
        <RenameField
          initial={section.name}
          limit={SECTION_NAME_CHARS_MAX}
          label="Section name"
          className="ai-section-rename"
          onCommit={(name) => {
            props.onRenameEnd();
            void renameSection(section.id, name);
          }}
          onCancel={props.onRenameEnd}
        />
      </div>
    );
  }
  return (
    <div className={`ai-section-head${trigger.open ? ' has-menu' : ''}`}>
      <button
        className="ai-section-toggle"
        aria-expanded={!props.collapsed}
        onClick={() => void collapseSection(section.id, { collapsed: !props.collapsed })}
        onDoubleClick={props.onRenameStart}
        title={props.collapsed ? `Show ${section.name}` : `Hide ${section.name}`}
      >
        <span className="ai-section-name">{section.name}</span>
        {props.collapsed ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
      </button>
      <button
        ref={trigger.ref}
        className="ai-row-more"
        aria-label={`Actions for ${section.name}`}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={`${section.name} actions`}
        placement="below-end"
        entries={trigger.open ? sectionMenuEntries(props, section) : []}
        onClose={trigger.close}
      />
    </div>
  );
}

function sectionMenuEntries(props: SectionHeaderProps, section: ChatSection): readonly MenuEntry[] {
  const up = sectionStep(props.sections, section.id, 'up');
  const down = sectionStep(props.sections, section.id, 'down');
  return [
    { kind: 'item', id: 'rename', label: 'Rename', shortcut: 'R', accelerator: 'r', onSelect: props.onRenameStart },
    { kind: 'item', id: 'up', label: 'Move up', disabled: up === undefined, onSelect: () => up !== undefined && void moveSection(section.id, up) },
    { kind: 'item', id: 'down', label: 'Move down', disabled: down === undefined, onSelect: () => down !== undefined && void moveSection(section.id, down) },
    { kind: 'divider', id: 'divider-delete' },
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete section',
      shortcut: 'D',
      accelerator: 'd',
      danger: true,
      onSelect: () => void confirmDeleteSection(section, props.chatCount),
    },
  ];
}

export async function confirmDeleteSection(section: ChatSection, chatCount: number): Promise<void> {
  const answer = await confirmDialog({
    title: `Delete the section “${section.name}”?`,
    body:
      chatCount === 0
        ? 'The section is empty. This cannot be undone.'
        : `Its ${chatCount === 1 ? 'chat moves' : `${chatCount} chats move`} to No section. No chat is deleted. The section itself cannot be brought back.`,
    confirmLabel: 'Delete section',
    danger: true,
  });
  if (answer === true) {
    await deleteSection(section.id);
  }
}
