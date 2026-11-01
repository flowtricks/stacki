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
  const model = useMergeConflict(props.conflict, props.branches ?? [], props.trunk ?? 'main');
  const working = props.busy !== undefined;
  const style: MergeColors = {
    '--merge-ours': model.colors.ours,
    '--merge-theirs': model.colors.theirs,
  };
  return (
    <Popup className="modal conflict-modal" style={style} label="Review merge" onClose={props.onCancel} dismissible={!working}>
      {({ close }) => (
        <>
          <div className="merge-heading">
            <div>
              <h2>Review merge</h2>
              <p>Independent changes are combined. Review highlights or edit the final code.</p>
            </div>
            <div className="merge-direction">
              <span className="merge-branch-theirs">{props.conflict.branch}</span>
              <span aria-label="into">→</span>
              <span className="merge-branch-ours">{model.ours}</span>
            </div>
          </div>
          <div className="conflict-split">
            <ConflictFiles model={model} />
            <MergeConflictDetail model={model} conflict={props.conflict} working={working} />
          </div>
          <div className="modal-footer merge-footer">
            <span className="merge-status" role="status">
              {working ? props.busy : model.pending > 0 ? `${model.pending} ${model.pending === 1 ? 'choice' : 'choices'} to review` : 'Ready to merge'}
            </span>
            <button onClick={close} disabled={working}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={working || model.pending > 0}
              onClick={() => props.onResolve(conflictDraftsForSend(props.conflict, model.drafts, model.whole))}
            >
              Merge result
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

function ConflictFiles({ model }: { readonly model: MergeConflictModel }) {
  return (
    <nav className="conflict-files" aria-label="Files to merge">
      <div className="merge-files-heading">Changed files</div>
      {Object.keys(model.drafts).length === 0 && <span className="hint-text">Choose a version to keep.</span>}
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
            <span className={`conflict-file-badge ${pending > 0 ? 'warn' : ''}`}>{pending > 0 ? `${pending} to review` : 'Ready'}</span>
          </button>
        );
      })}
    </nav>
  );
}
