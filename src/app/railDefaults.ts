// The rail's default order (railOrder.ts): what a person who has not arranged it sees, and what "reset" returns to.
// Kept apart from LeftRail.tsx so Settings can compare and reset without importing the rail. The ids are the
// rail's panel ids plus the project's Settings and the AI button; LeftRail.tsx draws only the ones its role has.
import type { RailOrder } from './railOrder';

export const DEFAULT_RAIL_ORDER: RailOrder = {
  top: ['pages', 'navigator', 'assets', 'cms', 'variables', 'history', 'properties', 'components', 'apps', 'code'],
  bottom: ['selectors', 'audits', 'projectSettings', 'ai'],
};
