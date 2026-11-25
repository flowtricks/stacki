// The end of an item's fields: delete it, or duplicate it, as a CMS's own item
// page offers. A duplicate opens as a new item holding the source's values
// (RemotePendingItem.tsx): nothing is written until it is created.
import { useState } from 'react';
import { CopyIcon, TrashIcon } from '../../ui/Icons';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { DescribedTranslator, Translator } from '../../lib/i18n/localeContext';
import { ErrorToast } from '../../ui/ErrorToast';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { isAstroContent } from '../../../shared/properties/astroContent';
import type { RemoteDocument } from '../../../shared/properties/cmsRemote';
import { deleteRemoteDocuments } from '../../ipc/remoteSource';
import type { RemoteCmsSelection } from './remoteCmsShared';

export function RemoteItemActions(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly document: RemoteDocument;
  /** The collection changed: its list reads again. */
  readonly onChanged: () => void;
  /** The item is gone: back to its collection. */
  readonly onRemoved: () => void;
  /** Opens a copy of this item, to be created or cancelled. */
  readonly onDuplicate: (document: RemoteDocument) => void;
}) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const failure = await deleteItem(props, translate, translateDescribed);
    setBusy(false);
    setError(failure);
    props.onChanged();
  };
  return (
    <div className="remote-cms-item-actions">
      {error && <ErrorToast message={error} />}
      <button type="button" className="danger" disabled={busy} onClick={() => void remove()}>
        <TrashIcon size={12} /> {translate('cmsRemote.delete.action')}
      </button>
      <button type="button" disabled={busy} onClick={() => props.onDuplicate(props.document)}>
        <CopyIcon size={12} /> {translate('cmsRemote.item.duplicate')}
      </button>
    </div>
  );
}

// Deletes after a confirm, saying where the item goes; a failure is the message to show.
async function deleteItem(
  props: {
    readonly projectPath: string;
    readonly selection: RemoteCmsSelection;
    readonly onRemoved: () => void;
  },
  translate: Translator,
  translateDescribed: DescribedTranslator,
): Promise<string | undefined> {
  const { selection } = props;
  const title = selection.item?.title ?? translate('cmsRemote.delete.thisItem');
  const confirmed = await confirmDialog({
    title: translate('cmsRemote.delete.title', { title }),
    body: isAstroContent(selection.connection)
      ? translate('cmsRemote.delete.itemBodyProject', { note: translate('cmsRemote.delete.filesToTrash') })
      : translate('cmsRemote.delete.itemBodyCms', { connection: selection.connection.label }),
    confirmLabel: translate('cmsRemote.delete.action'),
    danger: true,
  });
  const id = selection.item?.id;
  if (!confirmed || id === undefined) {
    return undefined;
  }
  const deleted = await deleteRemoteDocuments(props.projectPath, selection.connection.id, [id]);
  if (!deleted.ok) {
    return translateDescribed(deleted);
  }
  props.onRemoved();
  return undefined;
}
