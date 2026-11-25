// What each list of components shows the active role. The rule itself is `componentOffer`
// (shared/properties/componentAccess.ts); this file only names a scanned component's file and follows the
// role store. The Components panel and the layout dropdowns are `browse` surfaces, the insert palette and
// the Tag field are `search` surfaces. Hiding stops adding only: instances already on a page, and copying,
// pasting or duplicating markup that holds one, are untouched because the component is already on the page.
import { useMemo } from 'react';
import { assert } from '../../../shared/core/assert';
import { componentAddable, componentOffers, componentRuleFile, offeredComponents, type ComponentSurface } from '../../../shared/properties/componentAccess';
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

/** The components `surface` lists for `role`, in their order. */
export function componentsOfferedTo<T extends InsertableComponent>(role: RoleView, surface: ComponentSurface, components: readonly T[]): readonly T[] {
  const kept = offeredComponents(role, surface, components, componentRuleFile);
  assert(kept.length <= components.length, 'A role never gains components');
  return kept;
}

/** Whether `component` is in `role`'s lists but left out of its searches: an admin's own hidden component, which a row dims. */
export function searchHidden(role: RoleView, component: InsertableComponent): boolean {
  return componentOffers(role)(componentRuleFile(component)) === 'browse-only';
}

/** Whether `role` may add `component` at all: the guard behind every insert path, so one it is not offered is refused wherever it was asked for. */
export function canAddComponent(role: RoleView, component: InsertableComponent): boolean {
  return componentAddable(role, componentRuleFile(component));
}

/** Refuses adding a component withheld from the role. Desktop's guard behind every insert path; Studio's server holds the same rule (studio/src/features/roles/componentAccess.ts). */
export function assertCanAddComponent(role: RoleView, component: InsertableComponent): void {
  if (!canAddComponent(role, component)) {
    throw new DescribedError(described('roles.error.componentHidden', { role: role.name, name: component.name }));
  }
}

/** What `surface` lists for the active role (an admin's "View as" included), kept stable while nothing changes. */
export function useOfferedComponents<T extends InsertableComponent>(surface: ComponentSurface, components: readonly T[] | undefined): readonly T[] {
  const role = useCurrentRole();
  return useMemo(() => componentsOfferedTo(role, surface, components ?? NONE), [role, surface, components]);
}
