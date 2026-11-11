import { centralIcon } from '../../../vendor/stacki/src/ui/central/CentralIcon';
import { person as centralPerson, roles as centralRoles, styles as centralStyles } from '../../../vendor/stacki/src/ui/central/centralGeometry';
import { ADMIN_ROLE_ID, CLIENT_ROLE_ID } from '../../../vendor/stacki/shared/properties/projectRoles';
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
  const role = useStudioRole();
  if (!actualRole().isAdmin) {
    return (
      <div className="role-menu" role="group" aria-label="Your role">
        <div className="role-menu-heading">Your role</div>
        <div className="role-menu-option" aria-current="true">
          <RoleSymbol id={role.id} />
          <strong>{role.name}</strong>
        </div>
      </div>
    );
  }
  return (
    <div className="role-menu" role="group" aria-label="View as">
      <div className="role-menu-heading">View as</div>
      {studioRoles().roles.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={role.id === item.id}
          className="role-menu-option"
          disabled={!saved}
          title={saved ? undefined : 'Wait for your edits to finish saving'}
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
