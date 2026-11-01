// A connected CMS inside the CMS panel, or the project's own Astro content
// collections: its collections, in the order its own editor lists them. Only
// content collections can be added here (to the content config); an empty set
// of them says so and offers the first. A collection opens in the main view (RemoteCmsView.tsx),
// as a table of its items; one holding a single item opens that item. The open
// collection stays highlighted here.
import { useEffect, useState } from 'react';
import { cmsTransport } from '../../ipc/editorEnvironment';
import './remoteCms.css';
import {
  AstroIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CmsIcon,
  GearIcon,
  PlusIcon,
} from '../../ui/Icons';
import { SanityTypeIcon } from './SanityTypeIcon';
import { createContentCollection, remoteCollections, remoteDocuments } from './remoteSource';
import {
  ASTRO_CONTENT_SOURCE,
  isAstroContent,
  type CmsSource,
} from '../../../shared/properties/astroContent';
import type { RemoteCollection, RemoteStatus } from '../../../shared/properties/cmsRemote';
import { labelize } from './cmsSchema';
import { ConnectionLogo, Loading, useRemote, type RemoteCmsSelection } from './remoteCmsShared';
import { COLLECTIONS, DOCUMENT_LISTS, listKey } from './remoteCmsCache';

interface Props {
  readonly projectPath: string;
  readonly connection: CmsSource;
  readonly selected: RemoteCmsSelection | undefined;
  readonly onOpen: (selection: RemoteCmsSelection | undefined) => void;
  readonly onClose: () => void;
}

export function RemoteCmsBrowser(props: Props) {
  const { projectPath, connection } = props;
  const [opening, setOpening] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const collections = useRemote(COLLECTIONS, connection.id, () =>
    remoteCollections(projectPath, connection.id),
  );
  useProjectChanges(connection, collections.retry);
  // A collection of one item opens that item: there is nothing to choose.
  const open = async (entry: RemoteCollection) => {
    // The open collection's row closes it again.
    if (props.selected?.collection === entry.name) {
      props.onOpen(undefined);
      return;
    }
    let item: RemoteCmsSelection['item'];
    // A content collection always opens on its list: its one entry is one of many to come.
    if (entry.count === 1 && !isAstroContent(connection)) {
      setOpening(entry.name);
      item = await onlyItem(projectPath, connection.id, entry.name);
      setOpening(undefined);
    }
    props.onOpen({ connection, collection: entry.name, item });
  };
  // A new content collection shows in the list at once and opens, empty, beside it.
  const created = (entry: RemoteCollection) => {
    setCreating(false);
    const kept = collections.result?.ok ? collections.result.value : [];
    collections.replace([...kept, entry]);
    collections.retry();
    props.onOpen({ connection, collection: entry.name, item: undefined });
  };
  return (
    <div className="panel-section grow">
      <BrowserHeader
        connection={connection}
        onBack={() => {
          props.onOpen(undefined);
          props.onClose();
        }}
        onCreate={isAstroContent(connection) ? () => setCreating(true) : undefined}
      />
      <div className="panel-body">
        {creating && (
          <CreateCollectionRow
            projectPath={projectPath}
            onCreated={created}
            onCancel={() => setCreating(false)}
          />
        )}
        <Loading result={collections.result} retry={collections.retry}>
          {(loaded) =>
            loaded.length === 0 && isAstroContent(connection) ? (
              !creating && <EmptyContent onCreate={() => setCreating(true)} />
            ) : (
              <CollectionList
                files={isAstroContent(connection)}
                collections={loaded}
                selected={opening ?? props.selected?.collection}
                onOpen={(entry) => void open(entry)}
                onSettings={(entry) => props.onOpen(settingsOf(connection, entry))}
              />
            )
          }
        </Loading>
      </div>
    </div>
  );
}

// A collection's one item; a kept list answers at once, and only an unread one waits.
async function onlyItem(
  projectPath: string,
  connectionId: string,
  collection: string,
): Promise<RemoteCmsSelection['item']> {
  const key = listKey(connectionId, collection);
  const kept = DOCUMENT_LISTS.get(key);
  const listed = kept?.ok
    ? kept
    : await DOCUMENT_LISTS.load(key, () => remoteDocuments(projectPath, connectionId, collection));
  const only =
    listed.ok && listed.value.documents.length === 1 ? listed.value.documents[0] : undefined;
  return only && { id: only.id, title: only.title === only.id ? labelize(collection) : only.title };
}

// Content collections read again when the project's content changes: a rename or
// delete in their settings, or an edit from elsewhere. A CMS is read when opened.
function useProjectChanges(connection: CmsSource, reread: () => void): void {
  const files = isAstroContent(connection);
  useEffect(() => (files ? cmsTransport.onCmsChanged(reread) : undefined), [files, reread]);
}

