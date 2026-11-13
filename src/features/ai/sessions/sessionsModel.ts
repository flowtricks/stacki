// The pure half of the sessions list: which chats show under which section, in which order, what a drag
// is allowed to do with pinned chats, which key means which action, and how a name or an age is written.
// Nothing here touches the DOM or the store, so every refusal is a plain function the tests call.
import { assert } from '../../../../shared/core/assert';
import type { Formatters } from '../../../../shared/core/i18n/format';
import type { ChatContext, ChatSection, ChatSummary, SectionId } from '../../../../shared/properties/ai/chatModel';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { DragSection, DropTarget } from '../../../ui/sectionedDragModel';
import type { ChatListFilter } from '../aiStore';
import { formatTokens, type ChatWords } from '../chatStatus';

/** The drag id of the implicit first section (chats with no section). A section id is `s<16 hex>`, so it never collides. */
export const NO_SECTION = 'none';

/** One section as the list draws it, with the chats it shows in display order. */
export interface SessionGroup {
  /** `NO_SECTION` for the implicit first section, else the section's id. */
  readonly key: string;
  readonly section: ChatSection | undefined;
  readonly name: string;
  /** Whether the rows are hidden: the stored mark, except that a search shows what it found. */
  readonly collapsed: boolean;
  readonly chats: readonly ChatSummary[];
}

export interface SessionsLayout {
  readonly groups: readonly SessionGroup[];
  /** Archived chats that match the filter, most recently archived first; empty unless the filter asks for them. */
  readonly archived: readonly ChatSummary[];
}

/** A filter that narrows the list (a search, unread, pinned, an agent). It hides empty sections and turns dragging off. */
export function isNarrowing(filter: ChatListFilter): boolean {
  return filter.query.trim() !== '' || filter.onlyUnread || filter.onlyPinned || filter.agent !== undefined;
}

/** A choice made in the filter menu (the search has its own field), for the filter button's mark. */
export function isCustomFilter(filter: ChatListFilter): boolean {
  return filter.showArchived || filter.onlyUnread || filter.onlyPinned || filter.agent !== undefined;
}

export function matchesFilter(chat: ChatSummary, filter: ChatListFilter): boolean {
  if (filter.onlyUnread && !chat.unread) {
    return false;
  }
  if (filter.onlyPinned && !chat.pinned) {
    return false;
  }
  if (filter.agent !== undefined && filter.agent !== chat.agent) {
    return false;
  }
  return filterChats([chat], filter.query).length === 1;
}

/** The sections with the chats the filter lets through; pinned chats first inside a section, then by rank. */
export function groupSessions(chats: readonly ChatSummary[], sections: readonly ChatSection[], filter: ChatListFilter): SessionsLayout {
  assert(chats.length <= AI_LIMITS.chatsMax, 'groupSessions: chat limit exceeded');
  assert(sections.length <= AI_LIMITS.sectionsMax, 'groupSessions: section limit exceeded');
  const narrowing = isNarrowing(filter);
  const known = new Set<string>(sections.map((section) => section.id));
  const bySection = new Map<string, ChatSummary[]>();
  const archived: ChatSummary[] = [];
  for (const chat of chats) {
    if (!matchesFilter(chat, filter)) {
      continue;
    }
    if (chat.archivedAt !== undefined) {
      archived.push(chat);
      continue;
    }
    const key = chat.section !== undefined && known.has(chat.section) ? chat.section : NO_SECTION;
    bySection.set(key, [...(bySection.get(key) ?? []), chat]);
  }
  const ordered = [...sections].sort((left, right) => left.rank - right.rank);
  const everyGroup: readonly SessionGroup[] = [
    {
      key: NO_SECTION,
      section: undefined,
      name: 'No section', // i18n-ignore: the implicit section's identity; SessionsView shows it translated.
      collapsed: false,
      chats: orderWithinSection(bySection.get(NO_SECTION) ?? []),
    },
    ...ordered.map((section) => ({
      key: section.id,
      section,
      name: section.name,
      collapsed: section.collapsed && !narrowing,
      chats: orderWithinSection(bySection.get(section.id) ?? []),
    })),
  ];
  // While a filter is on, a section with nothing to show is only noise.
  const groups = narrowing ? everyGroup.filter((group) => group.chats.length > 0) : everyGroup;
  const archivedShown = filter.showArchived ? [...archived].sort((left, right) => (right.archivedAt ?? 0) - (left.archivedAt ?? 0)) : [];
  assert(groups.length <= sections.length + 1, 'groupSessions: no section is invented');
  return { groups, archived: archivedShown };
}

