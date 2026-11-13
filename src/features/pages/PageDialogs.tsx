import Popup from '../../ui/Popup';
import React, { useState } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import Dropdown from '../../ui/Dropdown';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function NewPageModal({
  layouts,
  onClose,
  onCreate,
}: {
  readonly layouts: readonly ScanComponent[];
  readonly onClose: () => void;
  readonly onCreate: (name: string, layout: string | undefined) => void;
}) {
  const translate = useTranslate();
  const [name, setName] = useState('');
  const [layout, setLayout] = useState(layouts.at(0)?.name ?? '');
  const submit = (): void => {
    const clean = name.trim();
    if (clean) {
      onCreate(clean, layout || undefined);
    }
  };
  return (
    <Popup className="modal" onClose={onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('pages.new.title')}</div>
          <div className="modal-body">
            <div>
              <label>{translate('pages.new.nameLabel')}</label>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submit();
                  }
                }}
                placeholder={translate('pages.new.namePlaceholder')}
              />
            </div>
            <div>
              <label>{translate('pages.layout')}</label>
              <Dropdown
                value={layout}
                options={[{ value: '', label: translate('pages.new.noLayout'), dim: true }, ...layouts.map((item) => ({ value: item.name, label: item.name }))]}
                onChange={setLayout}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button onClick={close}>{translate('ui.cancel')}</button>
            <button className="primary" disabled={!name.trim()} onClick={submit}>
              {translate('pages.new.create')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
