// The built-in chips: instructions Stacki bundles itself. A person puts one in a
// message (the `@` picker, or the Apps panel's "Build an app"), the message carries
// the bundled text with it, and clicking the chip copies the same text, so someone
// building outside the project can paste it into any agent.
//
// The text lives in this app (docs/apps-prompt.md, through the Apps panel's generated
// module, which provides it to src/lib/builtinInstructions.ts), never in the project:
// the main process cannot read the renderer's bundle, so the renderer hands the text
// over at send time. Importing this module registers the lookup with the store, once,
// at load; a build that sends a chip before its owner provided the text fails an
// assertion rather than sending a chip with no words.
import { assert } from '../../../../shared/core/assert';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import { BUILTIN_CHIP_IDS, BUILTIN_CHIP_TITLES, type BuiltinChipId, type MentionChip } from '../../../../shared/properties/ai/mentions';
import { reportErrorToast } from '../../../ui/errorNotices';
import { builtinInstructionsText } from '../../../lib/builtinInstructions';
import { registerBuiltinChipText } from '../aiStore';

export type BuiltinMentionChip = Extract<MentionChip, { readonly kind: 'builtin' }>;

export interface BuiltinChipDefinition {
  readonly title: string;
  /** The hover text: what the chip is and what clicking it does. */
  readonly description: string;
  /** Extra words the picker matches besides the title. */
  readonly keywords: readonly string[];
  /** The bundled text, read when it is needed so a test or a hot reload sees the current module. */
  readonly text: () => string;
}

export const BUILTIN_CHIPS: Readonly<Record<BuiltinChipId, BuiltinChipDefinition>> = {
  'app-builder': {
    title: BUILTIN_CHIP_TITLES['app-builder'],
    description: 'Instructions for building a Stacki app. Click to copy them.',
    keywords: ['app', 'build', 'builder', 'stacki', 'sdk', 'manifest'],
    text: () => builtinInstructionsText('app-builder'),
  },
};

/** How long a chip says "Copied" after a click. */
export const COPIED_LABEL_MS = 1_500;
export const COPIED_LABEL = 'Copied';

/** The bundled text of a built-in chip, checked: never empty, never past what a prompt part may carry. */
export function builtinChipText(id: BuiltinChipId): string {
  const text = BUILTIN_CHIPS[id].text();
  assert(text.trim().length > 0, 'builtinChipText: the bundled instructions are not empty');
  assert(text.length <= AI_LIMITS.mentionBuiltinCharsMax, 'builtinChipText: the bundled instructions fit a prompt part');
  return text;
}

export function builtinChip(id: BuiltinChipId): BuiltinMentionChip {
  return { kind: 'builtin', id, title: BUILTIN_CHIPS[id].title };
}

/** The built-in chips whose title or keywords match what was typed after `@`, in registry order. */
export function matchingBuiltinChips(query: string): readonly BuiltinMentionChip[] {
  const needle = query.trim().toLowerCase();
  const matches = BUILTIN_CHIP_IDS.filter((id) => {
    if (needle === '') {
      return true;
    }
    const definition = BUILTIN_CHIPS[id];
    return (
      [definition.title, ...definition.keywords].some((word) => word.toLowerCase().includes(needle)) || isSubsequence(needle, definition.title.toLowerCase())
    );
  });
  assert(matches.length <= BUILTIN_CHIP_IDS.length, 'matchingBuiltinChips: a subset');
  return matches.map(builtinChip);
}

/** Whether every character of `needle` appears in `haystack` in order (a loose, typo-tolerant match for a short title). */
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found < 0) {
      return false;
    }
    at = found + 1;
  }
  return true;
}

/**
 * Copies a built-in chip's instructions to the clipboard. True when it worked; on failure the person is told
 * through the error toast and the result is false, so the caller shows no "Copied".
 */
export async function copyBuiltinChip(id: BuiltinChipId): Promise<boolean> {
  // Read outside the try: a bundle with no instructions is a programmer error that must crash, not become a toast.
  const text = builtinChipText(id);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error: unknown) {
    // A missing permission or a focus-less window: expected, and the person can try again.
    reportErrorToast(`Couldn’t copy the instructions: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

registerBuiltinChipText(builtinChipText);
