import Popup from '../../ui/Popup';
import React, { useState } from 'react';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import Dropdown from '../../ui/Dropdown';

export function NewPageModal({
  layouts,
  onClose,
  onCreate,
}: {
  readonly layouts: readonly ScanComponent[];
  readonly onClose: () => void;
  readonly onCreate: (name: string, layout: string | undefined) => void;
}) {
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
          <div className="modal-header">New Page</div>
          <div className="modal-body">
            <div>
              <label>Page name (e.g. &quot;about&quot; or &quot;blog/post-1&quot;)</label>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    submit();
                  }
                }}
                placeholder="about"
              />
            </div>
            <div>
              <label>Layout</label>
              <Dropdown
                value={layout}
                options={[{ value: '', label: '(no layout)', dim: true }, ...layouts.map((item) => ({ value: item.name, label: item.name }))]}
                onChange={setLayout}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button onClick={close}>Cancel</button>
            <button className="primary" disabled={!name.trim()} onClick={submit}>
              Create Page
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
