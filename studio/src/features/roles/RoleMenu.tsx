import { ADMIN_ROLE_ID, CLIENT_ROLE_ID } from '../../../vendor/stacki/shared/properties/projectRoles';
import { actualRole } from '../../../vendor/stacki/src/lib/currentRole';
import { setEditorRole, studioRoles } from './roleStore';
import { useStudioRole } from './useEditorRole';
import './roles.css';

// Phosphor Icons, regular paint-brush, user-circle and users (MIT; vendor/phosphor/LICENSE).
const roleIcons = {
  admin:
    'M232,32a8,8,0,0,0-8-8c-44.08,0-89.31,49.71-114.43,82.63A60,60,0,0,0,32,164c0,30.88-19.54,44.73-20.47,45.37A8,8,0,0,0,16,224H92a60,60,0,0,0,57.37-77.57C182.3,121.31,232,76.08,232,32ZM92,208H34.63C41.38,198.41,48,183.92,48,164a44,44,0,1,1,44,44Zm32.42-94.45q5.14-6.66,10.09-12.55A76.23,76.23,0,0,1,155,121.49q-5.9,4.94-12.55,10.09A60.54,60.54,0,0,0,124.42,113.55Zm42.7-2.68a92.57,92.57,0,0,0-22-22c31.78-34.53,55.75-45,69.9-47.91C212.17,55.12,201.65,79.09,167.12,110.87Z',
  client:
    'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM74.08,197.5a64,64,0,0,1,107.84,0,87.83,87.83,0,0,1-107.84,0ZM96,120a32,32,0,1,1,32,32A32,32,0,0,1,96,120Zm97.76,66.41a79.66,79.66,0,0,0-36.06-28.75,48,48,0,1,0-59.4,0,79.66,79.66,0,0,0-36.06,28.75,88,88,0,1,1,131.52,0Z',
  custom:
    'M117.25,157.92a60,60,0,1,0-66.5,0A95.83,95.83,0,0,0,3.53,195.63a8,8,0,1,0,13.4,8.74,80,80,0,0,1,134.14,0,8,8,0,0,0,13.4-8.74A95.83,95.83,0,0,0,117.25,157.92ZM40,108a44,44,0,1,1,44,44A44.05,44.05,0,0,1,40,108Zm210.14,98.7a8,8,0,0,1-11.07-2.33A79.83,79.83,0,0,0,172,168a8,8,0,0,1,0-16,44,44,0,1,0-16.34-84.87,8,8,0,1,1-5.94-14.85,60,60,0,0,1,55.53,105.64,95.83,95.83,0,0,1,47.22,37.71A8,8,0,0,1,250.14,206.7Z',
} as const;

function iconOf(id: string): string {
  if (id === ADMIN_ROLE_ID) {
    return roleIcons.admin;
  }
  return id === CLIENT_ROLE_ID ? roleIcons.client : roleIcons.custom;
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
          <svg className="role-menu-symbol" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            <path d={iconOf(role.id)} />
          </svg>
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
          <svg className="role-menu-symbol" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">
            <path d={iconOf(item.id)} />
          </svg>
          <strong>{item.name}</strong>
          <span className="role-menu-check" aria-hidden="true">
            {role.id === item.id ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
