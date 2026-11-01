// A new item, or a copy of one, before it exists: its collection's fields (a
// template, or the source's values) edited in memory, written only when Create
// is pressed. Cancel, or opening another item, leaves nothing behind — as a
// CMS's own "New item" page does. Creating makes the item, then writes each
// field it holds, through the calls the editor already uses, so it works the
// same for a connected CMS and for the project's content collections.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  CMS_REMOTE_LIMITS,
  type RemoteDocument,
  type RemoteDocumentField,
  type RemoteDocumentSummary,
  type RemoteResult,
} from '../../../shared/properties/cmsRemote';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { ChevronLeftIcon } from '../../ui/Icons';
import { ErrorToast } from '../../ui/ErrorToast';
import { RemoteFieldList } from './RemoteFieldList';
import { useEditContext } from './RemoteItemFields';
import type { RemoteCmsSelection } from './remoteCmsShared';
import { createRemoteDocument, writeRemoteDocument } from '../../ipc/remoteSource';

/** An item being made: what it is called until it exists, and its fields. */
export interface PendingItem {
  readonly title: string;
  readonly document: RemoteDocument;
}

export function RemotePendingItem(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly pending: PendingItem;
  readonly onChange: (pending: PendingItem) => void;
  readonly onBack: (() => void) | undefined;
  readonly onCancel: () => void;
  readonly onCreated: (item: RemoteDocumentSummary) => void;
}) {
  const { pending } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const context = useEditContext(props.projectPath, props.selection.connection.id, pending.document);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    const made = await createFromDocument(props.projectPath, props.selection, pending.document);
    setBusy(false);
    if (made.ok) {
      props.onCreated(made.value);
    } else {
      setError(made.message);
    }
  };
  return (
    <div className="cms-detail remote-cms-item is-pending">
      <div className="cms-detail-head remote-cms-item-head">
        {props.onBack && (
          <button className="ghost cms-back" title="Back to the list" onClick={props.onBack}>
            <ChevronLeftIcon size={13} />
          </button>
        )}
        <span className="cms-detail-title">{pending.title}</span>
        <div className="remote-cms-item-meta">
          <button type="button" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="primary" disabled={busy} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      <div className="cms-detail-body">
        <div className="remote-cms-fields">
          {error && <ErrorToast message={error} />}
          <RemoteFieldList document={pending.document} context={context} onSave={(field, value) => props.onChange(withValue(pending, field, value))} />
        </div>
      </div>
    </div>
  );
}

/** A copy of an item, ready to edit: its values, its name marked, its slug left to be made. */
export function duplicateOf(document: RemoteDocument, title: string): PendingItem {
  const named = document.fields.find((field) => NAME_FIELDS.includes(field.name));
  const fields = document.fields.map((field): RemoteDocumentField => {
    if (field.type.kind === 'slug') {
      return { ...field, value: undefined };
    }
    if (field === named && typeof field.value === 'string') {
      return { ...field, value: `${field.value} (copy)` };
    }
    return field;
  });
  assert(fields.length === document.fields.length, 'A copy has every field of its source');
  return { title: `${title} (copy)`, document: { ...document, fields } };
}

// The pending item with one field's new value; the title follows its name field.
function withValue(pending: PendingItem, changed: RemoteDocumentField, value: RemoteValue | undefined): PendingItem {
  const fields = pending.document.fields.map((field) => (field.name === changed.name ? { ...field, value } : field));
  const named = NAME_FIELDS.includes(changed.name) && typeof value === 'string' && value !== '';
  return {
    title: named ? value : pending.title,
    document: { ...pending.document, fields },
  };
}

/** Makes the item, then writes each field it holds: one whole value per field, in order. */
async function createFromDocument(projectPath: string, selection: RemoteCmsSelection, document: RemoteDocument): Promise<RemoteResult<RemoteDocumentSummary>> {
  const connectionId = selection.connection.id;
  assert(document.fields.length <= CMS_REMOTE_LIMITS.fieldsMax, 'A document has bounded fields');
  const made = await createRemoteDocument(projectPath, connectionId, selection.collection);
  if (!made.ok) {
    return made;
  }
  let title = made.value.title;
  for (const field of document.fields) {
    if (field.value === undefined) {
      continue;
    }
    const write = { id: made.value.id, field: field.name, value: field.value };
    const written = await writeRemoteDocument(projectPath, connectionId, write);
    if (!written.ok) {
      return { ok: false, message: `The item was made, but ${field.title}: ${written.message}` };
    }
    if (NAME_FIELDS.includes(field.name) && typeof field.value === 'string') {
      title = field.value;
    }
  }
  assert(made.value.id !== document.id, 'A created item is a new one');
  return { ok: true, value: { ...made.value, title } };
}

const NAME_FIELDS: readonly string[] = ['title', 'name', 'heading', 'label'];
