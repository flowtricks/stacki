// The editor's key chords that would still act while Design mode covers it. The window hold (src/ui/busyLock.ts)
// refuses the application menu's edits, and the cleared selection leaves the selection's keys nothing to act on,
// but these reach the editor through the page itself: the insert palette's chords (⌘F, ⌘E, ⌘K), which insert into
// the open page; the left rail's panel chords (⌥ and a letter), which open a panel hidden under the cover, where
// keys typed next could change files; and the preview chord, which swaps the covered canvas. Design mode takes them
// before the editor hears them. The AI panel's own chord stays, so the chat can still be shown and hidden.
//
// The chords come from the rail's table, so a changed shortcut is followed. The palette's letters are written out
// here (their home also holds the editor's writes, which Design mode may not import); the boundary test holds the
// two lists equal.
import { PREVIEW_SHORTCUT, railActionOf } from '../../railShortcuts';

export const DESIGN_PALETTE_LETTERS: readonly string[] = ['f', 'e', 'k'];

export type CoveredKeyEvent = Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'key' | 'code'>;

/**
 * Whether the editor must not hear this key. `typing`: the key goes into a text field, which keeps its Option
 * letters (the rail ignores them there). `inCodeEditor`: a code editor keeps its own find.
 */
export function reachesCoveredEditor(event: CoveredKeyEvent, where: { readonly typing: boolean; readonly inCodeEditor: boolean }): boolean {
  if (event.metaKey || event.ctrlKey) {
    return DESIGN_PALETTE_LETTERS.includes(event.key.toLowerCase()) && !where.inCodeEditor;
  }
  if (where.typing) {
    return false;
  }
  if (isPreviewChord(event)) {
    return true;
  }
  const shortcut = railActionOf(event);
  return shortcut !== undefined && shortcut.action !== 'ai';
}

function isPreviewChord(event: CoveredKeyEvent): boolean {
  return event.altKey && event.shiftKey === PREVIEW_SHORTCUT.shift && event.code === 'Key' + PREVIEW_SHORTCUT.letter.toUpperCase();
}
