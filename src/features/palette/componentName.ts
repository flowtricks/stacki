import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';

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
 * Why this name can't be used, or undefined when it can. `taken` is every name
 * already spoken for — components and layouts both, since the palette lists
 * them together and an import can only mean one of them. The English text and
 * the reference the renderer translates travel together.
 */
export function componentNameProblem(input: unknown, taken: readonly string[] = []): Described | undefined {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return described('palette.name.empty');
  }
  const name = toComponentName(raw);
  if (!name) {
    return described('palette.name.noLetters');
  }
  if (/^[0-9]/.test(name)) {
    return described('palette.name.startsWithNumber');
  }
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) {
    return described('palette.name.lettersOnly');
  }
  if (RESERVED.has(name)) {
    return described('palette.name.reserved', { name });
  }
  // Case-insensitively: two files whose names differ only in case can't both
  // exist on a Mac, and two imports that differ only in case are a trap even
  // where they can.
  assert(taken.length <= LIMITS.scanEntriesMax, 'Component list exceeds scan limit');
  const clash = taken.find((other) => String(other).toLowerCase() === name.toLowerCase());
  if (clash) {
    return described('palette.name.taken', { name: clash });
  }
  return undefined;
}

/** The English sentence of `componentNameProblem`: for tests and logs. */
export function componentNameError(input: unknown, taken: readonly string[] = []): string | undefined {
  return componentNameProblem(input, taken)?.message;
}