// A collection's settings, open in the main view in place of its items.
function settingsOf(connection: CmsSource, entry: RemoteCollection): RemoteCmsSelection {
  return { connection, collection: entry.name, item: undefined, mode: 'settings' };
}

function BrowserHeader(props: {
  readonly connection: CmsSource;
  readonly onBack: () => void;
  /** Where a new collection is made; absent for a CMS, whose schema is its own code. */
  readonly onCreate: (() => void) | undefined;
}) {
  const { connection } = props;
  return (
    <div className="panel-header">
      <div className="cms-crumb">
        <button className="ghost" title="All collections" onClick={props.onBack}>
          <ChevronLeftIcon size={14} />
        </button>
        <span className="remote-cms-logo">
          <ConnectionLogo kind={connection.kind} />
        </span>
        {/* The CMS's name, as its row in the panel shows it; the dataset's is the tooltip. */}
        <h2 title={connection.label}>{SOURCE_NAMES[connection.kind]}</h2>
      </div>
      {props.onCreate && (
        <button className="ghost" title="New collection" onClick={props.onCreate}>
          <PlusIcon size={14} />
        </button>
      )}
    </div>
  );
}

function CollectionList(props: {
  /** The project's content collections, drawn with the CMS panel's own icon. */
  readonly files: boolean;
  readonly collections: readonly RemoteCollection[];
  readonly selected: string | undefined;
  readonly onOpen: (collection: RemoteCollection) => void;
  /** Opens a content collection's settings; a CMS's schema is its own code. */
  readonly onSettings: (collection: RemoteCollection) => void;
}) {
  return props.collections.map((collection) => (
    <div
      key={collection.name}
      className={`cms-collection is-counted ${collection.name === props.selected ? 'on' : ''}`}
      onClick={() => props.onOpen(collection)}
    >
      {props.files ? <CmsIcon size={14} /> : <SanityTypeIcon symbol={collection.icon} size={14} />}
      {/* One label: the name gives way (cut short) before its count does. */}
      <span className="cms-collection-label">
        <span className="cms-collection-name">{labelize(collection.name)}</span>
        <span className="cms-collection-count">
          {collection.count === 1 ? '1 item' : `${collection.count} items`}
        </span>
      </span>
      <span className="cms-collection-chevron">
        <ChevronRightIcon size={10} />
      </span>
      {/* On hover the arrow gives way to the settings, as a CMS's own list does. */}
      {props.files && (
        <button
          type="button"
          className="ghost cms-collection-settings"
          title="Collection settings"
          onClick={(event) => {
            event.stopPropagation();
            props.onSettings(collection);
          }}
        >
          <GearIcon size={13} />
        </button>
      )}
    </div>
  ));
}

// A name typed in place, as a local collection's is: Enter creates, Escape or an
// empty name leaves. A name the config refuses stays, with the reason under it.
function CreateCollectionRow(props: {
  readonly projectPath: string;
  readonly onCreated: (collection: RemoteCollection) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const submit = async () => {
    if (name.trim().length === 0) {
      props.onCancel();
      return;
    }
    setBusy(true);
    const made = await createContentCollection(props.projectPath, name);
    setBusy(false);
    if (made.ok) {
      props.onCreated(made.value);
    } else {
      setFailure(made.message);
    }
  };
  return (
    <>
      <div className="cms-collection">
        <AstroIcon size={14} />
        <input
          autoFocus
          value={name}
          disabled={busy}
          placeholder="Collection name"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              void submit();
            } else if (event.key === 'Escape') {
              props.onCancel();
            }
          }}
        />
      </div>
      {failure && <p className="remote-cms-note remote-cms-failure">{failure}</p>}
    </>
  );
}

function EmptyContent(props: { readonly onCreate: () => void }) {
  return (
    <div className="props-empty">
      <div className="cms-empty-icon" aria-hidden="true">
        <AstroIcon size={24} />
      </div>
      <h3 className="cms-empty-title">No content collections yet.</h3>
      <p>A collection keeps entries as Markdown files in src/content, typed by a schema.</p>
      <div className="cms-empty-action">
        <button className="primary" onClick={props.onCreate}>
          New collection
        </button>
      </div>
    </div>
  );
}

const SOURCE_NAMES: Readonly<Record<CmsSource['kind'], string>> = {
  sanity: 'Sanity',
  payload: 'Payload',
  custom: 'Custom CMS',
  astro: ASTRO_CONTENT_SOURCE.label,
};

export const STATUS_LABELS: Readonly<Record<RemoteStatus, string>> = {
  draft: 'Draft',
  changed: 'Edited',
  published: 'Published',
};
