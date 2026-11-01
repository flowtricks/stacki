import Popup from '../../../vendor/stacki/src/ui/Popup';
import { useState } from 'react';

interface Props {
  readonly create: (name: string, duplicate: boolean) => Promise<void>;
  readonly collection: boolean;
  readonly busy: boolean;
  readonly failure: string;
  readonly close: () => void;
}
export function CreateFileDialog({ create, collection, busy, close }: Props) {
  const [name, setName] = useState('');
  return (
    <Popup className="modal studio-file-dialog" label={collection ? 'New item' : 'New Page'} dismissible={!busy} onClose={close}>
      {({ close }) => (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create(name.trim(), false);
            }}
          >
            <div className="modal-header">{collection ? 'New item' : 'New Page'}</div>
            <div className="modal-body">
              <label htmlFor="studio-file-name">{collection ? 'Item path' : 'Page name (e.g. “about” or “blog/post-1”)'}</label>
              <input
                id="studio-file-name"
                autoFocus
                required
                maxLength={512}
                aria-label="New file name"
                placeholder={collection ? 'posts/hello.md' : 'about'}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <div className="modal-footer">
              <button type="button" disabled={busy} onClick={close}>
                Cancel
              </button>
              <button type="button" disabled={busy || !name.trim()} onClick={() => void create(name.trim(), true)}>
                Duplicate current
              </button>
              <button className="primary" disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : collection ? 'Create item' : 'Create Page'}
              </button>
            </div>
          </form>
        </>
      )}
    </Popup>
  );
}
