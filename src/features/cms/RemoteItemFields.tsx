// One connected-CMS item's fields, beside its collection's column of names.
// Every field is editable by its type; a saved field becomes a draft in the
// CMS, and nothing is published. An Astro entry's edit that would leave a
// required field empty is not written (saveRefused): the file keeps its value,
// and the field says it is required, as every empty required field of the
// entry does from the start.
//
// Moving to another item keeps the last one on screen, held and unchecked,
// until the new item's read answers (entryLoad.ts): the form never empties, and
// nothing is reported about values that are not the selected item's. Every
// write names the document its form shows, not the selection, which may have
// moved on by the time an edit is saved.
import { useMemo, useState, type ReactNode } from 'react';
import { ChevronLeftIcon } from '../../ui/Icons';
import { ErrorToast } from '../../ui/ErrorToast';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { remoteDocument, renameContentEntry, writeRemoteDocument } from '../../ipc/remoteSource';
import type { RemoteAsset, RemoteDocument, RemoteDocumentField } from '../../../shared/properties/cmsRemote';
import { RemoteItemActions } from './RemoteItemActions';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { RemoteFieldList } from './RemoteFieldList';
import type { RemoteEditContext } from './RemoteValueEditor';
import { STATUS_KEYS } from './RemoteCmsBrowser';
import { FieldChecksContext, Loading, useRemote, type FieldChecks, type RemoteCmsSelection } from './remoteCmsShared';
import { entryShown, useEntryLoad, type EntryLoad } from './entryLoad';
import { DOCUMENTS, documentKey } from './remoteCmsCache';
import { RemoteDocumentActions } from './RemoteDocumentActions';
import { isAstroContent } from '../../../shared/properties/astroContent';
import { relativeTime } from './remoteTime';
import { saveRefused } from './remoteValidation';
import { EntrySlugField } from './EntrySlugField';
import type { EntrySlug } from '../../../shared/properties/entrySlug';

export function RemoteItemFields(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  /** Back to the collection's table; absent when the collection is this one item. */
  readonly onBack: (() => void) | undefined;
  /** The item no longer exists (a never-published draft was discarded). */
  readonly onRemoved: () => void;
  readonly onSaved: () => void;
  /** Opens a copy of this item, to be created or cancelled. */
  readonly onDuplicate: (document: RemoteDocument) => void;
  /** The item's id changed (an Astro entry's slug was renamed): it is this item now. */
  readonly onRenamed: (item: { readonly id: string; readonly title: string }) => void;
}) {
  const { projectPath, selection } = props;
  const { connection } = selection;
  const translateDescribed = useTranslateDescribed();
  const id = selection.item?.id ?? '';
  // Kept across opens: an item opened before, or pointed at in the list, shows at
  // once and is refreshed behind the view; a save shows the CMS's answer.
  const { result, retry, replace, replaceAt } = useRemote(DOCUMENTS, documentKey(connection.id, id), () => remoteDocument(projectPath, connection.id, id));
  const load = useEntryLoad(id, result);
  // A failed edit is said on the item it failed on, not on the one opened after it.
  const [error, setError] = useState<{ readonly id: string; readonly message: string } | undefined>(undefined);
  const enforced = isAstroContent(connection);
  const save = async (target: RemoteDocument, field: RemoteDocumentField, value: RemoteValue | undefined) => {
    setError(undefined);
    if (enforced && saveRefused(field, value)) {
      // Its control already says the field is required; the file is left as it was.
      return;
    }
    const write = { id: target.id, field: field.name, value };
    const written = await writeRemoteDocument(projectPath, connection.id, write);
    if (written.ok) {
      replaceAt(documentKey(connection.id, target.id), written.value);
      props.onSaved();
    } else {
      setError({ id: target.id, message: translateDescribed(written) });
    }
  };
  // One rename moves the file and every reference to it; the item is then named by its new id.
  const rename = async (target: RemoteDocument, slug: EntrySlug, to: string) => {
    setError(undefined);
    const renamed = await renameContentEntry(projectPath, target.id, to);
    if (renamed.ok) {
      const before = `${slug.folder}${slug.value}`;
      const title = selection.item?.title ?? before;
      props.onRenamed({ id: renamed.value.id, title: title === before ? `${slug.folder}${to}` : title });
    } else {
      setError({ id: target.id, message: translateDescribed(renamed) });
    }
  };
  const renameTo = (target: RemoteDocument, to: string) => {
    if (target.slug !== undefined) {
      void rename(target, target.slug, to);
    }
  };
  // The header speaks for the selected item, so it waits for that item's own read.
  const document = load.kind === 'ready' ? load.document : undefined;
  const context = useEditContext(projectPath, connection.id, entryShown(load));
  const form = (shown: RemoteDocument, checks: FieldChecks) => (
    <EntryForm
      {...props}
      document={shown}
      checks={checks}
      context={context}
      error={error?.id === shown.id ? error.message : undefined}
      enforced={enforced}
      onSave={(field, value) => void save(shown, field, value)}
      onRename={(to) => renameTo(shown, to)}
    />
  );
  return (
    <div className="cms-detail remote-cms-item">
      <ItemHeader
        {...props}
        document={document}
        onChanged={(changed) => {
          props.onSaved();
          if (changed === undefined) {
            // A discarded draft that was never published is gone.
            props.onRemoved();
          } else {
            replace(changed);
          }
        }}
      />
      <div className="cms-detail-body">
        <EntryBody load={load} retry={retry}>
          {form}
        </EntryBody>
      </div>
    </div>
  );
}

