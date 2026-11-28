// The HTTP routes that write project files, each held to what its own part of the editor writes. The route gate
// (serverAccess.ts) answers whether a role may use a route at all; these answer which files and content that use
// may reach. The collaboration socket asks the same questions in the room (rooms.ts).
import { can, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { parseMergeResolution } from '../../../vendor/stacki/shared/ipc/mergeResolution';
import { record, sourcePath, supportedSource } from '../../shared/validation';
import { assertDocumentChangeAllowed, assertDocumentWritable, roleRefusal } from './documentAccess';
import { CodeRefusal, fileKind, writesCode, type CodeChange, type CodeGuard } from './codeGuard';
import { markupBesideStyles } from './codeMarkup';

const PAGE_DOCUMENT = /\.(?:astro|md|mdx|mdoc|markdown)$/;
const ENTRY_DOCUMENT = /\.(?:json|md|mdx|mdoc|markdown|yaml|yml|toml|csv|ndjson)$/;
const STYLESHEET = /\.(?:css|scss|sass|less)$/;
const MERGE_CHOICES_MAX = 500;

/**
 * Any change a route makes to a file: a project settings file needs that setting's own permission (only admin ever
 * edits roles), and no change brings code a role without code permission may not write.
 */
export async function assertRoleWrite(role: RoleView, change: CodeChange, guard: CodeGuard): Promise<void> {
  if (role.isAdmin) {
    return;
  }
  if (change.file.startsWith('.stacki/')) {
    assertDocumentWritable(role, change.file);
  }
  await guard.assertAllowed(role, change);
}

/** The Create route: pages and collection entries, which is all the editor's New dialogs make. */
export async function assertCreateAllowed(role: RoleView, file: string, source: string, guard: CodeGuard): Promise<void> {
  if (!writesCode(role)) {
    const page = file.startsWith('src/pages/');
    if (!(page ? PAGE_DOCUMENT : ENTRY_DOCUMENT).test(file)) {
      throw new CodeRefusal(role, file);
    }
    if (!can(role, page ? 'page:create' : 'panel:cms')) {
      throw roleRefusal(role);
    }
  }
  await guard.assertAllowed(role, { file, before: undefined, after: source });
}

/**
 * The Style panel's save, which sends a whole file. A stylesheet, or a change to an Astro file's style blocks alone,
 * is what the panel writes; anything else in the file answers to the rules of an edit over the socket.
 */
export async function assertStyleSave(
  role: RoleView,
  change: { readonly file: string; readonly before: string; readonly after: string },
  guard: CodeGuard,
): Promise<void> {
  const { file, before, after } = change;
  if (role.isAdmin || before === after) {
    return;
  }
  if (STYLESHEET.test(file) && /^(?:src|public)\//.test(file)) {
    return;
  }
  if (!file.endsWith('.astro') || (await markupBesideStyles(before)) !== (await markupBesideStyles(after))) {
    assertDocumentChangeAllowed(role, file, before, after);
  }
  await assertRoleWrite(role, change, guard);
}

/**
 * A rename keeps the file's kind: text a role may type into `page.md` would be code in `page.mdx` or `page.astro`.
 * Both request kinds are held to it, because a "folder" rename that names a file renames that file.
 */
export function assertRenameAllowed(role: RoleView, change: { readonly from: string; readonly to: string }): void {
  const pageExtension = (file: string) => /\.(?:astro|mdx?|mdoc|markdown)$/i.exec(file)?.[0] ?? '';
  if (!writesCode(role) && pageExtension(change.from) !== pageExtension(change.to)) {
    throw new CodeRefusal(role, change.to);
  }
}

/**
 * A merge resolution typed by hand replaces a file's text. For a role without code permission it may only reach
 * project files the editor opens, and holds no code that neither side of the conflict held.
 */
export async function assertMergeResolutions(
  role: RoleView,
  choices: unknown,
  sides: { readonly ours: (file: string) => Promise<string | undefined>; readonly theirs: (file: string) => Promise<string | undefined> },
  guard: CodeGuard,
): Promise<void> {
  if (role.isAdmin || choices === undefined) {
    return;
  }
  const entries = Object.entries(record(choices));
  if (entries.length > MERGE_CHOICES_MAX) {
    throw roleRefusal(role);
  }
  for (const [file, choice] of entries) {
    const resolution = parseMergeResolution(choice);
    if (typeof resolution === 'string' || !('kind' in resolution)) {
      continue;
    }
    if (!supportedSource(file)) {
      if (!writesCode(role)) {
        throw new CodeRefusal(role, file);
      }
      continue;
    }
    sourcePath(file);
    // The other side's code is the repository's: a resolution may keep it.
    const theirs = await sides.theirs(file);
    if (theirs !== undefined && fileKind(file) !== 'inert') {
      await guard.retain(file, theirs);
    }
    await assertRoleWrite(role, { file, before: await sides.ours(file), after: resolution.text }, guard);
  }
}
