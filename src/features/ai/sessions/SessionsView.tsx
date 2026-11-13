// The project's chats as the Claude desktop app lists them: named sections that fold away, the chats of
// each with pinned ones first, a quiet dot for what is unread, a loader for what is running, and a "⋯" on the
// hovered row. Chats drag to reorder inside a section and between sections (the drop line shows where), and
// Alt+Up / Alt+Down moves the focused one; pinned chats stay at the top of their section whatever is dropped.
// Dragging is off while a search or filter narrows the list, because a row's place in a partial list is not its
// place in the whole. Archived chats show only behind the filter menu's "Show archived".
// What each piece does lives beside it: rows (ChatRow), headers (SectionHeader), the pure rules (sessionsModel).
import { Fragment, useState } from 'react';
import type { ChatSummary } from '../../../../shared/properties/ai/chatModel';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { DropLine } from '../../../ui/DropLine';
import { PlusIcon } from '../../../ui/Icons';
import { SearchField } from '../../../ui/SearchField';
import { applyMove, resolveDrop } from '../../../ui/sectionedDragModel';
import { useSectionedDrag } from '../../../ui/useSectionedDrag';
import type { DropMove, DropTarget } from '../../../ui/useSectionedDrag';
import { DEFAULT_CHAT_FILTER, moveChat, newChat, preferredAgent, setChatListFilter, useAiState } from '../aiStore';
import { addSection } from './chatActions';
import { ChatRow } from './ChatRow';
import { SectionHeader } from './SectionHeader';
import { NO_SECTION, applyOrder, dragSectionsOf, groupSessions, isNarrowing, lockPinned } from './sessionsModel';
import type { SessionGroup } from './sessionsModel';
import './sessions.css';

export { filterChats, sortChats } from './sessionsModel';

type Editing = { readonly kind: 'chat'; readonly id: string } | { readonly kind: 'section'; readonly id: string } | undefined;

export function SessionsView({ chats }: { readonly chats: readonly ChatSummary[] }) {
  const translate = useTranslate();
  const state = useAiState();
  const { filter, sections, views } = state;
  const [editing, setEditing] = useState<Editing>(undefined);
  // The order a drop shows until the main process answers with the real list.
  const [pending, setPending] = useState<ReturnType<typeof dragSectionsOf> | undefined>(undefined);
  const layout = groupSessions(chats, sections, filter);
  const groups = pending === undefined ? layout.groups : applyOrder(layout.groups, pending);
  const dragSections = dragSectionsOf(groups);
  const pinned = new Set(chats.filter((chat) => chat.pinned).map((chat) => chat.id));
  const narrowing = isNarrowing(filter);
  const now = Date.now();
  const drag = useSectionedDrag({
    sections: dragSections,
    disabled: narrowing,
    onMove: (move) => {
      const target = settledTarget(dragSections, pinned, move);
      const decision = target === undefined ? undefined : resolveDrop(dragSections, move.itemId, target);
      if (decision?.kind !== 'move') {
        return;
      }
      const chat = chats.find((candidate) => candidate.id === decision.move.itemId);
      const section = sections.find((candidate) => candidate.id === decision.move.sectionId);
      if (chat === undefined || (section === undefined && decision.move.sectionId !== NO_SECTION)) {
        return;
      }
      const before = chats.find((candidate) => candidate.id === decision.move.beforeId);
      setPending(applyMove(dragSections, decision.move));
      void moveChat(chat.id, { section: section?.id, before: before?.id }).finally(() => setPending(undefined));
    },
  });
  const line = drag.dragging === undefined || drag.drop === undefined ? undefined : settledDrop(dragSections, pinned, drag.dragging, drag.drop);
  const live = chats.filter((chat) => chat.archivedAt === undefined);
  const sectionLimit = sections.length >= AI_LIMITS.sectionsMax;
  return (
    <div className="ai-sessions">
      {chats.length > 0 && (
        <SearchField
          label={translate('ai.sessions.search')}
          className="ai-sessions-search"
          value={filter.query}
          onChange={(query) => setChatListFilter({ ...filter, query })}
        />
      )}
      <div className="ai-list" ref={drag.containerRef}>
        {live.length === 0 && !narrowing && (
          <div className="ai-empty ai-sessions-empty">
            <p>{translate('ai.sessions.empty')}</p>
            <button className="ai-sessions-start" onClick={() => void newChat(preferredAgent())}>
              <PlusIcon size={12} /> {translate('ai.sessions.newChat')}
            </button>
          </div>
        )}
        {live.length > 0 && layout.groups.every((group) => group.chats.length === 0) && narrowing && (
          <div className="ai-empty ai-sessions-empty">
            <p>{translate('ai.sessions.noMatch')}</p>
            <button className="ai-sessions-start" onClick={() => setChatListFilter({ ...DEFAULT_CHAT_FILTER, showArchived: filter.showArchived })}>
              {translate('ai.sessions.clearFilters')}
            </button>
          </div>
        )}
        {groups.map((group) => (
          <section key={group.key} className="ai-section" {...drag.sectionProps(group.key)}>
            {(group.section !== undefined || sections.length > 0) && (
              <SectionHeader
                name={group.section === undefined ? translate('ai.sessions.noSection') : group.name}
                section={group.section}
                sections={sections}
                chatCount={chats.filter((chat) => chat.section === group.section?.id).length}
                collapsed={group.collapsed}
                renaming={editing?.kind === 'section' && editing.id === group.key}
                onRenameStart={() => setEditing({ kind: 'section', id: group.key })}
                onRenameEnd={() => setEditing(undefined)}
              />
            )}
            {!group.collapsed && (
              <GroupRows
                group={group}
                sections={sections}
                running={(chat) => views.get(chat.id)?.running !== undefined}
                editing={editing}
                setEditing={setEditing}
                now={now}
                drag={drag}
                line={line}
              />
            )}
          </section>
        ))}
        {filter.showArchived && (
          <section className="ai-section ai-archived">
            <div className="ai-section-head is-static">
              <span className="ai-section-name">{translate('ai.sessions.archivedHeading')}</span>
            </div>
            <ul className="ai-list-rows">
              {layout.archived.length === 0 && <li className="ai-section-empty">{translate('ai.sessions.noArchived')}</li>}
              {layout.archived.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  sections={sections}
                  running={false}
                  renaming={false}
                  now={now}
                  dragProps={undefined}
                  onRenameStart={() => undefined}
                  onRenameEnd={() => undefined}
                />
              ))}
            </ul>
          </section>
        )}
        {!narrowing && (
          <button
            className="ai-new-section"
            disabled={sectionLimit}
            title={sectionLimit ? translate('ai.sessions.sectionLimit', { count: AI_LIMITS.sectionsMax }) : translate('ai.sessions.addSection')}
            onClick={() => void addSection(sections, { sectionCreated: (id) => setEditing({ kind: 'section', id }) }, translate)}
          >
            <PlusIcon size={12} /> {translate('ai.sessions.newSection')}
          </button>
        )}
      </div>
    </div>
  );
}