// What the body shows for each state of the read. A held entry and a ready one
// are the same form in the same place, so moving between them keeps it standing.
function EntryBody(props: {
  readonly load: EntryLoad;
  readonly retry: () => void;
  readonly children: (document: RemoteDocument, checks: FieldChecks) => ReactNode;
}) {
  const { load, retry } = props;
  switch (load.kind) {
    case 'loading':
      if (load.held === undefined) {
        return (
          <Loading result={undefined} retry={retry}>
            {() => undefined}
          </Loading>
        );
      }
      return props.children(load.held, 'held');
    case 'failed':
      return (
        <Loading result={{ ok: false, message: load.message }} retry={retry}>
          {() => undefined}
        </Loading>
      );
    case 'ready':
      return props.children(load.document, 'shown');
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

// `inert` takes a held form out of reach of the pointer and the keyboard. React
// 18's types do not list it, and it passes it on only as a string.
const HELD_FORM = { inert: '' };

// One document's fields and actions. Its checks run only while it is the
// selected item's own document.
function EntryForm(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly document: RemoteDocument;
  readonly checks: FieldChecks;
  readonly context: RemoteEditContext;
  readonly error: string | undefined;
  /** Required fields say so while empty: an Astro entry cannot be saved without them. */
  readonly enforced: boolean;
  readonly onSave: (field: RemoteDocumentField, value: RemoteValue | undefined) => void;
  readonly onRename: (to: string) => void;
  readonly onSaved: () => void;
  readonly onRemoved: () => void;
  readonly onDuplicate: (document: RemoteDocument) => void;
}) {
  const { document, enforced } = props;
  const translate = useTranslate();
  // Every required field may say so: an empty one on an entry already saved is a problem now.
  const requiredShown = enforced ? new Set(document.fields.filter((field) => field.required).map((field) => field.name)) : undefined;
  return (
    <FieldChecksContext.Provider value={props.checks}>
      <div className="remote-cms-fields" {...(props.checks === 'held' ? HELD_FORM : {})}>
        {props.error && <ErrorToast message={props.error} />}
        {document.appliesLive === true && (
          <p className="remote-cms-live-notice" role="status">
            {translate('settings.cms.payload.liveNotice')}
          </p>
        )}
        {document.slug && <EntrySlugField key={document.id} slug={document.slug} onCommit={props.onRename} />}
        <RemoteFieldList document={document} context={props.context} requiredShown={requiredShown} onSave={props.onSave} />
        <RemoteItemActions
          projectPath={props.projectPath}
          selection={props.selection}
          document={document}
          onChanged={props.onSaved}
          onRemoved={props.onRemoved}
          onDuplicate={props.onDuplicate}
        />
      </div>
    </FieldChecksContext.Provider>
  );
}

// What every field's editor reaches: the connection, the stored assets the
// document points at, with any uploaded since it loaded, and the folder of the
// project file it lives in, which its image paths are relative to.
export function useEditContext(projectPath: string, connectionId: string, document: RemoteDocument | undefined): RemoteEditContext {
  const [uploaded, setUploaded] = useState<readonly RemoteAsset[]>([]);
  const loaded = document?.assets;
  const folder = document?.file?.split('/').slice(0, -1).join('/');
  return useMemo(
    () => ({
      projectPath,
      connectionId,
      assets: new Map([...(loaded ?? []), ...uploaded].map((asset) => [asset.id, asset])),
      addAsset: (asset: RemoteAsset) => setUploaded((known) => [...known, asset]),
      folder,
      depth: 0,
    }),
    [projectPath, connectionId, loaded, uploaded, folder],
  );
}

// The item's name, where it stands, and what can be done to it as a whole.
function ItemHeader(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly onBack: (() => void) | undefined;
  readonly document: RemoteDocument | undefined;
  readonly onChanged: (document: RemoteDocument | undefined) => void;
}) {
  const { document } = props;
  const translate = useTranslate();
  // A project's file has no draft to publish or discard, and its history is git's.
  const files = isAstroContent(props.selection.connection);
  return (
    <div className="cms-detail-head remote-cms-item-head">
      {props.onBack && (
        <button className="ghost cms-back" title={translate('cmsRemote.item.backToList')} onClick={props.onBack}>
          <ChevronLeftIcon size={13} />
        </button>
      )}
      <span className="cms-detail-title">{props.selection.item?.title}</span>
      {document && (
        // One group, so a narrow header moves state and actions to the next line together.
        <div className="remote-cms-item-meta">
          <DocumentState document={document} shows={files ? 'times' : 'status'} />
          {!files && document.appliesLive !== true && (
            <RemoteDocumentActions
              projectPath={props.projectPath}
              connectionId={props.selection.connection.id}
              document={document}
              onChanged={props.onChanged}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Where the document stands, as Sanity Studio shows it: published, a draft
// never published, or published with unpublished edits, with when each changed.
function DocumentState(props: {
  readonly document: RemoteDocument;
  /** A file shows only when it changed; a CMS document also where it stands. */
  readonly shows: 'status' | 'times';
}) {
  const { status, editedAt, publishedAt } = props.document;
  const translate = useTranslate();
  const format = useFormat();
  const text = { translate, format };
  const times = [
    editedAt === undefined ? undefined : translate('cmsRemote.item.edited', { time: relativeTime(editedAt, Date.now(), text) }),
    publishedAt === undefined ? undefined : translate('cmsRemote.item.publishedAt', { time: relativeTime(publishedAt, Date.now(), text) }),
  ].filter((part): part is string => part !== undefined);
  return (
    <>
      {/* The times are its tooltip too, for a header too narrow to show them. */}
      {props.shows === 'status' && (
        <span className={`remote-cms-status is-${status}`} title={times.join(' · ')}>
          {translate(STATUS_KEYS[status])}
        </span>
      )}
      {times.length > 0 && <span className="remote-cms-times">{times.join(' · ')}</span>}
    </>
  );
}
