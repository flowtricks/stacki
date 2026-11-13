// A section's header in the sessions list: its name and a chevron that folds the rows away, with a "⋯" menu on
// hover (rename, move up, move down, delete) and a double click to rename in place. The implicit first section
// ("No section") has no stored state, so it has a name only: it cannot fold, rename or be deleted.
import { useEffect } from 'react';
import type { ChatSection } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useTranslate } from '../../../lib/i18n/useTranslate';
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
  const translate = useTranslate();
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
          label={translate('ai.sessions.sectionName')}
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
        title={props.collapsed ? translate('ai.sessions.showSection', { name: section.name }) : translate('ai.sessions.hideSection', { name: section.name })}
      >
        <span className="ai-section-name">{section.name}</span>
        {props.collapsed ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}
      </button>
      <button
        ref={trigger.ref}
        className="ai-row-more"
        aria-label={translate('ai.sessions.actionsFor', { name: section.name })}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        onClick={trigger.toggle}
      >
        <MoreIcon size={14} />
      </button>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.sessions.actionsMenu', { name: section.name })}
        placement="below-end"
        entries={trigger.open ? sectionMenuEntries(props, section, translate) : []}
        onClose={trigger.close}
      />
    </div>
  );
}

function sectionMenuEntries(props: SectionHeaderProps, section: ChatSection, translate: Translator): readonly MenuEntry[] {
  const up = sectionStep(props.sections, section.id, 'up');
  const down = sectionStep(props.sections, section.id, 'down');
  return [
    { kind: 'item', id: 'rename', label: translate('ai.sessions.rename'), shortcut: 'R', accelerator: 'r', onSelect: props.onRenameStart },
    {
      kind: 'item',
      id: 'up',
      label: translate('ai.sessions.moveUp'),
      disabled: up === undefined,
      onSelect: () => up !== undefined && void moveSection(section.id, up),
    },
    {
      kind: 'item',
      id: 'down',
      label: translate('ai.sessions.moveDown'),
      disabled: down === undefined,
      onSelect: () => down !== undefined && void moveSection(section.id, down),
    },
    { kind: 'divider', id: 'divider-delete' },
    {
      kind: 'item',
      id: 'delete',
      label: translate('ai.sessions.deleteSection'),
      shortcut: 'D',
      accelerator: 'd',
      danger: true,
      onSelect: () => void confirmDeleteSection(section, props.chatCount, translate),
    },
  ];
}

export async function confirmDeleteSection(section: ChatSection, chatCount: number, translate: Translator): Promise<void> {
  const answer = await confirmDialog({
    title: translate('ai.sessions.deleteSection.title', { name: section.name }),
    body: chatCount === 0 ? translate('ai.sessions.deleteSection.empty') : translate('ai.sessions.deleteSection.body', { count: chatCount }),
    confirmLabel: translate('ai.sessions.deleteSection'),
    danger: true,
  });
  if (answer === true) {
    await deleteSection(section.id);
  }
}
