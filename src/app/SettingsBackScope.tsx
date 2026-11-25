// The way back to the Settings list from a rail panel a person moved into Settings (railOrder.ts). Such a panel
// opens from a Settings row in the panel area, in place of the Settings list, so its header carries the chevron
// Settings' own views have ("< Agents"), through PanelBackContext: the panel draws its own header with the chevron
// in it, never a second header above it. Escape outside a field returns too, as it does from a Settings view.
// A panel that lives on the rail (one dragged back out) opens with no chevron.
import { useMemo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { useTranslate } from '../lib/i18n/useTranslate';
import type { PanelHeaderBack } from '../ui/PanelHeader';
import { PanelBackContext } from '../ui/panelBack';
import { DEFAULT_RAIL_ORDER } from './railDefaults';
import { useRailOrder } from './railOrderStore';

export function SettingsBackScope({ tab, onBack, children }: { readonly tab: string; readonly onBack: () => void; readonly children: ReactNode }) {
  assert(tab.length > 0, 'A panel id is never empty');
  const translate = useTranslate();
  const { order } = useRailOrder(DEFAULT_RAIL_ORDER);
  // Settings itself is never inside Settings (railOrder.ts asserts it), so this is only a moved-in panel.
  const inSettings = order.settings.includes(tab);
  const label = translate('settings.back');
  const back = useMemo<PanelHeaderBack>(() => ({ label, onBack }), [label, onBack]);
  if (!inSettings) {
    return children;
  }
  const leaveByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // A field, a menu or a form that handles Escape itself keeps it.
    const target = event.target;
    const typing = target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
    if (event.key === 'Escape' && !event.defaultPrevented && !typing) {
      event.preventDefault();
      onBack();
    }
  };
  return (
    <PanelBackContext.Provider value={back}>
      {/* No box of its own: the panel lays out as it does without the scope. */}
      <div className="settings-back-scope" style={{ display: 'contents' }} onKeyDown={leaveByKey}>
        {children}
      </div>
    </PanelBackContext.Provider>
  );
}
