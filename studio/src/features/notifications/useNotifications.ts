import { useErrorToasts } from '../../../vendor/stacki/src/ui/errorNotices';
import { useCallback, useEffect } from 'react';
import { useToastStack, type ToastNotice } from '../../../vendor/stacki/src/features/notifications/useToastStack';
import { ActionableNotice, type NoticeDetails } from './notice';
import { DEMO_NOTICE_EVENT, DEMO_NOTICE_READY_EVENT, parseDemoNotice } from './demoNotice';

export type StudioNotice = ToastNotice & NoticeDetails;

export function useNotifications() {
  const { notices, push, dismiss } = useToastStack<StudioNotice>();
  useErrorToasts(push, dismiss);
  useEffect(() => {
    const receive = (event: Event) => {
      const message = event instanceof CustomEvent ? parseDemoNotice(event.detail) : undefined;
      if (message !== undefined) {
        push({ id: crypto.randomUUID(), message, kind: 'info' });
      }
    };
    window.addEventListener(DEMO_NOTICE_EVENT, receive);
    window.dispatchEvent(new Event(DEMO_NOTICE_READY_EVENT));
    return () => window.removeEventListener(DEMO_NOTICE_EVENT, receive);
  }, [push]);
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
