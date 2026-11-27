// The browser's own check of a limited role's edits, before they are applied or
// sent. It keeps a refused edit off the canvas; only the server's check holds
// (documentAccess.ts). It reads what the browser has without waiting: it does not
// follow components, so where only the server can tell, it lets the edit through.
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { limitsEditing, readOnlyEditor } from '../../../vendor/stacki/shared/properties/projectRoles';
import { frontmatterRange } from '../source/frontmatter';
import type { TreeAction } from '../source/source';
import { studioTranslate } from '../../shared/studioTranslate';
import { editorActionRefusal } from './editorActions';
import { checkEditorContent, type SourceRange } from './editorContent';

/** The person's sentence for something their role may not do. */
function refusal(role: RoleView): Error {
  return new Error(studioTranslate('studio.collab.roleCannot', { role: role.name }));
}

export function clientActionRefusal(role: RoleView, file: string, source: string, action: TreeAction): Error | undefined {
  return editorActionRefusal(role, file, source, action) === undefined ? undefined : refusal(role);
}

/** Throws when a limited role's text edit would be refused whatever the project's components turn out to be. */
export function assertClientEditorEdit(role: RoleView, file: string, before: string, after: string): void {
  if (!limitsEditing(role.editorOff) || before === after) {
    return;
  }
  if (readOnlyEditor(role.editorOff)) {
    throw refusal(role);
  }
  // With the panel on, only the server can tell a text prop from a setting, so it alone decides.
  if (!file.endsWith('.astro') || !role.editorOff.has('sidePanel')) {
    return;
  }
  const checked = checkEditorContent(before, after, {
    off: role.editorOff,
    textProp: () => 'text',
    literals: { before: frontmatterStrings(before), after: frontmatterStrings(after) },
  });
  if (!checked.ok) {
    throw refusal(role);
  }
}

// Every quoted string of the frontmatter: which of them the page prints is the server's to say.
function frontmatterStrings(source: string): readonly SourceRange[] {
  const range = frontmatterRange(source);
  if (range === undefined) {
    return [];
  }
  const code = source.slice(range.start, range.end);
  return [...code.matchAll(/(?<!\bfrom\s+)(?<!\bimport\s+)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g)].map((match) => ({
    start: range.start + match.index,
    end: range.start + match.index + match[0].length,
  }));
}
