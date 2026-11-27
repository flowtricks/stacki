// The pure side of a role's Editing view (RoleEditing.tsx): each editing option as a
// row, whether it is on, and, when the role's permissions already settle it, why it
// cannot be switched. The card's summary reads the same rows, so the two agree.
//
// Options only ever take away. An option the role's permissions give nothing to take
// shows off and cannot be switched, with the permission to turn on first. One that
// was switched off stays switchable, so no state is a dead end.
import { assert } from '../../../shared/core/assert';
import { EDITOR_PARTS, readOnlyEditor, type EditorPart } from '../../../shared/properties/projectRoles';
import { ADMIN_ROLE_ID, roleView, type ProjectRole } from '../../../shared/properties/projectRoles';

/** Why an option cannot be switched. */
export type EditingBlock = 'needsRightPanel' | 'needsNavigator' | 'needsImagePanel' | 'needsPageEditing';

export interface EditingRow {
  readonly part: EditorPart;
  readonly checked: boolean;
  readonly blocked: EditingBlock | undefined;
}

export function editingRows(role: ProjectRole): readonly EditingRow[] {
  assert(role.id !== ADMIN_ROLE_ID, 'Admin has every editing option');
  const effective = roleView(role).editorOff;
  const rows = EDITOR_PARTS.map((part): EditingRow => {
    if (role.editorOff.includes(part)) {
      return { part, checked: false, blocked: undefined };
    }
    const blocked = blockOf(role, part, effective);
    return { part, checked: blocked === undefined && !effective.has(part), blocked };
  });
  assert(rows.length === EDITOR_PARTS.length, 'Every option has a row');
  return rows;
}

function blockOf(role: ProjectRole, part: EditorPart, effective: ReadonlySet<EditorPart>): EditingBlock | undefined {
  const rightPanel = role.access.includes('panel:style') || role.access.includes('panel:settings');
  switch (part) {
    case 'sidePanel':
      return rightPanel ? undefined : 'needsRightPanel';
    case 'navigator':
      return role.access.includes('panel:navigator') ? undefined : 'needsNavigator';
    case 'images':
      return rightPanel ? undefined : 'needsImagePanel';
    case 'elements':
      return readOnlyEditor(effective) ? 'needsPageEditing' : undefined;
    case 'canvasBar':
    case 'drag':
    case 'text':
      return undefined;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

/** What the card's Editing row says: read only, or how many options are on. */
export function editingSummary(role: ProjectRole): { readonly kind: 'readOnly' } | { readonly kind: 'count'; readonly on: number; readonly total: number } {
  if (readOnlyEditor(roleView(role).editorOff)) {
    return { kind: 'readOnly' };
  }
  const rows = editingRows(role);
  return { kind: 'count', on: rows.filter((row) => row.checked).length, total: rows.length };
}
