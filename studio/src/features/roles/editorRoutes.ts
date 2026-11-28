// What a role's editing options add to the Studio server's route gate
// (serverAccess.ts). Most of it is already there: `can()` withholds the features
// the options take away, and the gate asks `can()`. Two things a feature cannot
// say are checked here: a read only role writes nothing at all, and a limited role
// may not write page markup through a route that takes a whole file from the browser.
import { CLIENT_ROLE_ID, DEFAULT_PROJECT_ROLES, roleViewOf, type RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { EDITOR_PARTS, effectiveEditorOff, limitsEditing, readOnlyEditor } from '../../../vendor/stacki/shared/properties/projectRoles';
import { record, sourcePath, string } from '../../shared/validation';
import { roleRefusal } from './documentAccess';

/** POST routes that change nothing in the project, which a read only role keeps. Each is a POST only to carry what to read. */
const READ_ONLY_POSTS: ReadonlySet<string> = new Set([
  '/studio/api/file-stamps',
  '/studio/api/apps/marketplace',
  '/studio/api/apps/updates',
  '/studio/api/apps/visibility',
  '/studio/api/apps/settings/read',
  '/studio/api/apps/storage/get',
  '/studio/api/apps/storage/keys',
  '/studio/api/apps/person',
  '/studio/api/apps/people',
  '/studio/api/apps/host',
]);

const STYLESHEET = /\.(?:css|scss|sass|less)$/i;

/**
 * The role a hosted person gets when `.stacki/roles.json` cannot be read but was
 * using editing options: the built-in Client with everything on the page off. For
 * any other unreadable file the plain Client role stands, as before: undefined.
 */
export function lockedClientRole(source: string): RoleView | undefined {
  if (!source.includes('"editorOff"')) {
    return undefined;
  }
  return { ...roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID), editorOff: effectiveEditorOff(EDITOR_PARTS) };
}

/** Whether `assertEditorRequest` needs this request's body. */
export function routeReadsBody(role: RoleView, pathname: string): boolean {
  return limitsEditing(role.editorOff) && (pathname === '/studio/api/create' || pathname === '/studio/api/source');
}

/** Throws when the editing options of `role` refuse this write request. `body` is read only where `routeReadsBody` says. */
export function assertEditorRequest(role: RoleView, pathname: string, body: string): void {
  if (readOnlyEditor(role.editorOff)) {
    if (!READ_ONLY_POSTS.has(pathname)) {
      throw roleRefusal(role);
    }
    return;
  }
  if (!routeReadsBody(role, pathname)) {
    return;
  }
  const input = record(JSON.parse(body));
  const file = sourcePath(input['file']);
  if (pathname === '/studio/api/create') {
    // The Create route also makes collection entries; a page's markup from the browser is nothing the options could check.
    if (file.startsWith('src/pages/') || file.endsWith('.astro')) {
      throw roleRefusal(role);
    }
    return;
  }
  // The Style panel's save: a stylesheet, or only the style blocks of an Astro file.
  if (!STYLESHEET.test(file) && !onlyStylesDiffer(string(input['base']), string(input['source']))) {
    throw roleRefusal(role);
  }
}

function onlyStylesDiffer(before: string, after: string): boolean {
  return withoutStyles(before) === withoutStyles(after);
}

// The page with each style block's text taken out. One pass: a single pattern for a whole block looks for the closing
// tag afresh at every opening one, which takes minutes on a hostile page.
function withoutStyles(source: string): string {
  const opening = /<style\b[^<>]*>/gi;
  const closing = /<\/style\s*>/gi;
  let kept = '';
  let from = 0;
  for (let open = opening.exec(source); open !== null; open = opening.exec(source)) {
    closing.lastIndex = opening.lastIndex;
    const close = closing.exec(source);
    if (close === null) {
      break;
    }
    kept += source.slice(from, opening.lastIndex);
    from = close.index;
    opening.lastIndex = closing.lastIndex;
  }
  return kept + source.slice(from);
}
