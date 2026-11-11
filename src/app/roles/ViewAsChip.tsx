// The title bar's reminder that an admin is previewing another role ("View as",
// Settings → Roles), and the way back: the UI shows that role until it ends.
import { CloseIcon } from '../../ui/Icons';
import { setViewAs } from '../../lib/currentRole';
import { useActualRole, useCurrentRole } from '../../lib/useCurrentRole';
import './viewAs.css';

export function ViewAsChip() {
  const role = useCurrentRole();
  const actual = useActualRole();
  if (role.id === actual.id) {
    return undefined;
  }
  return (
    <span className="view-as-chip" role="status">
      <span>Viewing as {role.name}</span>
      <button type="button" aria-label="Stop viewing as another role" title="Back to Admin" onClick={() => setViewAs(undefined)}>
        <CloseIcon size={10} />
      </button>
    </span>
  );
}
