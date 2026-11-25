// The project's chats as the Claude desktop app lists them: named sections that fold away, the chats of
// each with pinned ones first, a quiet dot for what is unread, a loader for what is running, and a "⋯" on the
// hovered row. Chats drag to reorder inside a section and between sections (the drop line shows where), and
// Alt+Up / Alt+Down moves the focused one; pinned chats stay at the top of their section whatever is dropped.
// Dragging is off while a search or filter narrows the list, because a row's place in a partial list is not its
// place in the whole. Archived chats show only behind the filter menu's "Show archived".
// When there is nothing to list it shows one card (ListStates.tsx): no chats yet, nothing matches, or not read.
// With no chats and no sections that card is all there is; sections the person made stay listed above it.
// The search stays at the top while the rows scroll under it. Up and Down walk the rows and section headers
// (Home and End jump to the ends), Enter opens the focused chat. In the split layout the list is the sidebar
// beside the open chat: its row is marked and kept in view, and the filter sits beside the search.
// Grouping is by section only, never by date: the order inside a section is the person's own (drag), and date
// buckets would put back an order they chose to leave.
// What each piece does lives beside it: rows (ChatRow), headers (SectionHeader), the pure rules (sessionsModel).
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefCallback } from 'react';
import type { ChatId, ChatSummary } from '../../../../shared/properties/ai/chatModel';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import { assert } from '../../../../shared/core/assert';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { DropLine } from '../../../ui/DropLine';
import { PlusIcon } from '../../../ui/Icons';
import { SearchField } from '../../../ui/SearchField';
import { applyMove, resolveDrop } from '../../../ui/sectionedDragModel';
import { useSectionedDrag } from '../../../ui/useSectionedDrag';
import type { DropMove, DropTarget } from '../../../ui/useSectionedDrag';
import { DEFAULT_CHAT_FILTER, moveChat, setChatListFilter, useAiState } from '../aiStore';
import type { ChatLayout } from '../chatLayout';
import { addSection } from './chatActions';
import { ChatRow } from './ChatRow';
import { takeSectionNameRequest, useSectionNameRequest } from './listMenu';
import { ChatsNotRead, NoChats, NoMatchingChats } from './ListStates';
import { SectionHeader } from './SectionHeader';
import { SessionsFilter } from './SessionsFilter';
import { NO_SECTION, applyOrder, dragSectionsOf, groupSessions, isNarrowing, listKeyStep, lockPinned } from './sessionsModel';
import type { SessionGroup } from './sessionsModel';
import './sessions.css';

export { filterChats, sortChats } from './sessionsModel';

type Editing = { readonly kind: 'chat'; readonly id: string } | { readonly kind: 'section'; readonly id: string } | undefined;

/** What the keyboard walks in the list: the rows that open a chat and the headers that fold a section. */
const LIST_FOCUS_SELECTOR = 'button.ai-list-open, button.ai-section-toggle';

export interface SessionsViewProps {
  readonly chats: readonly ChatSummary[];
  /** The chat open beside the list (split layout), marked in it; undefined when the list is the whole panel. */
  readonly selected?: ChatId | undefined;
  readonly layout?: ChatLayout | undefined;
}

