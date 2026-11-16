// What the rename dialog says under the name field on every keystroke: whether the component can be saved as `folder/name.astro`.
// Pure and instant, worked out from the project's component list, so nothing waits on the disk while someone types. Main checks
// the same rules again before it writes (electron/handlers/componentRenamePlan.ts): this only spares a round trip and says why.
//
// Taken is a clash of the file path, compared without case (two files differing only in case cannot both exist on a Mac). A
// component with the same NAME in another folder is allowed but warned about: Astro tags are written by name, so a page that
// imports both must give one an alias.
import { toComponentName } from './componentName';
import { componentNameProblem } from './componentName';
import type { Described } from '../../../shared/properties/i18n/messageRef';
import { described } from '../../../shared/properties/i18n/messageRef';

export interface RenameCandidate {
  /** Project-relative file, `/` separators. */
  readonly file: string;
  readonly name: string;
}

export type RenameAvailability =
  | { readonly kind: 'same' }
  | { readonly kind: 'invalid'; readonly problem: Described }
  | { readonly kind: 'taken'; readonly by: string }
  | { readonly kind: 'available'; readonly path: string; readonly sameNameIn: string | undefined };

export interface RenameInput {
  /** The component being renamed, as it is on disk. */
  readonly current: string;
  /** What is typed in the name field. */
  readonly name: string;
  /** The folder chosen, project-relative with no trailing slash. */
  readonly folder: string;
  readonly components: readonly RenameCandidate[];
}

export function renameAvailability(input: RenameInput): RenameAvailability {
  const typed = input.name.trim();
  if (typed.includes('/') || typed.includes('\\')) {
    return { kind: 'invalid', problem: described('palette.rename.separator') };
  }
  if (/\.astro$/i.test(typed)) {
    return { kind: 'invalid', problem: described('palette.rename.extension') };
  }
  const problem = componentNameProblem(typed);
  if (problem !== undefined) {
    return { kind: 'invalid', problem };
  }
  // Letters and numbers exactly as typed: the field never silently turns "my card" into "MyCard" the way a new component's name does.
  if (toComponentName(typed) !== typed) {
    return { kind: 'invalid', problem: described('palette.name.lettersOnly') };
  }
  const path = `${input.folder}/${typed}.astro`;
  if (path === input.current) {
    return { kind: 'same' };
  }
  const clash = input.components.find((other) => other.file !== input.current && other.file.toLowerCase() === path.toLowerCase());
  if (clash !== undefined) {
    return { kind: 'taken', by: clash.file };
  }
  const twin = input.components.find((other) => other.file !== input.current && other.name.toLowerCase() === typed.toLowerCase());
  return { kind: 'available', path, sameNameIn: twin?.file };
}

/** Why a new folder's name cannot be used, or undefined: letters, numbers, dashes and underscores, `/` between levels, no climbing. */
export function folderNameProblem(input: string): Described | undefined {
  const typed = input.trim();
  if (typed === '') {
    return described('palette.rename.folderInvalid');
  }
  const ok = typed.split('/').every((segment) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment));
  return ok ? undefined : described('palette.rename.folderInvalid');
}
