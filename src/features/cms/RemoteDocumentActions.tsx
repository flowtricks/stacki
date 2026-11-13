// What Sanity Studio's document footer offers, in the item header: Publish
// (blocked while a rule the schema states is broken, with what to fix), and a
// menu to discard the unpublished changes, unpublish, or open the history to
// restore an earlier version. Discard and unpublish confirm first; a restored
// version becomes the draft and is not published until Publish is pressed.
import { useEffect, useState } from 'react';
import type { RemoteDocument, RemoteRevision } from '../../../shared/properties/cmsRemote';
import type { RemoteDocumentAction } from '../../../shared/properties/cmsRemote';
import { actOnRemoteDocument, remoteHistory, restoreRemoteRevision } from '../../ipc/cmsConnectionsBridge';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { SkeletonRows } from '../../ui/Skeleton';
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

// The words of each confirm are keys, translated when the dialog opens.
const CONFIRMS: Readonly<
  Record<
    Exclude<RemoteDocumentAction, 'publish'>,
    {
      readonly title: MessageKey;
      readonly body: MessageKey;
      readonly confirmLabel: MessageKey;
    }
  >
> = {
  discard: {
    title: 'cmsRemote.actions.discardTitle',
    body: 'cmsRemote.actions.discardBody',
    confirmLabel: 'cmsRemote.actions.discardConfirm',
  },
  unpublish: {
    title: 'cmsRemote.actions.unpublishTitle',
    body: 'cmsRemote.actions.unpublishBody',
    confirmLabel: 'cmsRemote.actions.unpublishConfirm',
  },
};

export function RemoteDocumentActions(props: Props) {
  const { document } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [busy, setBusy] = useState<RemoteDocumentAction | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState(false);
  const blockers = publishBlockers(document, translate);
  const draft = document.editedAt !== undefined || document.status !== 'published';
  const act = async (action: RemoteDocumentAction) => {
    if (action !== 'publish') {
      const confirm = CONFIRMS[action];
      const confirmed = await confirmDialog({
        title: translate(confirm.title),
        body: translate(confirm.body),
        confirmLabel: translate(confirm.confirmLabel),
        danger: true,
      });
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
      setError(translateDescribed(result));
    }
  };
  return (
    <div className="remote-cms-actions">
      {error && <ErrorToast message={error} />}
      <MoreMenu
        title={translate('cmsRemote.actions.more')}
        width={180}
        items={[
          { label: translate('cmsRemote.actions.history'), icon: <HistoryIcon size={13} />, onSelect: () => setHistory(true) },
          draft && {
            label: translate('cmsRemote.actions.discard'),
            icon: <ResetIcon size={13} />,
            danger: true,
            onSelect: () => void act('discard'),
          },
          document.publishedAt !== undefined && {
            label: translate('cmsRemote.actions.unpublish'),
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
        title={blockers.length > 0 ? translate('cmsRemote.actions.fixBeforePublishing', { problems: blockers.join('\n') }) : undefined}
        onClick={() => void act('publish')}
      >
        {busy === 'publish' ? translate('cmsRemote.actions.publishing') : translate(draft ? 'cmsRemote.actions.publish' : 'cmsRemote.status.published')}
      </button>
      {history && <HistoryDialog {...props} onClose={() => setHistory(false)} onRestored={props.onChanged} />}
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
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const format = useFormat();
  const { revisions, error, setError } = useRevisions(props);
  const restore = async (revision: RemoteRevision, close: () => void) => {
    const when = relativeTime(revision.timestamp, Date.now(), { translate, format });
    const confirmed = await confirmDialog({
      title: translate('cmsRemote.actions.restoreTitle'),
      body: translate('cmsRemote.actions.restoreBody', { when }),
      confirmLabel: translate('cmsRemote.actions.restore'),
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
      setError(translateDescribed(result));
    }
  };
  return (
    <Popup className="modal remote-cms-history" label={translate('cmsRemote.actions.history')} onClose={props.onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header cms-modal-header">
            <span>{translate('cmsRemote.actions.history')}</span>
            <button className="ghost" title={translate('ui.close')} onClick={close}>
              <CloseIcon size={12} />
            </button>
          </div>
          <div className="modal-body remote-cms-history-body">
            {error && <ErrorToast message={error} />}
            {revisions === undefined && (
              <div className="remote-cms-note">
                <SkeletonRows count={3} />
              </div>
            )}
            {revisions?.length === 0 && !error && <p className="remote-cms-note">{translate('cmsRemote.actions.noHistory')}</p>}
            {revisions?.map((revision, index) => (
              <RevisionRow key={revision.id} revision={revision} current={index === 0} onRestore={() => void restore(revision, close)} />
            ))}
          </div>
        </>
      )}
    </Popup>
  );
}

function RevisionRow(props: { readonly revision: RemoteRevision; readonly current: boolean; readonly onRestore: () => void }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const format = useFormat();
  return (
    <div className="remote-cms-revision">
      <span className="remote-cms-revision-time">{relativeTime(props.revision.timestamp, Date.now(), { translate, format })}</span>
      <span className="remote-cms-revision-author">{translateDescribed({ message: props.revision.author, messageRef: props.revision.authorRef })}</span>
      {props.current ? (
        <span className="remote-cms-revision-now">{translate('cmsRemote.actions.current')}</span>
      ) : (
        <button type="button" onClick={props.onRestore}>
          {translate('cmsRemote.actions.restore')}
        </button>
      )}
    </div>
  );
}

function useRevisions(props: Pick<Props, 'projectPath' | 'connectionId' | 'document'>) {
  const translateDescribed = useTranslateDescribed();
  const [revisions, setRevisions] = useState<readonly RemoteRevision[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const id = props.document.id;
  useEffect(() => {
    let active = true;
    void remoteHistory(props.projectPath, props.connectionId, id).then((result) => {
      if (active) {
        setRevisions(result.ok ? result.value : []);
        setError(result.ok ? undefined : translateDescribed(result));
      }
    });
    return () => {
      active = false;
    };
  }, [props.projectPath, props.connectionId, id, translateDescribed]);
  return { revisions, error, setError };
}
