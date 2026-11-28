// The pure side of the Permissions view's Right panel and Canvas controls sections
// (RoleRightPanel.tsx, RoleCanvasControls.tsx): each row, whether it is on, and,
// when the role's permissions already settle it, why it cannot be switched. The
// card's summary reads the same rows, so the two agree.
//
// Canvas controls only ever take away. A control the role's permissions give
// nothing to take shows off and cannot be switched, with what to turn on first.
// One that was switched off stays switchable, so no state is a dead end.
import { assert } from '../../../shared/core/assert';
import {
  ADMIN_ROLE_ID,
  CANVAS_PARTS,
  RIGHT_PANEL_FEATURES,
  readOnlyEditor,
  roleView,
  type CanvasPart,
  type EditorPart,
  type ProjectRole,
  type RightPanelFeature,
} from '../../../shared/properties/projectRoles';

/** Why a canvas control cannot be switched. */
export type CanvasBlock = 'needsImagePanel' | 'needsPageEditing';

export interface CanvasRow {
  readonly part: CanvasPart;
  readonly checked: boolean;
  readonly blocked: CanvasBlock | undefined;
}

export function canvasRows(role: ProjectRole): readonly CanvasRow[] {
  assert(role.id !== ADMIN_ROLE_ID, 'Admin has every canvas control');
  const effective = roleView(role).editorOff;
  const rows = CANVAS_PARTS.map((part): CanvasRow => {
    if (role.editorOff.includes(part)) {
      return { part, checked: false, blocked: undefined };
    }
    const blocked = blockOf(role, part, effective);
    return { part, checked: blocked === undefined && !effective.has(part), blocked };
  });
  assert(rows.length === CANVAS_PARTS.length, 'Every control has a row');
  return rows;
}

function blockOf(role: ProjectRole, part: CanvasPart, effective: ReadonlySet<EditorPart>): CanvasBlock | undefined {
  switch (part) {
    case 'images':
      // Changing a picture was never open to a role with neither right panel tab.
      return RIGHT_PANEL_FEATURES.some((feature) => role.access.includes(feature)) ? undefined : 'needsImagePanel';
    case 'insert':
    case 'delete':
    case 'duplicate':
    case 'paste':
      return readOnlyEditor(effective) ? 'needsPageEditing' : undefined;
    case 'text':
    case 'drag':
    case 'copy':
    case 'canvasBar':
      return undefined;
    default: {
      const exhaustive: never = part;
      return exhaustive;
    }
  }
}

export interface RightPanelView {
  /** Whether the role sees the panel at all: the group switch. */
  readonly shown: boolean;
  readonly rows: readonly { readonly feature: RightPanelFeature; readonly checked: boolean }[];
}

/** A tab reads on while the role has it and the panel is not switched off. */
export function rightPanelView(role: ProjectRole): RightPanelView {
  assert(role.id !== ADMIN_ROLE_ID, 'Admin has the whole right panel');
  const hidden = role.editorOff.includes('sidePanel');
  const rows = RIGHT_PANEL_FEATURES.map((feature) => ({ feature, checked: !hidden && role.access.includes(feature) }));
  const shown = rows.some((row) => row.checked);
  assert(!hidden || !shown, 'A panel switched off shows no tab');
  return { shown, rows };
}

/** Whether the role can change nothing on the page: what the card says in place of its counts. */
export function readOnlyRole(role: ProjectRole): boolean {
  return readOnlyEditor(roleView(role).editorOff);
}
