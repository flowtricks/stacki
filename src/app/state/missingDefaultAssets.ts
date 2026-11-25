// An insert that went without a default's file says which: the instance is there, the file is not.
import { reportActionToast } from '../../ui/errorNotices';
import type { Translator } from '../../lib/i18n/localeContext';

export function sayMissingAssets(missing: readonly string[], translate: Translator): void {
  const [file] = missing;
  if (file !== undefined) {
    reportActionToast(translate('componentProps.defaults.insertedWithoutAsset', { file }), 'warning', []);
  }
}