interface GroupRowsProps {
  readonly group: SessionGroup;
  readonly sections: ReturnType<typeof useAiState>['sections'];
  readonly running: (chat: ChatSummary) => boolean;
  readonly editing: Editing;
  readonly setEditing: (editing: Editing) => void;
  readonly now: number;
  readonly drag: ReturnType<typeof useSectionedDrag>;
  readonly line: DropTarget | undefined;
}

function GroupRows({ group, sections, running, editing, setEditing, now, drag, line }: GroupRowsProps) {
  const translate = useTranslate();
  const lineHere = line !== undefined && line.sectionId === group.key;
  return (
    <ul className="ai-list-rows">
      {group.chats.length === 0 && (
        <li className="ai-section-empty">{group.section === undefined ? translate('ai.sessions.nothingHere') : translate('ai.sessions.dropHere')}</li>
      )}
      {group.chats.map((chat) => (
        <Fragment key={chat.id}>
          {lineHere && line.beforeId === chat.id && <DropSlot />}
          <ChatRow
            chat={chat}
            sections={sections}
            running={running(chat)}
            renaming={editing?.kind === 'chat' && editing.id === chat.id}
            now={now}
            dragProps={drag.itemProps(chat.id)}
            onRenameStart={() => setEditing({ kind: 'chat', id: chat.id })}
            onRenameEnd={() => setEditing(undefined)}
          />
        </Fragment>
      ))}
      {lineHere && line.beforeId === undefined && <DropSlot />}
    </ul>
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

/** Where a drop really lands once pinned chats are held at the top; undefined when it would change nothing. */
function settledDrop(sections: ReturnType<typeof dragSectionsOf>, pinned: ReadonlySet<string>, itemId: string, target: DropTarget): DropTarget | undefined {
  const locked = lockPinned(sections, pinned, itemId, target);
  return resolveDrop(sections, itemId, locked).kind === 'move' ? locked : undefined;
}

function settledTarget(sections: ReturnType<typeof dragSectionsOf>, pinned: ReadonlySet<string>, move: DropMove): DropTarget | undefined {
  return settledDrop(sections, pinned, move.itemId, { sectionId: move.sectionId, beforeId: move.beforeId });
}
