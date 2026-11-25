// What the "⋯" menu of the list's header holds: "New section", then the window's own controls the host offers.
// Why here too: the list's foot has the same button, but an empty list shows only its one card, so the menu is
// where a section can still be made before the first chat. The header and the list are separate components, so
// the new section's id is handed to the list through a one-value store, and the list opens its name for typing.
import { useSyncExternalStore } from 'react';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import type { SectionId } from '../../../../shared/properties/ai/chatModel';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { FolderPlusIcon } from '../../../ui/Icons';
import type { MenuEntry } from '../../../ui/Menu';
import { useAiState } from '../aiStore';
import { addSection } from './chatActions';
import { isNarrowing } from './sessionsModel';

let nameRequest: SectionId | undefined;
const listeners = new Set<() => void>();

function setNameRequest(next: SectionId | undefined): void {
  nameRequest = next;
  for (const listener of [...listeners]) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function readNameRequest(): SectionId | undefined {
  return nameRequest;
}

/** The section the menu has just made and the list has yet to open for naming. */
export function useSectionNameRequest(): SectionId | undefined {
  return useSyncExternalStore(subscribe, readNameRequest, readNameRequest);
}

export function takeSectionNameRequest(): void {
  setNameRequest(undefined);
}

export function useListMenuEntries(windowEntries: readonly MenuEntry[]): readonly MenuEntry[] {
  const translate = useTranslate();
  const { sections, filter, chats } = useAiState();
  const atLimit = sections.length >= AI_LIMITS.sectionsMax;
  // A narrowed list hides empty sections, so a new one would be made out of sight. With no chats the filter is ignored.
  const outOfSight = chats.length > 0 && isNarrowing(filter);
  const newSection: MenuEntry = {
    kind: 'item',
    id: 'new-section',
    label: translate('ai.sessions.newSection'),
    icon: <FolderPlusIcon size={14} />,
    disabled: atLimit || outOfSight,
    ...(atLimit ? { tooltip: translate('ai.sessions.sectionLimit', { count: AI_LIMITS.sectionsMax }) } : {}),
    onSelect: () => void addSection(sections, { sectionCreated: setNameRequest }, translate),
  };
  return windowEntries.length === 0 ? [newSection] : [newSection, { kind: 'divider', id: 'divider-new-section' }, ...windowEntries];
}
