import Popup from '../../../vendor/stacki/src/ui/Popup';
import { useState } from 'react';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';

interface Props {
  readonly create: (name: string, duplicate: boolean) => Promise<void>;
  readonly collection: boolean;
  readonly busy: boolean;
  readonly failure: string;
  readonly close: () => void;
}
export function CreateFileDialog({ create, collection, busy, close }: Props) {
  const translate = useTranslate();
  const [name, setName] = useState('');
  const title = translate(collection ? 'pages.studio.newItem' : 'pages.new.title');
  return (
    <Popup className="modal studio-file-dialog" label={title} dismissible={!busy} onClose={close}>
      {({ close }) => (
        <>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create(name.trim(), false);
            }}
          >
            <div className="modal-header">{title}</div>
            <div className="modal-body">
              <label htmlFor="studio-file-name">{collection ? translate('pages.studio.itemPath') : translate('pages.new.nameLabel')}</label>
              <input
                id="studio-file-name"
                autoFocus
                required
                maxLength={512}
                aria-label={translate('pages.studio.fileName')}
                placeholder={collection ? 'posts/hello.md' : translate('pages.new.namePlaceholder')}
                value={name}
                disabled={busy}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </div>
            <div className="modal-footer">
              <button type="button" disabled={busy} onClick={close}>
                {translate('ui.cancel')}
              </button>
              <button type="button" disabled={busy || !name.trim()} onClick={() => void create(name.trim(), true)}>
                {translate('pages.studio.duplicate')}
              </button>
              <button className="primary" disabled={busy || !name.trim()}>
                {busy ? translate('pages.studio.creating') : collection ? translate('pages.studio.createItem') : translate('pages.new.create')}
              </button>
            </div>
          </form>
        </>
      )}
    </Popup>
  );
}
