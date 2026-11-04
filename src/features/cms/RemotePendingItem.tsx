// A new item, or a copy of one, before it exists: its collection's fields (a
// template, or the source's values) edited in memory, written only when Create
// is pressed. Cancel, or opening another item, leaves nothing behind — as a
// CMS's own "New item" page does. Creating makes the item, then writes each
// field it holds, through the calls the editor already uses, so it works the
// same for a connected CMS and for the project's content collections.
//
// An Astro entry is a file its site builds from, and Astro's own schema check
// fails the build on an empty required field, so Create refuses while one is
// empty (requiredFieldsMissing). Each says so under its control once it has been
// edited or Create was pressed, not on the fresh form. A Sanity item is a
// draft, which the Studio lets be saved incomplete; only Publish waits.
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
import { createRemoteDocument, renameContentEntry, writeRemoteDocument } from '../../ipc/remoteSource';
import { isAstroContent } from '../../../shared/properties/astroContent';
import { requiredFieldsMissing, valuesOf } from './remoteValidation';
import { EntrySlugField } from './EntrySlugField';
import { copiedSlug, draftName, draftSlugBlock, draftSlugText, draftSlugToSave, FOLLOWS_NAME, type SlugDraft } from './entrySlugDraft';

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
  // Fields edited so far, and whether Create was pressed: what decides which empty required fields say so.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  const context = useEditContext(props.projectPath, props.selection.connection.id, pending.document);
  const enforced = isAstroContent(props.selection.connection);
  const missing = enforced ? requiredFieldsMissing(pending.document.fields, valuesOf(pending.document)) : [];
  const requiredShown = new Set(attempted ? missing : missing.filter((name) => touched.has(name)));
  // An Astro entry's slug follows its name until one is typed (entrySlugDraft.ts).
  const [slugDraft, setSlugDraft] = useState<SlugDraft>(FOLLOWS_NAME);
  const slugText = draftSlugText(pending.document, slugDraft);
  const slugBlocked = draftSlugBlock(pending.document.slug, slugText) !== undefined;
  const blocked = missing.length > 0 || slugBlocked;
  const create = async () => {
    if (blocked) {
      setAttempted(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    const slug = draftSlugToSave(pending.document.slug, slugText);
    const made = await createFromDocument(props.projectPath, props.selection, { document: pending.document, slug });
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
          <button
            type="button"
            className="primary"
            disabled={busy}
            title={blocked ? 'Fill in the required fields and a free slug first' : undefined}
            onClick={() => void create()}
          >
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      <div className="cms-detail-body">
        <div className="remote-cms-fields">
          {error && <ErrorToast message={error} />}
          {pending.document.slug && (
            <EntrySlugField
              slug={pending.document.slug}
              text={slugText}
              placeholder="Made from the name when left empty"
              onType={(text) => setSlugDraft({ kind: 'typed', text })}
              onCommit={() => undefined}
            />
          )}
          <RemoteFieldList
            document={pending.document}
            context={context}
            requiredShown={requiredShown}
            onSave={(field, value) => {
              setTouched((known) => new Set([...known, field.name]));
              props.onChange(withValue(pending, field, value));
            }}
          />
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
  const copy = document.slug === undefined ? { ...document, fields } : { ...document, fields, slug: copiedSlug(document.slug) };
  return { title: `${title} (copy)`, document: copy };
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
async function createFromDocument(
  projectPath: string,
  selection: RemoteCmsSelection,
  request: { readonly document: RemoteDocument; readonly slug: string | undefined },
): Promise<RemoteResult<RemoteDocumentSummary>> {
  const { document } = request;
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
  // An Astro entry is listed by the title rule (entryTitle.ts); it is shown by it at once too.
  if (document.slug !== undefined) {
    title = draftName(document) ?? (request.slug === undefined ? title : `${document.slug.folder}${request.slug}`);
  }
  if (request.slug === undefined) {
    return { ok: true, value: { ...made.value, title } };
  }
  // Renamed last, once every field is written under the id it was made with.
  const renamed = await renameContentEntry(projectPath, made.value.id, request.slug);
  if (!renamed.ok) {
    return { ok: false, message: `The item was made, but its slug: ${renamed.message}` };
  }
  return { ok: true, value: { ...made.value, id: renamed.value.id, title } };
}

const NAME_FIELDS: readonly string[] = ['title', 'name', 'heading', 'label'];
