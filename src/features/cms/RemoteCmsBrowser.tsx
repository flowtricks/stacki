// A connected CMS inside the CMS panel: its collections, in the order its own
// editor lists them. A collection opens in the main view (RemoteCmsView.tsx),
// as a table of its items; one holding a single item opens that item. The open
// collection stays highlighted here.
import { useState } from 'react';
import './remoteCms.css';
import { ChevronLeftIcon, ChevronRightIcon } from '../../ui/Icons';
import { SanityTypeIcon } from './SanityTypeIcon';
import { remoteCollections, remoteDocuments } from '../../ipc/cmsConnectionsBridge';
import type { CmsConnection } from '../../../shared/properties/cmsConnections';
import type {
  RemoteCollection,
  RemoteResult,
  RemoteStatus,
} from '../../../shared/properties/cmsRemote';
import { labelize } from './cmsSchema';
import { ConnectionLogo, Loading, useRemote, type RemoteCmsSelection } from './remoteCmsShared';
import { COLLECTIONS, DOCUMENT_LISTS, listKey } from './remoteCmsCache';

interface Props {
  readonly projectPath: string;
  readonly connection: CmsConnection;
  readonly selected: RemoteCmsSelection | undefined;
  readonly onOpen: (selection: RemoteCmsSelection | undefined) => void;
  readonly onClose: () => void;
}

export function RemoteCmsBrowser(props: Props) {
  const { projectPath, connection } = props;
  const [opening, setOpening] = useState<string | undefined>(undefined);
  // A collection of one item opens that item: there is nothing to choose.
  const open = async (entry: RemoteCollection) => {
    let item: RemoteCmsSelection['item'];
    if (entry.count === 1) {
      setOpening(entry.name);
      // A kept list opens its one item at once; only an unread one waits.
      const key = listKey(connection.id, entry.name);
      const kept = DOCUMENT_LISTS.get(key);
      const listed = kept?.ok
        ? kept
        : await DOCUMENT_LISTS.load(key, () =>
            remoteDocuments(projectPath, connection.id, entry.name),
          );
      setOpening(undefined);
      const only =
        listed.ok && listed.value.documents.length === 1 ? listed.value.documents[0] : undefined;
      item = only && {
        id: only.id,
        title: only.title === only.id ? labelize(entry.name) : only.title,
      };
    }
    props.onOpen({ connection, collection: entry.name, item });
  };
  return (
    <div className="panel-section grow">
      <div className="panel-header">
        <div className="cms-crumb">
          <button
            className="ghost"
            title="All collections"
            onClick={() => {
              props.onOpen(undefined);
              props.onClose();
            }}
          >
            <ChevronLeftIcon size={14} />
          </button>
          <span className="remote-cms-logo">
            <ConnectionLogo kind={connection.kind} />
          </span>
          <h2>{connection.label}</h2>
        </div>
      </div>
      <div className="panel-body">
        <CollectionList
          connectionId={connection.id}
          load={() => remoteCollections(projectPath, connection.id)}
          selected={opening ?? props.selected?.collection}
          onOpen={(entry) => void open(entry)}
        />
      </div>
    </div>
  );
}

function CollectionList(props: {
  readonly connectionId: string;
  readonly load: () => Promise<RemoteResult<readonly RemoteCollection[]>>;
  readonly selected: string | undefined;
  readonly onOpen: (collection: RemoteCollection) => void;
}) {
  const { result, retry } = useRemote(COLLECTIONS, props.connectionId, props.load);
  return (
    <Loading result={result} retry={retry}>
      {(collections) =>
        collections.map((collection) => (
          <div
            key={collection.name}
            className={`cms-collection ${collection.name === props.selected ? 'on' : ''}`}
            onClick={() => props.onOpen(collection)}
          >
            <SanityTypeIcon symbol={collection.icon} size={14} />
            <span className="cms-collection-name">{labelize(collection.name)}</span>
            <span className="cms-collection-count">{collection.count}</span>
            <span className="cms-collection-chevron">
              <ChevronRightIcon size={10} />
            </span>
          </div>
        ))
      }
    </Loading>
  );
}

export const STATUS_LABELS: Readonly<Record<RemoteStatus, string>> = {
  draft: 'Draft',
  changed: 'Edited',
  published: 'Published',
};
