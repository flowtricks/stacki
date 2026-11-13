// What a field says when going back to a plain value cleared code that value
// could not hold: the {} toggle (propFieldModel.ts) and a conditional's unlink
// (ConditionalValue.tsx). The clearing write is one undo step, so Undo brings
// the code back; the notice's action restores it too, for a host with no undo
// (a property form).

import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { reportActionToast } from '../../ui/errorNotices';

/** Says the code was cleared, offering `restore` to write it back. */
export function reportCodeCleared(translate: Translator, restore: () => void): void {
  reportActionToast(translate('props.codeCleared.notice'), 'info', [{ label: translate('props.codeCleared.restore'), run: restore }]);
}
