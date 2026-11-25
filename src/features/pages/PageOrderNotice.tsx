import { ErrorToast } from '../../ui/ErrorToast';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { PageOrderState } from './pageOrderPersistence';

export function PageOrderNotice({ state, reload }: { readonly state: PageOrderState; readonly reload: () => void }) {
  const translate = useTranslate();
  if (state.kind !== 'failed') {
    return undefined;
  }
  return <ErrorToast message={state.message} recovery={[{ label: translate('pages.order.reload'), run: reload }]} />;
}
