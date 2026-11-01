import Popup from '../../ui/Popup';
import React, { useState } from 'react';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';

export interface SwitchBranchProps {
  readonly from: string;
  readonly to: string;
  readonly files: readonly string[];
  readonly busy: string | undefined;
  readonly onCancel: () => void;
  readonly onLeaveHere: () => void;
  readonly onCommitFirst: (message: string) => void;
}
// Shown when a branch switch would drag uncommitted work along. Deliberately
// has no default action: taking changes with you and leaving them behind are
// both reasonable, and picking one silently is how the edits ended up on the
// wrong branch in the first place.
export default function SwitchBranchModal(props: SwitchBranchProps) {
  assert(props.files.length <= BOUNDARY_LIMITS.itemsMax, 'Branch switch: file limit exceeded');
  const [message, setMessage] = useState('');
  return <SwitchBranchBody {...props} message={message} setMessage={setMessage} />;
}
function SwitchBranchBody({
  from,
  to,
  files,
  busy,
  onCancel,
  onLeaveHere,
  onCommitFirst,
  message,
  setMessage,
}: SwitchBranchProps & {
  readonly message: string;
  readonly setMessage: (value: string) => void;
}) {
  const working = !!busy;

  return (
    <Popup className="modal" onClose={onCancel} dismissible={!working}>
      {({ close }) => (
        <>
          <div className="modal-header">These changes can’t come with you</div>
          <div className="modal-body">
            <div className="hint-text">
              {from} and {to} have different versions of {files.length === 1 ? 'this file' : 'these files'}, so your unsaved work can’t follow you across. It
              can wait here until you come back — no commit needed.
            </div>

            <SwitchBranchFiles files={files} />

            <div>
              <label>Or commit them first</label>
              <input
                autoFocus
                maxLength={BOUNDARY_LIMITS.textLengthMax}
                placeholder={`Update ${from}`}
                value={message}
                disabled={working}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !working) {
                    onCommitFirst(message.trim() || `Update ${from}`);
                  }
                }}
              />
            </div>

            {working && (
              <div className="publish-progress">
                <span className="mini-spinner" />
                <span>{busy}</span>
              </div>
            )}
          </div>
          <SwitchBranchFooter from={from} busy={busy} onCancel={close} onLeaveHere={onLeaveHere} onCommitFirst={onCommitFirst} message={message} />
        </>
      )}
    </Popup>
  );
}

function SwitchBranchFooter({
  from,
  busy,
  onCancel,
  onLeaveHere,
  onCommitFirst,
  message,
}: Pick<SwitchBranchProps, 'from' | 'busy' | 'onCancel' | 'onLeaveHere' | 'onCommitFirst'> & {
  readonly message: string;
}) {
  const working = Boolean(busy);
  return (
    <div className="modal-footer">
      <button onClick={onCancel} disabled={working}>
        Cancel
      </button>
      <button onClick={() => onCommitFirst(message.trim() || `Update ${from}`)} disabled={working} title={`Commit to ${from}, then switch`}>
        Commit first
      </button>
      <button className="primary" disabled={working} onClick={onLeaveHere} title={`Set them aside on ${from} and pick them up when you return`}>
        Leave them on {from}
      </button>
    </div>
  );
}

function SwitchBranchFiles({ files }: Pick<SwitchBranchProps, 'files'>) {
  assert(files.length <= BOUNDARY_LIMITS.itemsMax, 'Branch switch: file limit exceeded');
  const shown = files.slice(0, 5);
  const rest = files.length - shown.length;
  if (shown.length === 0) {
    return undefined;
  }
  return (
    <ul className="dirty-files">
      {shown.map((file) => (
        <li key={file}>{file}</li>
      ))}
      {rest > 0 && <li className="more">+{rest} more</li>}
    </ul>
  );
}
