// "Add to chat": a selection of code (in the Code panel, or the selected element's) goes into the AI panel's
// message box as two chips, the code and the file it is in, at the box's caret. Nothing is sent and nothing the
// person typed is touched. It goes to the open chat, or the one the panel would open on, or a new one; a reply
// that is running changes nothing, since the box takes words then too.
//
// What does not fit is refused whole with the reason in a toast: a selection is never cut to fit, since a cut
// snapshot would not be the code the person selected.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { ChatId } from '../../../shared/properties/ai/chatModel';
import {
  chipBoundProblem,
  plainTextOf,
  type ChipBoundProblem,
  type CodeChip,
  type ComposerSegments,
  type MentionChip,
  type PageChip,
} from '../../../shared/properties/ai/mentions';
import type { Translator } from '../../lib/i18n/localeContext';
import { CHIP_COUNT_MAX } from '../../ui/chipEditor/chipModel';
import { reportErrorToast } from '../../ui/errorNotices';
import { aiState, EMPTY_DRAFT, loadAiProject, openStartingChat, requestComposerFocus, setDraft } from './aiStore';
import { composerCaretMemory, composerTarget } from './composerTargets';
import { documentLengthOf, joinAtCaret, splitAtCaret } from './composer/caretSegments';

/** What was selected: the code as it read, and the file it is in. */
export interface SelectionChips {
  readonly code: CodeChip;
  readonly page: PageChip;
}

export type AddProblem = 'empty' | 'selection-too-long' | 'message-too-long' | 'too-many-chips' | ChipBoundProblem;

/** The draft up to the caret with the two chips after it, a space around each so no word runs into one. */
export function withSelectionChips(before: ComposerSegments, chips: SelectionChips): ComposerSegments {
  const last = before[before.length - 1];
  const spaced = last === undefined || (last.kind === 'text' && /\s$/u.test(last.text));
  return [
    ...before,
    ...(spaced ? [] : [{ kind: 'text' as const, text: ' ' }]),
    { kind: 'chip', chip: chips.code },
    { kind: 'text', text: ' ' },
    { kind: 'chip', chip: chips.page },
    { kind: 'text', text: ' ' },
  ];
}

/** Why the chips cannot join `draft`, or undefined when they can. */
export function selectionProblem(draft: ComposerSegments, chips: SelectionChips): AddProblem | undefined {
  if (chips.code.code.trim() === '') {
    return 'empty';
  }
  if (chips.code.code.length > AI_LIMITS.codeChipCharsMax) {
    return 'selection-too-long';
  }
  const next = withSelectionChips(draft, chips);
  const held: readonly MentionChip[] = next.flatMap((segment) => (segment.kind === 'chip' ? [segment.chip] : []));
  const bound = chipBoundProblem(held);
  if (bound !== undefined) {
    return bound;
  }
  if (held.length > CHIP_COUNT_MAX || next.length > AI_LIMITS.composerSegmentsMax) {
    return 'too-many-chips';
  }
  return plainTextOf(next).length > AI_LIMITS.promptCharsMax ? 'message-too-long' : undefined;
}

export function addProblemText(problem: AddProblem, translate: Translator): string {
  switch (problem) {
    case 'empty':
      return translate('ai.add.empty');
    case 'selection-too-long':
      return translate('ai.add.selectionTooLong', { max: AI_LIMITS.codeChipCharsMax });
    case 'too many code selections':
      return translate('ai.add.tooManySelections', { max: AI_LIMITS.codeChipsMax });
    case 'too much code':
      return translate('ai.add.tooMuchCode', { max: AI_LIMITS.codeChipsCharsMax });
    case 'message-too-long':
      return translate('ai.store.messageTooLong', { max: AI_LIMITS.promptCharsMax });
    case 'too many mentions':
    case 'too many references':
    case 'too-many-chips':
      return translate('ai.add.tooManyChips');
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

/** Puts the chips in chat `chat`'s box at its caret and gives it the keyboard. */
function placeChips(chat: ChatId, chips: SelectionChips): void {
  const change = (before: ComposerSegments): ComposerSegments => withSelectionChips(before, chips);
  const open = composerTarget(chat);
  if (open !== undefined) {
    open(change);
  } else {
    // The box is not up yet: the chips go in where its caret was, and the box opens with the caret after them.
    const memory = composerCaretMemory(chat);
    const draft = aiState().drafts.get(chat) ?? EMPTY_DRAFT;
    const split = splitAtCaret(draft.segments, memory.read() ?? documentLengthOf(draft.segments));
    const joined = joinAtCaret(change(split.before), split.after);
    setDraft(chat, (current) => ({ ...current, segments: joined.segments }));
    memory.write(joined.caret);
  }
  requestComposerFocus();
}

/**
 * Adds the selection to the project's open chat (or the one the panel would open on). The caller has shown the
 * panel. False when it was refused, with the reason in a toast.
 */
export async function addSelectionToChat(projectPath: string, chips: SelectionChips, translate: Translator): Promise<boolean> {
  assert(projectPath.length > 0, 'addSelectionToChat: a project is named');
  if (aiState().projectPath !== projectPath || !aiState().loaded) {
    await loadAiProject(projectPath);
  }
  if (aiState().open === undefined) {
    await openStartingChat();
  }
  const chat = aiState().open;
  if (chat === undefined || aiState().projectPath !== projectPath) {
    return false; // No chat could be made (the panel shows why), or another project opened meanwhile.
  }
  const problem = selectionProblem((aiState().drafts.get(chat) ?? EMPTY_DRAFT).segments, chips);
  if (problem !== undefined) {
    reportErrorToast(addProblemText(problem, translate));
    return false;
  }
  placeChips(chat, chips);
  return true;
}
