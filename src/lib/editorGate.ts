// Desktop's preview of a role's editing options (shared/properties/projectRoles.ts):
// whether the active role has switched a page gesture off. Desktop previews roles
// with "View as" and never enforces them (docs/contracts.md, "Project roles"), so
// this only has to keep the preview true to what Studio will allow.
import { assert } from '../../shared/core/assert';
import type { EditorPart } from '../../shared/properties/projectRoles';
import { currentRole } from './currentRole';

/** The active role's name when it has `part` switched off, else undefined. */
export function editingOffFor(part: EditorPart): string | undefined {
  const role = currentRole();
  assert(!role.isAdmin || role.editorOff.size === 0, 'Admin has every editing option');
  return role.editorOff.has(part) ? role.name : undefined;
}
