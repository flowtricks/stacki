// A role card's apps: one section per installed app, under the Apps group. The
// section's heading shows the app's icon and name and one switch, whether the role
// may use the app (its `app:<id>` grant), so access is one visible step. Under it,
// an app that declares `permissions` in its manifest (shared/properties/appPermissions.ts)
// lists them, each a row with its label, its description and a switch, after an
// "All permissions" row when it has more than one.
//
// A permission switch shows what applies: on only while the role may use the app
// and the value an admin stored (else the manifest's default) is on. While the app
// is off its switches are muted and read off, because the app hears none of them
// (`appPermissionsFor`); their stored values stay, so turning the app on restores
// them. Turning any permission on also turns the app on (rolesEdits.ts). Under "Every
// app" (`app:*`) every app is on and its switch is fixed until Every app goes off.
//
// Stacki enforces only its own access: these values are signals the app reads
// through `stacki.role.get()` and `stacki.role.can()` and must respect itself.
import InfoHint from '../../ui/InfoHint';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { assert } from '../../../shared/core/assert';
import { APP_LIMITS, type AppSummary } from '../../../shared/properties/apps';
import { APP_ACCESS_ALL, can, configuredAppPermission, roleView, type ProjectRole } from '../../../shared/properties/projectRoles';
import { Switch } from '../../ui/Switch';
import { RoleAppIcon, type InstalledApps } from './RoleAppPicker';

export type AppPermissionChange = (appId: string, permissionIds: readonly string[], change: 'grant' | 'withdraw') => void;
export type AppAccessChange = (appId: string, change: 'grant' | 'withdraw') => void;

export function RoleAppPermissions(props: {
  readonly role: ProjectRole;
  readonly installed: InstalledApps;
  readonly editable: boolean;
  readonly change: AppPermissionChange;
  readonly access: AppAccessChange;
}) {
  const { role, installed } = props;
  if (installed.kind === 'loading') {
    return undefined;
  }
  assert(installed.apps.length <= APP_LIMITS.appsMax, 'Role app permissions: the installed list is bounded');
  // The view is the card's own role, which is what the switches edit, so a grant shows at once.
  const view = roleView(role);
  const everyApp = role.access.includes(APP_ACCESS_ALL);
  return (
    <>
      {installed.apps.map((app) => (
        <AppGroup
          key={app.manifest.id}
          app={app}
          role={role}
          usable={can(view, `app:${app.manifest.id}`)}
          scope={everyApp ? 'every-app' : 'this-app'}
          editable={props.editable}
          change={props.change}
          access={props.access}
        />
      ))}
    </>
  );
}

function AppGroup(props: {
  readonly app: AppSummary;
  readonly role: ProjectRole;
  readonly usable: boolean;
  /** `every-app`: the role holds "Every app", which fixes this app's switch on. */
  readonly scope: 'every-app' | 'this-app';
  readonly editable: boolean;
  readonly change: AppPermissionChange;
  readonly access: AppAccessChange;
}) {
  const { app, role, usable } = props;
  const translate = useTranslate();
  const { id: appId, name, permissions } = app.manifest;
  const values = permissions.map((permission) => configuredAppPermission(role.appPermissions, appId, permission));
  assert(values.length === permissions.length, 'Every permission has a value');
  // A switch reads on only while it takes effect.
  const shown = values.map((value) => usable && value);
  const all = shown.every((value) => value);
  // Under Every app with the Apps panel on, the app is on and fixed; without the panel, its switch grants the panel.
  const fixed = props.scope === 'every-app' && usable;
  return (
    <div
      className={`app-role-group app-role-app-group ${usable ? '' : 'is-off'}`}
      aria-label={translate('settings.roles.apps.group', { app: name })}
      role="group"
    >
      <div className="app-role-group-heading">
        <h4 className="app-role-app-heading">
          <RoleAppIcon app={app} />
          <span>{name}</span>
        </h4>
        <span className="app-role-group-all" title={fixed ? translate('settings.roles.apps.everyAppOn') : undefined}>
          <Switch
            label={translate('settings.roles.apps.canUse', { role: role.name, app: name })}
            checked={usable}
            disabled={!props.editable || fixed}
            onToggle={() => props.access(appId, usable ? 'withdraw' : 'grant')}
          />
        </span>
      </div>
      {permissions.length > 1 && (
        <div className="app-role-toggle app-role-app-permission">
          <span className="app-role-app-permission-text">
            <span className="app-role-toggle-label">{translate('settings.roles.apps.all')}</span>
          </span>
          {/* Mixed reads as off: switching it on turns every permission of the app on, and the app with it. */}
          <Switch
            label={translate('settings.roles.apps.allOf', { app: name })}
            checked={all}
            disabled={!props.editable}
            onToggle={() =>
              props.change(
                appId,
                permissions.map((permission) => permission.id),
                all ? 'withdraw' : 'grant',
              )
            }
          />
        </div>
      )}
      {permissions.map((permission, index) => {
        const checked = shown[index] === true;
        return (
          <div key={permission.id} className="app-role-toggle app-role-app-permission">
            <span className="app-role-app-permission-text">
              <span className="app-role-toggle-label">
                {permission.label}
                {/* App-provided (manifest) text, kept whole in the tip and not translated. */}
                {permission.description !== undefined && <InfoHint text={permission.description} />}
              </span>
            </span>
            <Switch
              label={permission.label}
              checked={checked}
              disabled={!props.editable}
              onToggle={() => props.change(appId, [permission.id], checked ? 'withdraw' : 'grant')}
            />
          </div>
        );
      })}
    </div>
  );
}
