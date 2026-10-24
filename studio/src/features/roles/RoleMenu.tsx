import { setEditorRole } from './roleStore';
import { useEditorRole } from './useEditorRole';
import './roles.css';

// Phosphor Icons, regular paint-brush and user-circle (MIT; vendor/phosphor/LICENSE).
const roleIcons = {
  designer:
    'M232,32a8,8,0,0,0-8-8c-44.08,0-89.31,49.71-114.43,82.63A60,60,0,0,0,32,164c0,30.88-19.54,44.73-20.47,45.37A8,8,0,0,0,16,224H92a60,60,0,0,0,57.37-77.57C182.3,121.31,232,76.08,232,32ZM92,208H34.63C41.38,198.41,48,183.92,48,164a44,44,0,1,1,44,44Zm32.42-94.45q5.14-6.66,10.09-12.55A76.23,76.23,0,0,1,155,121.49q-5.9,4.94-12.55,10.09A60.54,60.54,0,0,0,124.42,113.55Zm42.7-2.68a92.57,92.57,0,0,0-22-22c31.78-34.53,55.75-45,69.9-47.91C212.17,55.12,201.65,79.09,167.12,110.87Z',
  client:
    'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24ZM74.08,197.5a64,64,0,0,1,107.84,0,87.83,87.83,0,0,1-107.84,0ZM96,120a32,32,0,1,1,32,32A32,32,0,0,1,96,120Zm97.76,66.41a79.66,79.66,0,0,0-36.06-28.75,48,48,0,1,0-59.4,0,79.66,79.66,0,0,0-36.06,28.75,88,88,0,1,1,131.52,0Z',
} as const;

export function RoleMenu({
  saved,
  close,
}: {
  readonly saved: boolean;
  readonly close: () => void;
}) {
  const role = useEditorRole();
  return (
    <div className="role-menu" role="group" aria-label="Editing role">
      <div className="role-menu-heading">Editing role</div>
      {(['designer', 'client'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={role === value}
          className="role-menu-option"
          disabled={!saved}
          title={saved ? undefined : 'Wait for your edits to finish saving'}
          onClick={() => {
            setEditorRole(value);
            close();
          }}
        >
          <svg
            className="role-menu-symbol"
            viewBox="0 0 256 256"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d={roleIcons[value]} />
          </svg>
          <strong>{value === 'designer' ? 'Developer' : 'Client'}</strong>
          <span className="role-menu-check" aria-hidden="true">
            {role === value ? '✓' : ''}
          </span>
        </button>
      ))}
    </div>
  );
}
