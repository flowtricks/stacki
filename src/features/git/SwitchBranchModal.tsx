import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import React, { useState } from 'react';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';
import { buildCommitSubject, COMMIT_CONVENTION_NONE, type CommitConvention } from './commitType';
import { CommitSubjectPreview } from './CommitTypePicker';

export interface SwitchBranchProps {
  readonly from: string;
  readonly to: string;
  readonly files: readonly string[];
  readonly busy: string | undefined;
  /** The Git panel's commit type, applied to "Commit first"; none when the panel has none picked. */
  readonly convention?: CommitConvention;
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
  convention = COMMIT_CONVENTION_NONE,
  onCancel,
  onLeaveHere,
  onCommitFirst,
  message,
  setMessage,
}: SwitchBranchProps & {
  readonly message: string;
  readonly setMessage: (value: string) => void;
}) {
  const translate = useTranslate();
  const working = !!busy;

  return (
    <Popup className="modal" onClose={onCancel} dismissible={!working}>
      {({ close }) => (
        <>
          <div className="modal-header">{translate('git.switch.title')}</div>
          <div className="modal-body">
            <div className="hint-text">{translate('git.switch.body', { count: files.length, from, to })}</div>

            <SwitchBranchFiles files={files} />

            <div>
              <label>{translate('git.switch.commitFirstLabel')}</label>
              <input
                autoFocus
                maxLength={BOUNDARY_LIMITS.textLengthMax}
                // i18n-ignore: the default commit message Stacki writes into the user's git history stays English.
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
              <CommitSubjectPreview convention={convention} subject={buildCommitSubject(message, convention, `Update ${from}`)} />
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
  const translate = useTranslate();
  const working = Boolean(busy);
  return (
    <div className="modal-footer">
      <button onClick={onCancel} disabled={working}>
        {translate('ui.cancel')}
      </button>
      <button onClick={() => onCommitFirst(message.trim() || `Update ${from}`)} disabled={working} title={translate('git.switch.commitFirstTitle', { from })}>
        {translate('git.switch.commitFirst')}
      </button>
      <button className="primary" disabled={working} onClick={onLeaveHere} title={translate('git.switch.leaveTitle', { from })}>
        {translate('git.switch.leave', { from })}
      </button>
    </div>
  );
}

function SwitchBranchFiles({ files }: Pick<SwitchBranchProps, 'files'>) {
  const translate = useTranslate();
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
      {rest > 0 && <li className="more">{translate('git.switch.more', { count: rest })}</li>}
    </ul>
  );
}
