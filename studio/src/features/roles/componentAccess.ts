// The server's half of hidden components (shared/properties/componentAccess.ts): the browser leaves a
// hidden component out of its palette, but only this check holds against a modified client. It refuses
// an `insert` action whose component the role hides, and a text edit that introduces an import of one,
// each as a typed Result so the caller writes nothing. Instances already on the page are untouched:
// a hidden component that is already imported can stay, move, be copied, pasted or duplicated.
//
// Limits, stated: a component is identified by the project file its import resolves to (a relative
// path, `@/`, or a configured import path). An import that resolves to no project file, such as a
// package's, has nothing to hide by and passes.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { componentAddable } from '../../../vendor/stacki/shared/properties/componentAccess';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { resolveImport, type ComponentImport } from '../source/imports';
import type { TreeAction } from '../source/source';

export interface ComponentHiddenError {
  readonly code: 'component-hidden';
  readonly file: string;
  readonly message: string;
}

/** Import specifiers one source may hold before the scan stops: far past any page, so a hostile text cannot stall the room. */
const IMPORT_SCAN_MAX = 2000;

/** Whether `role` may run `action` on `documentFile`. Only an `insert` names a component to add. */
export function checkComponentInsert(
  role: RoleView,
  documentFile: string,
  action: TreeAction,
  configured: readonly ComponentImport[],
): Result<undefined, ComponentHiddenError> {
  assert(documentFile.length > 0, 'An insert targets a document');
  if (role.componentRules.length === 0 || action.kind !== 'insert') {
    return ok(undefined);
  }
  return checkSpecifier(role, documentFile, action.importPath, configured);
}

/** Whether `role` may change `before` into `after`: a hidden component's import may not be newly introduced. */
export function checkComponentImports(
  role: RoleView,
  documentFile: string,
  before: string,
  after: string,
  configured: readonly ComponentImport[],
): Result<undefined, ComponentHiddenError> {
  assert(documentFile.length > 0, 'A change targets a document');
  if (role.componentRules.length === 0 || !documentFile.endsWith('.astro')) {
    return ok(undefined);
  }
  const existing = new Set(importSpecifiers(before));
  for (const specifier of importSpecifiers(after)) {
    if (!existing.has(specifier)) {
      const checked = checkSpecifier(role, documentFile, specifier, configured);
      if (!checked.ok) {
        return checked;
      }
    }
  }
  return ok(undefined);
}

function checkSpecifier(
  role: RoleView,
  documentFile: string,
  specifier: string,
  configured: readonly ComponentImport[],
): Result<undefined, ComponentHiddenError> {
  const file = resolveImport(documentFile, specifier, configured);
  // The shared rule (componentAccess.ts, `componentOffer`): an admin's hidden component is only out of their search, so
  // adding it by hand passes here; every other role is refused.
  if (file === undefined || componentAddable(role, file)) {
    return ok(undefined);
  }
  assert(file.length > 0, 'A refused component has a file');
  return err({ code: 'component-hidden', file, message: `Your role (${role.name}) cannot add ${file}. Ask an admin to show it.` });
}

/** The `.astro` specifiers a source imports, from `import … from '…'` and `import('…')`, bounded. */
export function importSpecifiers(source: string): readonly string[] {
  const found: string[] = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"])([^'"\n]+\.astro)\1/g;
  for (let match = pattern.exec(source); match !== null && found.length < IMPORT_SCAN_MAX; match = pattern.exec(source)) {
    const specifier = match[2];
    if (specifier !== undefined) {
      found.push(specifier);
    }
  }
  assert(found.length <= IMPORT_SCAN_MAX, 'The import scan is bounded');
  return found;
}
