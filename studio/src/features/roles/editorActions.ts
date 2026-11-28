// Which named document actions a role's editing options allow (shared/properties/projectRoles.ts).
// The room refuses an action by this before it plans it (documentAccess.ts), and the
// browser asks the same before it sends one. Free of Node imports.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { limitsEditing, readOnlyEditor, type EditorPart } from '../../../vendor/stacki/shared/properties/projectRoles';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { frontmatterRange } from '../source/frontmatter';
import { bounds, flatten, parsePage, type TreeAction } from '../source/source';

const NO_REORDER = 'cannot reorder elements in this project.';
const NO_ELEMENTS = 'cannot add, duplicate or delete elements in this project.';
const NO_MARKUP = 'cannot add new markup in this project.';

/** Why `role` may not send `action`, as the end of a sentence about the role, or undefined when it may. */
export function editorActionRefusal(role: RoleView, file: string, source: string, action: TreeAction): string | undefined {
  const off = role.editorOff;
  if (!limitsEditing(off)) {
    return undefined;
  }
  assert(!role.isAdmin, 'Admin has no editing limits');
  if (readOnlyEditor(off)) {
    return 'can only read this project.';
  }
  switch (action.kind) {
    case 'move':
      return off.has('drag') ? NO_REORDER : undefined;
    case 'delete':
    case 'duplicate':
    case 'insert':
      return off.has('elements') ? NO_ELEMENTS : undefined;
    case 'paste':
      if (off.has('elements')) {
        return NO_ELEMENTS;
      }
      // A paste carries its own markup and frontmatter from the browser: under a limit it must be a copy of what the page already holds.
      return copiesThisPage(file, source, action.clipboard) ? undefined : NO_MARKUP;
    case 'insert-content':
      return NO_MARKUP;
    case 'wrap-text':
      return wrapRefusal(off);
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function wrapRefusal(off: ReadonlySet<EditorPart>): string | undefined {
  if (off.has('sidePanel')) {
    return 'cannot change styles or settings in this project.';
  }
  return off.has('elements') || off.has('text') ? NO_ELEMENTS : undefined;
}

function copiesThisPage(file: string, source: string, clipboard: Extract<TreeAction, { kind: 'paste' }>['clipboard']): boolean {
  if (clipboard.file !== file || clipboard.frontmatter !== (frontmatterRange(source)?.value ?? '')) {
    return false;
  }
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    return false;
  }
  return flatten(parsed.model.nodes).some((node) => {
    if (node.start === undefined || node.end === undefined) {
      return false;
    }
    const range = bounds(node);
    return source.slice(range.start, range.end) === clipboard.fragment;
  });
}
