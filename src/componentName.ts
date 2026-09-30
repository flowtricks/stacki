import { assert } from '../shared/assert';
import { LIMITS } from '../shared/limits';

// What a component may be called.
//
// A component's name is three things at once: the file on disk
// (src/components/Card.astro), the identifier the page imports it as, and the
// tag written in the markup. So it has to be a valid JS identifier, and it has
// to start with a capital — Astro reads a lowercase tag as an HTML element, so
// `<card />` renders a literal <card> nobody asked for rather than the
// component. Whatever gets typed in the name field ends up as all three, which
// is why what is typed is not what is saved: "Component name" is written down
// as ComponentName.

/**
 * The name a typed string becomes. Words are split on anything that can't be
 * in an identifier, and each is capitalised; the rest of a word is left as
 * typed, so `buttonArrow` becomes `ButtonArrow` rather than `Buttonarrow`.
 */
export function toComponentName(input: unknown): string {
  return (
    String(input ?? '')
      // é → e, ü → u. Without this an accented word doesn't just lose its marks,
      // it shatters: "héro" splits into "h" and "ro" and comes out as HRo.
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
  );
}

// Astro's own tag. A component file called Fragment.astro would be imported
// under a name that already means something else in every Astro file.
const RESERVED = new Set(['Fragment', 'Astro', 'Component', 'Props', 'Slot']);

/**
 * Why this name can't be used, or null when it can. `taken` is every name
 * already spoken for — components and layouts both, since the palette lists
 * them together and an import can only mean one of them.
 */
export function componentNameError(input: unknown, taken: readonly string[] = []): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return 'Give the component a name.';
  }
  const name = toComponentName(raw);
  if (!name) {
    return 'Use letters or numbers for the name.';
  }
  if (/^[0-9]/.test(name)) {
    return "A name can't start with a number.";
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    return 'Use letters and numbers only.';
  }
  if (RESERVED.has(name)) {
    return `${name} already means something in Astro.`;
  }
  // Case-insensitively: two files whose names differ only in case can't both
  // exist on a Mac, and two imports that differ only in case are a trap even
  // where they can.
  assert(taken.length <= LIMITS.scanEntriesMax, 'Component list exceeds scan limit');
  const clash = taken.find((other) => String(other).toLowerCase() === name.toLowerCase());
  if (clash) {
    return `There's already a component called ${clash}.`;
  }
  return null;
}

// Where a component lives under src/components. The folder is a path of plain
// words — the same shape the main process accepts — so the dialog can say what is
// wrong while it is typed instead of the write failing afterwards.
const FOLDER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FOLDER_DEPTH_MAX = 5;

/** What was typed as a folder, cleaned up: `Heading / Hero section` → `Heading/Hero-section`. */
export function toFolderPath(input: unknown): string {
  return String(input ?? '')
    .split(/[\/]+/)
    .map((segment) => segment.trim().replace(/\s+/g, '-'))
    .filter(Boolean)
    .join('/');
}

/** Why this folder can't be used, or null when it can. '' is fine: the root. */
export function folderError(folder: string): string | null {
  const segments = folder.split('/').filter(Boolean);
  if (segments.length > FOLDER_DEPTH_MAX) {
    return `At most ${FOLDER_DEPTH_MAX} levels deep.`;
  }
  const bad = segments.find((segment) => !FOLDER_SEGMENT.test(segment));
  return bad ? `"${bad}" can't be a folder name — use letters, digits, - or _.` : null;
}