export function SessionsView({ chats, selected, layout = 'stacked' }: SessionsViewProps) {
  const translate = useTranslate();
  const listRef = useRef<HTMLDivElement | undefined>(undefined);
  // The open chat's row stays in view as Ctrl+Tab or a new chat changes it; `nearest` never scrolls a row that already shows.
  useEffect(() => {
    if (selected === undefined) {
      return;
    }
    listRef.current?.querySelector(`[data-chat="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selected]);
  const state = useAiState();
  const { sections, views } = state;
  // With no chats at all there is nothing to narrow, so a filter left on cannot stand between the person and the way to start.
  const filter = chats.length === 0 ? DEFAULT_CHAT_FILTER : state.filter;
  const [editing, setEditing] = useState<Editing>(undefined);
  // A section made from the header's menu opens for naming here, as one made by the list's own button does.
  const nameRequest = useSectionNameRequest();
  useEffect(() => {
    if (nameRequest !== undefined) {
      setEditing({ kind: 'section', id: nameRequest });
      takeSectionNameRequest();
    }
  }, [nameRequest]);
  // The order a drop shows until the main process answers with the real list.
  const [pending, setPending] = useState<ReturnType<typeof dragSectionsOf> | undefined>(undefined);
  const grouping = groupSessions(chats, sections, filter);
  const live = chats.filter((chat) => chat.archivedAt === undefined);
  const ordered = pending === undefined ? grouping.groups : applyOrder(grouping.groups, pending);
  // "No section" stays while there are chats, as the way to drag one out of a section. With none it would only be an empty heading.
  const groups = live.length === 0 ? ordered.filter((group) => group.section !== undefined) : ordered;
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
  const { containerRef } = drag;
  const setListElement = useCallback<RefCallback<HTMLDivElement>>(
    (element) => {
      listRef.current = element ?? undefined;
      containerRef(element);
    },
    [containerRef],
  );
  const line = drag.dragging === undefined || drag.drop === undefined ? undefined : settledDrop(dragSections, pinned, drag.dragging, drag.drop);
  const sectionLimit = sections.length >= AI_LIMITS.sectionsMax;
  const content = listContent({
    chats: chats.length,
    live: live.length,
    sections: sections.length,
    shown: grouping.groups.reduce((total, group) => total + group.chats.length, 0) + grouping.archived.length,
    narrowing,
    read: state.chatsRead,
  });
  // The search is offered only while it has something to search: archived chats count once the filter shows them.
  const searchable = chats.length > 0 && (live.length > 0 || filter.showArchived || filter.query !== '');
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // A row handles its own letters and Alt+Arrow first; what it leaves, and only on a row or a header, is the list's.
    if (event.defaultPrevented || !(event.target instanceof HTMLElement) || !event.target.matches(LIST_FOCUS_SELECTOR)) {
      return;
    }
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(LIST_FOCUS_SELECTOR)];
    const target = listKeyStep(event, focusable.indexOf(event.target), focusable.length);
    if (target !== undefined) {
      event.preventDefault();
      focusable[target]?.focus();
    }
  };
  return (
    <div className={`ai-sessions is-${layout}`}>
      {(searchable || (layout === 'split' && chats.length > 0)) && (
        <div className="ai-sessions-tools">
          {searchable && (
            <SearchField
              label={translate('ai.sessions.search')}
              clearLabel={translate('elements.panel.clearSearch')}
              className="ai-sessions-search"
              value={filter.query}
              onChange={(query) => setChatListFilter({ ...filter, query })}
            />
          )}
          {layout === 'split' && <SessionsFilter />}
        </div>
      )}
      <div className="ai-list" ref={setListElement} onKeyDown={onListKeyDown}>
        {content === 'not-read' && <ChatsNotRead />}
        {content === 'no-match' && <NoMatchingChats />}
        {groups.map((group) => (
          <section key={group.key} className="ai-section" {...drag.sectionProps(group.key)}>
            {(group.section !== undefined || sections.length > 0) && (
              <SectionHeader
                name={group.section === undefined ? translate('ai.sessions.noSection') : group.name}
                section={group.section}
                sections={sections}
                chatCount={chats.filter((chat) => chat.section === group.section?.id).length}
                shownCount={group.chats.length}
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
                selected={selected}
                editing={editing}
                setEditing={setEditing}
                now={now}
                drag={drag}
                line={line}
                emptyText={translate(live.length === 0 ? 'ai.sessions.sectionEmpty' : 'ai.sessions.dropHere')}
              />
            )}
          </section>
        ))}
        {/* While narrowing, an archived heading with nothing under it is noise, like an empty section. */}
        {filter.showArchived && (!narrowing || grouping.archived.length > 0) && (
          <section className="ai-section ai-archived">
            <div className="ai-section-head is-static">
              <span className="ai-section-name">{translate('ai.sessions.archivedHeading')}</span>
            </div>
            <ul className="ai-list-rows">
              {grouping.archived.length === 0 && <li className="ai-section-empty">{translate('ai.sessions.noArchived')}</li>}
              {grouping.archived.map((chat) => (
                <ChatRow
                  key={chat.id}
                  chat={chat}
                  sections={sections}
                  running={false}
                  renaming={false}
                  selected={false}
                  now={now}
                  dragProps={undefined}
                  onRenameStart={() => undefined}
                  onRenameEnd={() => undefined}
                />
              ))}
            </ul>
          </section>
        )}
        {!narrowing && (live.length > 0 || sections.length > 0) && (
          <button
            className="ai-new-section"
            disabled={sectionLimit}
            title={sectionLimit ? translate('ai.sessions.sectionLimit', { count: AI_LIMITS.sectionsMax }) : translate('ai.sessions.addSection')}
            onClick={() => void addSection(sections, { sectionCreated: (id) => setEditing({ kind: 'section', id }) }, translate)}
          >
            <PlusIcon size={12} /> {translate('ai.sessions.newSection')}
          </button>
        )}
        {/* Last, so it takes the room that is left: the whole list when nothing else is in it. Split, the chat column shows it. */}
        {content === 'no-chats' && layout === 'stacked' && <NoChats />}
      </div>
    </div>
  );
}

type ListContent = 'rows' | 'no-chats' | 'no-match' | 'not-read';

/** Which card, if any, the list shows beside whatever sections and rows it has. */
function listContent(list: {
  readonly chats: number;
  readonly live: number;
  readonly sections: number;
  /** Rows the filter lets through, archived ones included when it shows them. */
  readonly shown: number;
  readonly narrowing: boolean;
  readonly read: ReturnType<typeof useAiState>['chatsRead'];
}): ListContent {
  assert(list.live <= list.chats, 'listContent: the live chats are some of the chats');
  assert(list.shown <= list.chats, 'listContent: no more rows than chats');
  // A list that never arrived is not an empty one: it must not say there are no chats.
  if (list.read === 'failed' && list.chats === 0 && list.sections === 0) {
    return 'not-read';
  }
  if (list.narrowing) {
    return list.shown === 0 ? 'no-match' : 'rows';
  }
  return list.live === 0 ? 'no-chats' : 'rows';
}

interface GroupRowsProps {
  /** What a section with no rows says. */
  readonly emptyText: string;
  readonly group: SessionGroup;
  readonly sections: ReturnType<typeof useAiState>['sections'];
  readonly running: (chat: ChatSummary) => boolean;
  readonly selected: ChatId | undefined;
  readonly editing: Editing;
  readonly setEditing: (editing: Editing) => void;
  readonly now: number;
  readonly drag: ReturnType<typeof useSectionedDrag>;
  readonly line: DropTarget | undefined;
}

function GroupRows({ group, sections, running, selected, editing, setEditing, now, drag, line, emptyText }: GroupRowsProps) {
  const lineHere = line !== undefined && line.sectionId === group.key;
  return (
    <ul className="ai-list-rows">
      {group.chats.length === 0 && <li className="ai-section-empty">{emptyText}</li>}
      {group.chats.map((chat) => (
        <Fragment key={chat.id}>
          {lineHere && line.beforeId === chat.id && <DropSlot />}
          <ChatRow
            chat={chat}
            sections={sections}
            running={running(chat)}
            renaming={editing?.kind === 'chat' && editing.id === chat.id}
            selected={chat.id === selected}
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
