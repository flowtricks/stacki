import { ToastStack } from '../../../vendor/stacki/src/features/notifications/ToastStack';
import { Avatar } from '../auth/Avatar';
import type { StudioNotice } from './useNotifications';
import './toast.css';

export function Toast({
  notices,
  dismiss,
  performAction,
}: {
  readonly notices: readonly StudioNotice[];
  readonly dismiss: (id: string) => void;
  readonly performAction: (notice: StudioNotice) => void;
}) {
  return (
    <ToastStack
      notices={notices}
      dismiss={dismiss}
      className="studio-toast"
      adornment={(notice) =>
        notice.person ? (
          <span className="studio-toast-avatar" aria-label={notice.person.name}>
            <Avatar {...notice.person} />
          </span>
        ) : undefined
      }
      action={(notice) =>
        notice.action ? (
          <button type="button" className="studio-toast-action" onClick={() => performAction(notice)}>
            {notice.action.label}
          </button>
        ) : undefined
      }
    />
  );
}
