// One connected-CMS item's fields, beside its collection's column of names.
// Every field is editable by its type; a saved field becomes a draft in the
// CMS, and nothing is published.
import { useMemo, useState } from 'react';
import { ChevronLeftIcon } from '../../ui/Icons';
import { ErrorToast } from '../../ui/ErrorToast';
import { remoteDocument, writeRemoteDocument } from './remoteSource';
import type {
  RemoteAsset,
  RemoteDocument,
  RemoteDocumentField,
} from '../../../shared/properties/cmsRemote';
import { RemoteItemActions } from './RemoteItemActions';
import type { RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { RemoteFieldList } from './RemoteFieldList';
import type { RemoteEditContext } from './RemoteValueEditor';
import { STATUS_LABELS } from './RemoteCmsBrowser';
import { Loading, useRemote, type RemoteCmsSelection } from './remoteCmsShared';
import { DOCUMENTS, documentKey } from './remoteCmsCache';
import { RemoteDocumentActions } from './RemoteDocumentActions';
import { isAstroContent } from '../../../shared/properties/astroContent';
import { relativeTime } from './remoteTime';

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
}) {
  const { projectPath, selection } = props;
  const { connection } = selection;
  const id = selection.item?.id ?? '';
  // Kept across opens: an item opened before, or pointed at in the list, shows at
  // once and is refreshed behind the view; a save shows the CMS's answer.
  const { result, retry, replace } = useRemote(DOCUMENTS, documentKey(connection.id, id), () =>
    remoteDocument(projectPath, connection.id, id),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const save = async (field: RemoteDocumentField, value: RemoteValue | undefined) => {
    setError(undefined);
    const write = { id, field: field.name, value };
    const written = await writeRemoteDocument(projectPath, connection.id, write);
    if (written.ok) {
      replace(written.value);
      props.onSaved();
    } else {
      setError(written.message);
    }
  };
  const document = result?.ok ? result.value : undefined;
  const context = useEditContext(projectPath, connection.id, document);
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
        <Loading result={result} retry={retry}>
          {(loaded) => (
            <div className="remote-cms-fields">
              {error && <ErrorToast message={error} />}
              <RemoteFieldList
                document={loaded}
                context={context}
                onSave={(field, value) => void save(field, value)}
              />
              <RemoteItemActions
                projectPath={projectPath}
                selection={selection}
                document={loaded}
                onChanged={props.onSaved}
                onRemoved={props.onRemoved}
                onDuplicate={props.onDuplicate}
              />
            </div>
          )}
        </Loading>
      </div>
    </div>
  );
}

// What every field's editor reaches: the connection, the stored assets the
// document points at, with any uploaded since it loaded, and the folder of the
// project file it lives in, which its image paths are relative to.
export function useEditContext(
  projectPath: string,
  connectionId: string,
  document: RemoteDocument | undefined,
): RemoteEditContext {
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
  // A project's file has no draft to publish or discard, and its history is git's.
  const files = isAstroContent(props.selection.connection);
  return (
    <div className="cms-detail-head remote-cms-item-head">
      {props.onBack && (
        <button className="ghost cms-back" title="Back to the list" onClick={props.onBack}>
          <ChevronLeftIcon size={13} />
        </button>
      )}
      <span className="cms-detail-title">{props.selection.item?.title}</span>
      {document && (
        // One group, so a narrow header moves state and actions to the next line together.
        <div className="remote-cms-item-meta">
          <DocumentState document={document} shows={files ? 'times' : 'status'} />
          {!files && (
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
  const times = [
    editedAt === undefined ? undefined : `Edited ${relativeTime(editedAt)}`,
    publishedAt === undefined ? undefined : `Published ${relativeTime(publishedAt)}`,
  ].filter((part): part is string => part !== undefined);
  return (
    <>
      {/* The times are its tooltip too, for a header too narrow to show them. */}
      {props.shows === 'status' && (
        <span className={`remote-cms-status is-${status}`} title={times.join(' · ')}>
          {STATUS_LABELS[status]}
        </span>
      )}
      {times.length > 0 && <span className="remote-cms-times">{times.join(' · ')}</span>}
    </>
  );
}
