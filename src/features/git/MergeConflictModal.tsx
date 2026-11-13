import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import type { CSSProperties } from 'react';
import type { Conflict, ConflictChoices } from './gitConflictModel';
import { conflictDraftsForSend } from './conflictDraft';
import { useMergeConflict } from './useMergeConflict';
import type { MergeConflictModel } from './useMergeConflict';
import { MergeConflictDetail } from './MergeConflictDetail';

export interface MergeConflictProps {
  readonly conflict: Conflict;
  readonly branches?: readonly string[];
  readonly trunk?: string;
  readonly busy: string | undefined;
  readonly onCancel: () => void;
  readonly onResolve: (choices: ConflictChoices) => void;
}
interface MergeColors extends CSSProperties {
  readonly '--merge-ours': string;
  readonly '--merge-theirs': string;
}
export default function MergeConflictModal(props: MergeConflictProps) {
  const translate = useTranslate();
  const model = useMergeConflict(props.conflict, props.branches ?? [], props.trunk ?? 'main');
  const working = props.busy !== undefined;
  const style: MergeColors = {
    '--merge-ours': model.colors.ours,
    '--merge-theirs': model.colors.theirs,
  };
  return (
    <Popup className="modal conflict-modal" style={style} label={translate('git.conflict.review')} onClose={props.onCancel} dismissible={!working}>
      {({ close }) => (
        <>
          <div className="merge-heading">
            <div>
              <h2>{translate('git.conflict.review')}</h2>
              <p>{translate('git.conflict.intro')}</p>
            </div>
            <div className="merge-direction">
              <span className="merge-branch-theirs">{props.conflict.branch}</span>
              <span aria-label={translate('git.conflict.into')}>→</span>
              <span className="merge-branch-ours">{model.ours}</span>
            </div>
          </div>
          <div className="conflict-split">
            <ConflictFiles model={model} />
            <MergeConflictDetail model={model} conflict={props.conflict} working={working} />
          </div>
          <div className="modal-footer merge-footer">
            <span className="merge-status" role="status">
              {working
                ? props.busy
                : model.pending > 0
                  ? translate('git.conflict.choicesToReview', { count: model.pending })
                  : translate('git.conflict.readyToMerge')}
            </span>
            <button onClick={close} disabled={working}>
              {translate('ui.cancel')}
            </button>
            <button
              className="primary"
              disabled={working || model.pending > 0}
              onClick={() => props.onResolve(conflictDraftsForSend(props.conflict, model.drafts, model.whole))}
            >
              {translate('git.conflict.mergeResult')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function ConflictFiles({ model }: { readonly model: MergeConflictModel }) {
  const translate = useTranslate();
  return (
    <nav className="conflict-files" aria-label={translate('git.conflict.filesLabel')}>
      <div className="merge-files-heading">{translate('git.conflict.changedFiles')}</div>
      {Object.keys(model.drafts).length === 0 && <span className="hint-text">{translate('git.conflict.chooseVersion')}</span>}
      {/* File identities come from the original conflict, including non-text files. */}
      {model.files.map((file) => {
        const pending = model.pendingFor(file.path);
        return (
          <button
            key={file.path}
            title={file.path}
            className={`conflict-file-row ${file.path === model.file.path ? 'on' : ''}`}
            aria-current={file.path === model.file.path ? 'true' : undefined}
            onClick={() => model.setOpenPath(file.path)}
          >
            <span className="conflict-file-name">{file.path.split('/').pop()}</span>
            <span className="conflict-file-dir">{file.path.split('/').slice(0, -1).join('/')}</span>
            <span className={`conflict-file-badge ${pending > 0 ? 'warn' : ''}`}>
              {pending > 0 ? translate('git.conflict.toReview', { count: pending }) : translate('git.conflict.ready')}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
