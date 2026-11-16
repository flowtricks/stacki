// What the insert surfaces list for the active role: the project's components minus the ones the role's
// rules hide (shared/properties/componentAccess.ts). The palette's search and grid and the Components
// panel read it, so a hidden component is absent from the results, the counts and the folder pills alike.
// Hiding stops adding only: instances already on a page, and copying, pasting or duplicating markup that
// holds one, are untouched because the component is already on the page.
import { useMemo } from 'react';
import { assert } from '../../../shared/core/assert';
import { componentRuleFile, componentVisible, visibleComponents } from '../../../shared/properties/componentAccess';
import { DescribedError } from '../../../shared/properties/describedError';
import { described } from '../../../shared/properties/i18n/messageRef';
import type { RoleView } from '../../../shared/properties/projectRoles';
import { useCurrentRole } from '../../lib/useCurrentRole';

/** What a component says about where it lives: enough to name its project file. */
export interface InsertableComponent {
  readonly file?: string | undefined;
  readonly folder?: string | undefined;
  readonly name: string;
  readonly isLayout?: boolean | undefined;
  readonly origin?: { readonly kind: string } | undefined;
}

const NONE: readonly never[] = [];

/** The components `role` may add: those no rule hides, in their order. */
export function componentsAddableBy<T extends InsertableComponent>(role: RoleView, components: readonly T[]): readonly T[] {
  const kept = visibleComponents(role.componentRules, components, componentRuleFile);
  assert(kept.length <= components.length, 'A role never gains components');
  return kept;
}

/** Whether `role` may add `component`: the guard behind every insert path, so a hidden one is refused wherever it was asked for. */
export function canAddComponent(role: RoleView, component: InsertableComponent): boolean {
  const file = componentRuleFile(component);
  return file === undefined || componentVisible(role.componentRules, file);
}

/** Refuses adding a component the role hides. Desktop's guard behind every insert path; Studio's server holds the same rule (studio/src/features/roles/componentAccess.ts). */
export function assertCanAddComponent(role: RoleView, component: InsertableComponent): void {
  if (!canAddComponent(role, component)) {
    throw new DescribedError(described('roles.error.componentHidden', { role: role.name, name: component.name }));
  }
}

/** The components the active role (an admin's "View as" included) may add, kept stable while nothing changes. */
export function useAddableComponents<T extends InsertableComponent>(components: readonly T[] | undefined): readonly T[] {
  const role = useCurrentRole();
  const rules = role.componentRules;
  return useMemo(() => componentsAddableBy({ ...role, componentRules: rules }, components ?? NONE), [components, role, rules]);
}
