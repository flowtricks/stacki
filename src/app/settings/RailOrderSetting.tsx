// The Sidebar icon order row of Editor settings: the sidebar's icons are dragged into the person's own order
// (railOrder.ts), and this puts them back. It reads the same store as the rail, so the row appears the
// moment an icon is dragged, even with this dialog open, and goes away the moment the order is the default again.
// While the order is the default there is nothing to reset, so the row is not rendered at all.
import { useState } from 'react';
import { resetRailOrder, useRailOrderIsDefault } from '../railOrderStore';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { SettingsRow } from './SettingsLayout';
import './railOrderSetting.css';

export function RailOrderSetting() {
  const translate = useTranslate();
  const isDefault = useRailOrderIsDefault();
  const [announcement, setAnnouncement] = useState('');
  return (
    <>
      {isDefault ? undefined : (
        <SettingsRow label={translate('rail.settingsOrder.label')} description={translate('rail.settingsOrder.description')}>
          <button
            type="button"
            className="rail-order-reset"
            onClick={() => {
              resetRailOrder();
              setAnnouncement(translate('rail.settingsOrder.done'));
            }}
          >
            {translate('rail.settingsOrder.reset')}
          </button>
        </SettingsRow>
      )}
      {/* Outside the row so the announcement survives the row leaving after a reset. */}
      <span className="rail-order-live" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}
