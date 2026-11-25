import type React from 'react';
import { GearIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

// The gear on a page row: opens the Page settings dialog, where renaming now lives with the rest of the page's settings.
export function PageSettingsButton({ open }: { readonly open: () => void }) {
  const translate = useTranslate();
  const label = translate('pages.settings.open');
  const click = (event: React.MouseEvent) => {
    event.stopPropagation();
    open();
  };
  return (
    <button className="row-action settings-action" title={label} aria-label={label} onClick={click}>
      <GearIcon size={12} />
    </button>
  );
}
