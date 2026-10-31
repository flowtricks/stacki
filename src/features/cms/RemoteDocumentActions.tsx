// What Sanity Studio's document footer offers, in the item header: Publish
// (blocked while a rule the schema states is broken, with what to fix), and a
// menu to discard the unpublished changes, unpublish, or open the history to
// restore an earlier version. Discard and unpublish confirm first; a restored
// version becomes the draft and is not published until Publish is pressed.
import { useEffect, useState } from 'react';
import type { RemoteDocument, RemoteRevision } from '../../../shared/properties/cmsRemote';
import type { RemoteDocumentAction } from '../../../shared/properties/cmsRemote';
import {
  actOnRemoteDocument,
  remoteHistory,
  restoreRemoteRevision,
} from '../../ipc/cmsConnectionsBridge';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { ErrorToast } from '../../ui/ErrorToast';
import { CloseIcon, HistoryIcon, ResetIcon, TrashIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import Popup from '../../ui/Popup';
import { publishBlockers } from './remoteValidation';
import { relativeTime } from './remoteTime';

interface Props {
  readonly projectPath: string;
  readonly connectionId: string;
  readonly document: RemoteDocument;
  /** The document as it stands after an action; undefined when the action removed it. */
  readonly onChanged: (document: RemoteDocument | undefined) => void;
}

const CONFIRMS: Readonly<
  Record<
    Exclude<RemoteDocumentAction, 'publish'>,
    {
      readonly title: string;
      readonly body: string;
      readonly confirmLabel: string;
    }
  >
> = {
  discard: {
    title: 'Discard changes?',
    body: 'The unpublished changes to this item are thrown away. Sanity keeps them in its history.',
    confirmLabel: 'Discard',
  },
  unpublish: {
    title: 'Unpublish this item?',
    body: 'It leaves the live site. Its content is kept as a draft you can publish again.',
    confirmLabel: 'Unpublish',
  },
};

export function RemoteDocumentActions(props: Props) {
  const { document } = props;
  const [busy, setBusy] = useState<RemoteDocumentAction | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState(false);
  const blockers = publishBlockers(document);
  const draft = document.editedAt !== undefined || document.status !== 'published';
  const act = async (action: RemoteDocumentAction) => {
    if (action !== 'publish') {
      const confirmed = await confirmDialog({ ...CONFIRMS[action], danger: true });
      if (!confirmed) {
        return;
      }
    }
    setBusy(action);
    setError(undefined);
    const result = await actOnRemoteDocument(props.projectPath, props.connectionId, {
      id: document.id,
      action,
    });
    setBusy(undefined);
    if (result.ok) {
      props.onChanged(result.value);
    } else {
      setError(result.message);
    }
  };
  return (
    <div className="remote-cms-actions">
      {error && <ErrorToast message={error} />}
      <MoreMenu
        title="More"
        width={180}
        items={[
          { label: 'History', icon: <HistoryIcon size={13} />, onSelect: () => setHistory(true) },
          draft && {
            label: 'Discard changes',
            icon: <ResetIcon size={13} />,
            danger: true,
            onSelect: () => void act('discard'),
          },
          document.publishedAt !== undefined && {
            label: 'Unpublish',
            icon: <TrashIcon size={13} />,
            danger: true,
            onSelect: () => void act('unpublish'),
          },
        ]}
      />
      <button
        type="button"
        className="primary"
        disabled={!draft || blockers.length > 0 || busy !== undefined}
        title={blockers.length > 0 ? `Fix before publishing:\n${blockers.join('\n')}` : undefined}
        onClick={() => void act('publish')}
      >
        {busy === 'publish' ? 'Publishing…' : draft ? 'Publish' : 'Published'}
      </button>
      {history && (
        <HistoryDialog {...props} onClose={() => setHistory(false)} onRestored={props.onChanged} />
      )}
    </div>
  );
}

// The document's saved versions, newest first; restoring one makes it the draft.
function HistoryDialog(
  props: Props & {
    readonly onClose: () => void;
    readonly onRestored: (document: RemoteDocument) => void;
  },
) {
  const { revisions, error, setError } = useRevisions(props);
  const restore = async (revision: RemoteRevision, close: () => void) => {
    const when = relativeTime(revision.timestamp);
    const confirmed = await confirmDialog({
      title: 'Restore this version?',
      body: `The item as it was ${when} becomes its draft. Publish it to put it live.`,
      confirmLabel: 'Restore',
    });
    if (!confirmed) {
      return;
    }
    const result = await restoreRemoteRevision(props.projectPath, props.connectionId, {
      id: props.document.id,
      revision: revision.id,
    });
    if (result.ok) {
      props.onRestored(result.value);
      close();
    } else {
      setError(result.message);
    }
  };
  return (
    <Popup
      className="modal remote-cms-history"
      label="History"
      onClose={props.onClose}
      dismissible={true}
    >
      {({ close }) => (
        <>
          <div className="modal-header cms-modal-header">
            <span>History</span>
            <button className="ghost" title="Close" onClick={close}>
              <CloseIcon size={12} />
            </button>
          </div>
          <div className="modal-body remote-cms-history-body">
            {error && <ErrorToast message={error} />}
            {revisions === undefined && <p className="remote-cms-note">Loading…</p>}
            {revisions?.length === 0 && !error && (
              <p className="remote-cms-note">No history yet.</p>
            )}
            {revisions?.map((revision, index) => (
              <RevisionRow
                key={revision.id}
                revision={revision}
                current={index === 0}
                onRestore={() => void restore(revision, close)}
              />
            ))}
          </div>
        </>
      )}
    </Popup>
  );
}

function RevisionRow(props: {
  readonly revision: RemoteRevision;
  readonly current: boolean;
  readonly onRestore: () => void;
}) {
  return (
    <div className="remote-cms-revision">
      <span className="remote-cms-revision-time">{relativeTime(props.revision.timestamp)}</span>
      <span className="remote-cms-revision-author">{props.revision.author}</span>
      {props.current ? (
        <span className="remote-cms-revision-now">Current</span>
      ) : (
        <button type="button" onClick={props.onRestore}>
          Restore
        </button>
      )}
    </div>
  );
}

function useRevisions(props: Pick<Props, 'projectPath' | 'connectionId' | 'document'>) {
  const [revisions, setRevisions] = useState<readonly RemoteRevision[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const id = props.document.id;
  useEffect(() => {
    let active = true;
    void remoteHistory(props.projectPath, props.connectionId, id).then((result) => {
      if (active) {
        setRevisions(result.ok ? result.value : []);
        setError(result.ok ? undefined : result.message);
      }
    });
    return () => {
      active = false;
    };
  }, [props.projectPath, props.connectionId, id]);
  return { revisions, error, setError };
}
