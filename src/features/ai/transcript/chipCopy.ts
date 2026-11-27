// Copying a selection of the transcript that holds chips: the clipboard gets plain text with each chip written out
// where it stood (`data-chip-copy`, MentionChipView.tsx), not the pill's short label. A code chip's text goes on
// lines of its own. A selection with no chip is left to the browser, which copies it as it always has.
import type { ClipboardEvent } from 'react';
import './transcript.css';
import { assert } from '../../../../shared/core/assert';
import { joinReadable, type ReadablePiece } from '../../../../shared/properties/ai/mentions';

const CHIPS = '[data-chip-copy]';
/** What is on screen beside the words but is not part of them. */
const CHROME = '.ai-msg-toolbar, .ai-msg-more, [aria-hidden="true"]';
/** Chips in one selection, and the marks standing for them: far more than the rows drawn at once hold. */
const SELECTION_CHIPS_MAX = 2_000;
// A private-use character, which no message's words hold, marks where each chip stood while the browser lays the rest out.
const MARK = '';

/**
 * The selection as plain text with its chips written out, or undefined when it holds none. `layout` turns the
 * copied nodes into text as the browser would (its line breaks); the default asks the browser itself.
 */
export function selectionTextWithChips(selection: Selection, layout: (fragment: HTMLElement) => string = renderedText): string | undefined {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }
  const holder = document.createElement('div');
  holder.append(selection.getRangeAt(0).cloneContents());
  const chips = [...holder.querySelectorAll(CHIPS)];
  if (chips.length === 0) {
    return undefined;
  }
  assert(chips.length <= SELECTION_CHIPS_MAX, 'selectionTextWithChips: the chips of a selection are bounded');
  for (const extra of holder.querySelectorAll(CHROME)) {
    // A chip's own icon is hidden from readers too; only chrome outside chips goes here, the chip is replaced whole below.
    if (extra.closest(CHIPS) === null) {
      extra.remove();
    }
  }
  const pieces: ReadablePiece[] = [];
  for (const chip of chips) {
    pieces.push({ text: chip.getAttribute('data-chip-copy') ?? '', block: chip.getAttribute('data-chip-block') === 'true' });
    chip.replaceWith(document.createTextNode(MARK));
  }
  const runs = layout(holder).split(MARK);
  const joined: ReadablePiece[] = [];
  runs.forEach((run, index) => {
    joined.push({ text: run, block: false });
    const piece = pieces[index];
    if (piece !== undefined) {
      joined.push(piece);
    }
  });
  return joinReadable(joined);
}

// Off screen but laid out: `innerText` gives a block its own line, which `textContent` does not.
function renderedText(fragment: HTMLElement): string {
  const stage = document.createElement('div');
  stage.className = 'ai-copy-stage';
  stage.append(...fragment.childNodes);
  document.body.append(stage);
  const text = stage.innerText;
  stage.remove();
  return text;
}

export function copyWithChips(event: ClipboardEvent<HTMLElement>): void {
  const selection = window.getSelection();
  const text = selection === null ? undefined : selectionTextWithChips(selection);
  if (text !== undefined) {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }
}
