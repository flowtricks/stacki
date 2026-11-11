// What a field says when going back to a plain value cleared code that value
// could not hold: the {} toggle (propFieldModel.ts) and a conditional's unlink
// (ConditionalValue.tsx). The clearing write is one undo step, so Undo brings
// the code back; the notice's action restores it too, for a host with no undo
// (a property form).

import { reportActionToast } from '../../ui/errorNotices';

export const CODE_CLEARED_NOTICE = 'Code cleared. Undo to restore.';

/** Says the code was cleared, offering `restore` to write it back. */
export function reportCodeCleared(restore: () => void): void {
  reportActionToast(CODE_CLEARED_NOTICE, 'info', [{ label: 'Restore code', run: restore }]);
}
