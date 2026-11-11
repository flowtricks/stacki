// The small "via <App>" beside a picker's button while a running app answers it
// in Stacki's place (src/ui/appOverrideSlot.ts). It says who will answer and how
// to get Stacki's own picker instead, so an app never takes a button over silently.
import type { AppOverridePoint } from '../../shared/properties/appsRpc';
import { useAppOverrideOwner } from './appOverrideSlot';
import './overrideNote.css';

/** The hint a picker's button carries while an app answers it. */
export function overrideTitle(owner: string): string {
  return `Opens in ${owner}. Alt-click for Stacki's own picker.`;
}

export function OverrideNote({ point }: { readonly point: AppOverridePoint }) {
  const owner = useAppOverrideOwner(point);
  if (owner === undefined) {
    return undefined;
  }
  return (
    <span className="override-note" title={overrideTitle(owner)}>
      via {owner}
    </span>
  );
}
