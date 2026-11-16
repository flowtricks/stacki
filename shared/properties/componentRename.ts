// Renaming a component and moving it to another folder under the components root: the contract between the
// Components panel (a dialog with a live "taken?" line and a preview of the files that change) and main (which plans the
// rewrite across the whole project, then applies it all or not at all). Nothing here touches the disk.
//
// A request names the file as it is and as it should be, both project-relative with `/`. The plan's summary is what the
// dialog shows before anything is written: the files that will change, and notices for what the rewrite saw but did not
// (or could not) change.
import { assert } from '../core/assert';
import { list, object, record, text } from '../core/boundary';
import { parseComponentPath } from './componentAccess';

export interface ComponentRenameRequest {
  readonly from: string;
  readonly to: string;
}

/** Names Astro or Stacki already gives a meaning to; a component file cannot take one. */
export const RESERVED_COMPONENT_NAMES: ReadonlySet<string> = new Set(['Fragment', 'Astro', 'Component', 'Props', 'Slot']);

/** Whether `name` can be a component file's name, tag and import binding at once: PascalCase letters and digits, not reserved. */
export function isComponentName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name) && !RESERVED_COMPONENT_NAMES.has(name);
}

/** What a request names, read at the boundary: two `.astro` project paths, the second with a valid component name. */
export function parseComponentRenameRequest(input: unknown): ComponentRenameRequest {
  const value = record(input);
  const from = parseComponentPath(value['from']);
  const to = parseComponentPath(value['to']);
  for (const file of [from, to]) {
    if (!file.endsWith('.astro')) {
      throw new Error('A component file ends in .astro');
    }
  }
  const name = to.slice(to.lastIndexOf('/') + 1, -'.astro'.length);
  if (!isComponentName(name)) {
    throw new Error(`"${name}" is not a component name`);
  }
  return { from, to };
}

/** How a changed file is described in the summary: where it lives decides how the dialog words it. */
export const RENAME_FILE_KINDS = ['component', 'page', 'layout', 'code', 'settings', 'content'] as const;
export type RenameFileKind = (typeof RENAME_FILE_KINDS)[number];

/** What a notice says the rewrite did not do. */
export const RENAME_NOTICE_KINDS = ['unparsed', 'kept-local-name', 'mention', 'namespace'] as const;
export type RenameNoticeKind = (typeof RENAME_NOTICE_KINDS)[number];

export interface RenameFileChange {
  readonly file: string;
  readonly kind: RenameFileKind;
}

export interface RenameNotice {
  readonly file: string;
  readonly kind: RenameNoticeKind;
}

export interface ComponentRenameSummary {
  readonly from: string;
  readonly to: string;
  /** Files whose text changes, the moved component first when its own text changes. */
  readonly files: readonly RenameFileChange[];
  readonly notices: readonly RenameNotice[];
}

export const COMPONENT_RENAME_LIMITS = {
  /** Undo steps main keeps for renames; the oldest is forgotten past this. */
  undoEntriesMax: 16,
} as const satisfies Record<string, number>;

function oneOf<T extends string>(values: readonly T[], what: string): (input: unknown) => T {
  return (input) => {
    const found = values.find((value) => value === input);
    if (found === undefined) {
      throw new Error(`Unknown ${what}`);
    }
    return found;
  };
}

const parseFileChange = object({ file: text, kind: oneOf(RENAME_FILE_KINDS, 'rename file kind') });
const parseNotice = object({ file: text, kind: oneOf(RENAME_NOTICE_KINDS, 'rename notice kind') });

/** The summary as it crosses the wire. */
export function parseComponentRenameSummary(input: unknown): ComponentRenameSummary {
  const value = record(input);
  const files = list(parseFileChange)(value['files']);
  const notices = list(parseNotice)(value['notices']);
  assert(files.length >= 0, 'A summary lists its files');
  return { from: text(value['from']), to: text(value['to']), files, notices };
}

/** A rename's undo handle plus its summary, as `component:rename` answers. */
export function parseComponentRenameApplied(input: unknown): ComponentRenameSummary & { readonly undo: string } {
  const value = record(input);
  return { ...parseComponentRenameSummary(input), undo: text(value['undo']) };
}
