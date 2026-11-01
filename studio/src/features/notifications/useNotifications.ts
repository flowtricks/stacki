import { useErrorToasts } from '../../../vendor/stacki/src/ui/errorNotices';
import { useCallback } from 'react';
import { useToastStack, type ToastNotice } from '../../../vendor/stacki/src/features/notifications/useToastStack';
import { ActionableNotice, type NoticeDetails } from './notice';

export type StudioNotice = ToastNotice & NoticeDetails;

export function useNotifications() {
  const { notices, push, dismiss } = useToastStack<StudioNotice>();
  useErrorToasts(push, dismiss);
  const report = useCallback(
    (problem: unknown) => {
      const message = problem instanceof Error ? problem.message : String(problem);
      if (message) {
        push({
          id: crypto.randomUUID(),
          message,
          kind: problem instanceof Error && !(problem instanceof ActionableNotice) ? 'error' : 'info',
          ...(problem instanceof ActionableNotice ? problem.details : {}),
        });
      }
    },
    [push],
  );
  const performAction = (notice: StudioNotice) => {
    if (notice.action) {
      dismiss(notice.id);
      void Promise.resolve().then(notice.action.run).catch(report);
    }
  };
  return { notices, performAction, report, dismiss };
}
