import { useCallback, useState } from 'react';
import { TOAST_LIMIT, type ToastNotice } from '../../ui/toastNotice';
export { TOAST_LIMIT, type ToastNotice, type ToastKind } from '../../ui/toastNotice';

// Keep the newest notices visible and bound both mounted cards and their timers.
export function useToastStack<Notice extends ToastNotice>() {
  const [notices, setNotices] = useState<readonly Notice[]>([]);
  const push = useCallback((notice: Notice) => {
    setNotices((current) => [notice, ...current.filter((item) => item.message !== notice.message)].slice(0, TOAST_LIMIT));
  }, []);
  const dismiss = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  return { notices, push, dismiss };
}