function orderWithinSection(chats: readonly ChatSummary[]): readonly ChatSummary[] {
  return [...chats].sort((left, right) => Number(right.pinned) - Number(left.pinned) || left.rank - right.rank || right.updatedAt - left.updatedAt);
}

/** The list a drag works on: one entry per section drawn, holding the chats whose rows can be dragged. */
export function dragSectionsOf(groups: readonly SessionGroup[]): readonly DragSection[] {
  return groups.map((group) => ({ id: group.key, collapsed: group.collapsed, itemIds: group.chats.map((chat) => chat.id) }));
}

/** The groups with the chats put in the order `sections` says; a chat not in the groups is skipped. */
export function applyOrder(groups: readonly SessionGroup[], sections: readonly DragSection[]): readonly SessionGroup[] {
  const byId = new Map<string, ChatSummary>();
  for (const group of groups) {
    for (const chat of group.chats) {
      byId.set(chat.id, chat);
    }
  }
  const order = new Map(sections.map((section) => [section.id, section.itemIds] as const));
  return groups.map((group) => {
    const ids = order.get(group.key);
    if (ids === undefined) {
      return group;
    }
    const chats = ids.flatMap((id) => {
      const chat = byId.get(id);
      return chat === undefined ? [] : [chat];
    });
    return { ...group, chats };
  });
}

/**
 * Adjusts where a drop lands so pinned chats stay first in their section: a pinned chat cannot go below
 * the first unpinned one, and an unpinned chat cannot go above the last pinned one. The model of the drag
 * does not know about pinning, so this runs between its decision and the move. A target the sections do not
 * know is returned as it is for the model to refuse.
 */
export function lockPinned(sections: readonly DragSection[], pinned: ReadonlySet<string>, itemId: string, target: DropTarget): DropTarget {
  const destination = sections.find((section) => section.id === target.sectionId);
  if (destination === undefined) {
    return target;
  }
  const others = destination.itemIds.filter((id) => id !== itemId);
  const wanted = target.beforeId === undefined ? others.length : others.indexOf(target.beforeId);
  if (wanted < 0) {
    return target;
  }
  const boundary = others.findIndex((id) => !pinned.has(id));
  const pinnedCount = boundary < 0 ? others.length : boundary;
  const index = pinned.has(itemId) ? Math.min(wanted, pinnedCount) : Math.max(wanted, pinnedCount);
  assert(index >= 0, 'lockPinned: the index is not negative');
  assert(index <= others.length, 'lockPinned: the index is inside the section');
  return { sectionId: target.sectionId, beforeId: others[index] };
}

/** Something a person can do to a chat, from its menu or a letter on its row. */
export type ChatAction = 'pin' | 'unread' | 'rename' | 'fork' | 'archive' | 'restore' | 'delete';

export interface KeyEventLike {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

/** The action a letter means on a focused row: P, U, R, F, A, D with no modifier. Restore shares the archive letter and is chosen by the caller. */
export function rowShortcut(event: KeyEventLike): Exclude<ChatAction, 'restore'> | undefined {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return undefined;
  }
  switch (event.key.toLowerCase()) {
    case 'p':
      return 'pin';
    case 'u':
      return 'unread';
    case 'r':
      return 'rename';
    case 'f':
      return 'fork';
    case 'a':
      return 'archive';
    case 'd':
      return 'delete';
    default:
      return undefined;
  }
}

