import { centralIcon } from '../../../vendor/stacki/src/ui/central/CentralIcon';
import { person as centralPerson, roles as centralRoles, styles as centralStyles } from '../../../vendor/stacki/src/ui/central/centralGeometry';
import { ADMIN_ROLE_ID, CLIENT_ROLE_ID } from '../../../vendor/stacki/shared/properties/projectRoles';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { actualRole } from '../../../vendor/stacki/src/lib/currentRole';
import { setEditorRole, studioRoles } from './roleStore';
import { useStudioRole } from './useEditorRole';
import './roles.css';

const AdminIcon = centralIcon(centralStyles);
const ClientIcon = centralIcon(centralPerson);
const GroupIcon = centralIcon(centralRoles);

function RoleSymbol({ id }: { readonly id: string }) {
  if (id === ADMIN_ROLE_ID) {
    return <AdminIcon className="role-menu-symbol" />;
  }
  const Icon = id === CLIENT_ROLE_ID ? ClientIcon : GroupIcon;
  return <Icon className="role-menu-symbol" />;
}

// "View as": an admin previews another role's UI without changing the project's
// roles or what the server allows. Anyone else sees the role they have.
export function RoleMenu({ saved, close }: { readonly saved: boolean; readonly close: () => void }) {
  const translate = useTranslate();
  const role = useStudioRole();
  if (!actualRole().isAdmin) {
    return (
      <div className="role-menu" role="group" aria-label={translate('roles.menu.yours')}>
        <div className="role-menu-heading">{translate('roles.menu.yours')}</div>
        <div className="role-menu-option" aria-current="true">
          <RoleSymbol id={role.id} />
          <strong>{role.name}</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="role-menu" role="group" aria-label={translate('roles.menu.viewAs')}>
      <div className="role-menu-heading">{translate('roles.menu.viewAs')}</div>
      {studioRoles().roles.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={role.id === item.id}
          className="role-menu-option"
          disabled={!saved}
          title={saved ? undefined : translate('roles.menu.waitForSave')}
          onClick={() => {
            setEditorRole(item.id);
            close();
          }}
        >
          <RoleSymbol id={item.id} />
          <strong>{item.name}</strong>
          <span className="role-menu-check" aria-hidden="true">
            {role.id === item.id ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
