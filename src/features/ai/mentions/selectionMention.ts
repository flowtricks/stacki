// "Add selected element": what is selected on the canvas, as the chips the composer adds for it. A
// component instance becomes its component chip followed by a member chip for every value the instance
// writes (props with their values, the slots it fills, the attributes it passes beyond its declared props);
// a native element becomes an element chip (its file and locator) followed by its attributes and its
// short text. Only what the instance writes is taken, so a default it leaves alone is not called out,
// and one it writes explicitly is, even when it equals the default.
//
// The shell reads the selection the Properties panel reads and hands it over as plain data
// (`setSelectionMention`, from src/app/shell/aiSelection.ts); this file never reads the page model. The
// chips are sent as their compact references (shared/properties/ai/mentions.ts), at most
// `SELECTION_MEMBERS_MAX` members, the rest noted as a count.
import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import {
  elementKey,
  isProjectRelativePath,
  REFERENCE_CHIPS_MAX,
  type ComponentMemberChip,
  type ComposerSegment,
  type ComposerSegments,
  type MentionChip,
} from '../../../../shared/properties/ai/mentions';
import type { ChatId } from '../../../../shared/properties/ai/chatModel';
import { requestComposerFocus, setDraft } from '../aiStore';
import { normalizeSegments, referenceChipCountOf } from './mentionChips';

/** Member chips one "Add selected element" adds; the rest are noted as "+N more". */
export const SELECTION_MEMBERS_MAX = 40;
/** An element's text is taken when it is this short or is cut to it, with an ellipsis. */
export const SELECTION_TEXT_CHARS_MAX = 80;

export interface SelectionMember {
  readonly role: 'prop' | 'slot' | 'attr' | 'text';
  readonly name: string;
  readonly value: string | undefined;
}

export type SelectionMention =
  | { readonly kind: 'component'; readonly key: string; readonly path: string; readonly name: string; readonly members: readonly SelectionMember[] }
  | {
      readonly kind: 'element';
      readonly key: string;
      readonly path: string;
      readonly locator: string;
      readonly tag: string;
      readonly members: readonly SelectionMember[];
    };

/** What the "+ Add" row and pill call the selection: the component's name, or the element's tag. */
export function selectionLabel(selection: SelectionMention): string {
  return selection.kind === 'component' ? selection.name : `<${selection.tag}>`;
}

/** An element's text as a member value: trimmed, whitespace collapsed, cut at the bound with an ellipsis. */
export function shortText(text: string): string | undefined {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed === '') {
    return undefined;
  }
  const characters = [...collapsed];
  const result = characters.length <= SELECTION_TEXT_CHARS_MAX ? collapsed : `${characters.slice(0, SELECTION_TEXT_CHARS_MAX - 1).join('')}…`;
  assert([...result].length <= SELECTION_TEXT_CHARS_MAX, 'shortText: within the bound');
  return result;
}

function memberChipOf(owner: string, member: SelectionMember): ComponentMemberChip {
  switch (member.role) {
    case 'slot':
      return { kind: 'member', component: owner, role: 'slot', name: member.name, value: undefined };
    case 'text':
      assert(member.value !== undefined, 'memberChipOf: text has a value');
      return { kind: 'member', component: owner, role: 'text', name: 'text', value: member.value };
    case 'prop':
    case 'attr':
      return { kind: 'member', component: owner, role: member.role, name: member.name, value: member.value };
    default: {
      const exhaustive: never = member.role;
      return exhaustive;
    }
  }
}

/**
 * The draft with the selection appended: its owner chip, then each member chip, a space between, and when more
 * members were written than fit, `+N more` after them. Within the reference-chip bound; a draft already at it is
 * returned unchanged.
 */
export function appendSelection(segments: ComposerSegments, selection: SelectionMention): ComposerSegments {
  assert(isProjectRelativePath(selection.path), 'appendSelection: the selection names a project file');
  const room = REFERENCE_CHIPS_MAX - referenceChipCountOf(segments) - 1;
  if (room < 0) {
    return segments;
  }
  const owner: MentionChip =
    selection.kind === 'component'
      ? { kind: 'component', path: selection.path, name: selection.name }
      : { kind: 'element', path: selection.path, locator: selection.locator, tag: selection.tag };
  const ownerKey = owner.kind === 'element' ? elementKey(owner) : selection.path;
  const taken = selection.members.slice(0, Math.min(SELECTION_MEMBERS_MAX, room));
  const more = selection.members.length - taken.length;
  const last = segments[segments.length - 1];
  const joined: ComposerSegment[] = [...segments];
  if (last?.kind === 'text' && last.text !== '' && !/\s$/u.test(last.text)) {
    joined.push({ kind: 'text', text: ' ' });
  }
  joined.push({ kind: 'chip', chip: owner });
  for (const member of taken) {
    joined.push({ kind: 'text', text: ' ' }, { kind: 'chip', chip: memberChipOf(ownerKey, member) });
  }
  // i18n-ignore: sent to the agent as part of the message, which says how many values were left out.
  joined.push({ kind: 'text', text: more > 0 ? ` +${more} more ` : ' ' });
  assert(referenceChipCountOf(joined) === referenceChipCountOf(segments) + 1 + taken.length, 'appendSelection: one chip per member taken');
  return normalizeSegments(joined);
}

/** Adds the current selection to a chat's draft and gives the message box the keyboard. False when nothing is selected. */
export function addSelectionToDraft(chat: ChatId): boolean {
  const selection = current;
  if (selection === undefined) {
    return false;
  }
  setDraft(chat, (draft) => ({ ...draft, segments: appendSelection(draft.segments, selection) }));
  requestComposerFocus();
  return true;
}

// ---------------------------------------------------------------------------
// The selection the shell hands over
// ---------------------------------------------------------------------------

let current: SelectionMention | undefined;
const listeners = new Set<() => void>();

/** Called by the shell whenever the canvas selection or what it writes changes; undefined when nothing is selected. */
export function setSelectionMention(selection: SelectionMention | undefined): void {
  if (selection?.key === current?.key && selection?.members === current?.members) {
    return;
  }
  current = selection;
  for (const listener of [...listeners]) {
    listener();
  }
}

/** What is selected on the canvas, for the + menu's "Add selected" row. */
export function useSelectionMention(): SelectionMention | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}