export type NameCheck = { readonly kind: 'ok'; readonly name: string } | { readonly kind: 'empty' } | { readonly kind: 'too-long'; readonly limit: number };

/** A typed name: trimmed, not empty, at most `limit` characters. */
export function checkName(value: string, limit: number): NameCheck {
  assert(limit > 0, 'checkName: the limit is positive');
  const name = value.trim();
  if (name === '') {
    return { kind: 'empty' };
  }
  if (name.length > limit) {
    return { kind: 'too-long', limit };
  }
  return { kind: 'ok', name };
}

export const CHAT_TITLE_CHARS_MAX = AI_LIMITS.titleCharsMax;
export const SECTION_NAME_CHARS_MAX = AI_LIMITS.sectionNameCharsMax;

/** A name for a new section that no other section has (ignoring case): "New section", then "New section 2". */
export function uniqueSectionName(existing: readonly string[], base: string): string {
  assert(base.length > 0, 'uniqueSectionName: a base name');
  const taken = new Set(existing.map((name) => name.toLowerCase()));
  for (let number = 1; number <= existing.length + 1; number += 1) {
    const candidate = number === 1 ? base : `${base} ${number}`;
    if (!taken.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  // Unreachable: among n names at most n candidates are taken, so one of the first n + 1 is free.
  throw new Error('uniqueSectionName: no free name among the candidates');
}

/** A section's neighbours for Move up and Move down: the section to go before, or `none` when it is already at that end. */
export function sectionStep(
  sections: readonly ChatSection[],
  section: SectionId,
  direction: 'up' | 'down',
): { readonly before: SectionId | undefined } | undefined {
  const ordered = [...sections].sort((left, right) => left.rank - right.rank);
  const index = ordered.findIndex((candidate) => candidate.id === section);
  if (index < 0) {
    return undefined;
  }
  if (direction === 'up') {
    const previous = ordered[index - 1];
    return previous === undefined ? undefined : { before: previous.id };
  }
  if (index >= ordered.length - 1) {
    return undefined;
  }
  // Past the next section means before the one after it, or last.
  return { before: ordered[index + 2]?.id };
}

/** The short age a row ends with: "now", "5m", "3h", "2d", then a date. The unit marks come from `Intl` (narrow), so they follow the language. */
export function ageLabel(at: number, now: number, words: ChatWords & Pick<Formatters, 'formatDate'>): string {
  const unit = (value: number, name: 'minute' | 'hour' | 'day'): string =>
    words.formatNumber(value, { style: 'unit', unit: name, unitDisplay: 'narrow', maximumFractionDigits: 0 });
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) {
    return words.translate('ai.sessions.now');
  }
  if (minutes < 60) {
    return unit(minutes, 'minute');
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return unit(hours, 'hour');
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return unit(days, 'day');
  }
  return words.formatDate(at, { month: 'short', day: 'numeric' });
}

/** "41K of 1M tokens"; undefined before the agent reports a window. */
export function contextSummary(context: ChatContext | undefined, words: ChatWords): string | undefined {
  if (context === undefined || context.size <= 0 || context.used < 0) {
    return undefined;
  }
  return words.translate('ai.sessions.context', { used: formatTokens(context.used, words.formatNumber), size: formatTokens(context.size, words.formatNumber) });
}

export function filterChats(chats: readonly ChatSummary[], query: string): readonly ChatSummary[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== '');
  const shown = chats.filter((chat) => words.every((word) => chat.title.toLowerCase().includes(word)));
  assert(shown.length <= chats.length, 'filterChats: a subset');
  return shown;
}

/** Pinned first, then the most recently updated: the order a flat list (no sections) is read in. */
export function sortChats(chats: readonly ChatSummary[]): readonly ChatSummary[] {
  return [...chats].sort((left, right) => Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt);
}
