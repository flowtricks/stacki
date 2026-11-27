// Design mode (experimental, removable: docs/design-mode/REMOVE.md): what the window shows while the mode is on.
//
// Every panel that works on the project's files stays: they edit the sandbox copy. What cannot work on a copy is
// taken out of reach through the app's own "View as" preview (src/lib/currentRole.ts), the mechanism the editor
// already uses to show a role without some features: history and git, publishing, Stacki apps and their
// marketplace, the project's secrets and MCP settings, roles and the command line. Main refuses all of those
// anyway (electron/lib/designMode/designFence.ts); hiding them saves the person a refusal.
import { ACCESS_FEATURES, type AccessFeature, type RoleView } from '../../../shared/properties/projectRoles';
import { actualRole, setViewAs, viewingAs } from '../../lib/currentRole';

export const DESIGN_ROLE_ID = 'design-mode';

/** Features a sandbox copy cannot give: they reach git, the network as the person, or Stacki's own settings. */
const OUT_OF_REACH: ReadonlySet<AccessFeature> = new Set([
  'panel:history',
  'panel:apps',
  'panel:projectSettings',
  'publish',
  'marketplace:view',
  'marketplace:install',
  'marketplace:publish',
  'apps:share',
  'settings:roles',
  'settings:studio',
  'cli:read',
  'cli:config',
  'cli:guides',
  'cli:breakpoints',
  'cli:folders',
  'cli:components',
  'cli:apps',
  'cli:roles',
]);

export function designRole(name: string): RoleView {
  const actual = actualRole();
  const features = new Set(ACCESS_FEATURES.filter((feature) => !OUT_OF_REACH.has(feature)));
  if (features.has('publish')) {
    throw new Error('Assertion failed: designRole: publishing is out of reach');
  }
  return {
    id: DESIGN_ROLE_ID,
    name,
    isAdmin: false,
    features,
    appPermissions: {},
    pinnedApps: [],
    componentRules: actual.componentRules,
    editorOff: new Set(),
  };
}

/** Shows the window as Design mode's role. */
export function applyDesignRole(name: string): void {
  setViewAs(designRole(name));
}

/** Ends the preview, when it is Design mode's own. */
export function clearDesignRole(): void {
  if (viewingAs()?.id === DESIGN_ROLE_ID) {
    setViewAs(undefined);
  }
}
