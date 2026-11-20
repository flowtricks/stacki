// The Sidebar icon order row of Editor settings: the sidebar's icons are dragged into the person's own order
// (railOrder.ts), and this puts them back. It reads the same store as the rail, so the button enables the
// moment an icon is dragged, even with this dialog open, and the rail reorders the moment it is pressed.
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
    <SettingsRow label={translate('rail.settingsOrder.label')} description={translate('rail.settingsOrder.description')}>
      <button
        type="button"
        className="rail-order-reset"
        disabled={isDefault}
        onClick={() => {
          resetRailOrder();
          setAnnouncement(translate('rail.settingsOrder.done'));
        }}
      >
        {isDefault ? translate('rail.settingsOrder.alreadyDefault') : translate('rail.settingsOrder.reset')}
      </button>
      <span className="rail-order-live" role="status" aria-live="polite">
        {announcement}
      </span>
    </SettingsRow>
  );
}
