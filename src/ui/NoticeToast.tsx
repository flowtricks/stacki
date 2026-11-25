// A one-time notice or a broken rule, said once as a toast instead of a line appended to a panel (owner rule: nothing appends
// text into the UI, because a row that appears moves everything below it). A field takes the error tint itself (`.is-invalid`,
// a background fill); this reports the words, once per change of message.
import { useEffect } from 'react';
import { reportActionToast } from './errorNotices';
import type { ToastKind } from './toastNotice';

export function NoticeToast({ message, kind }: { readonly message: string | undefined; readonly kind: ToastKind }) {
  useEffect(() => {
    if (message !== undefined && message !== '') {
      reportActionToast(message, kind, []);
    }
  }, [message, kind]);
  return undefined;
}
