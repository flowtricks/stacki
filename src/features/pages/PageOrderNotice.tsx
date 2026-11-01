import { ErrorToast } from '../../ui/ErrorToast';
import type { PageOrderState } from './pageOrderPersistence';

export function PageOrderNotice({ state, reload }: { readonly state: PageOrderState; readonly reload: () => void }) {
  if (state.kind !== 'failed') {
    return undefined;
  }
  return <ErrorToast message={state.message} recovery={[{ label: 'Reload page order', run: reload }]} />;
}
