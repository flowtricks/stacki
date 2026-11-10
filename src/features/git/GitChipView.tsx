import { GitPullControl } from './GitPullControl';
import type { GitIncomingState } from './useGitIncoming';
import React from 'react';
import { gitBranchColors, gitBranchColor } from '../../lib/gitBranchColors';
import type { WireGitInfo } from '../../../shared/ipc/ipcResults';
import BranchCreate from './BranchCreate';
import BranchActions from './BranchActions';
import type FileBrowser from './FileBrowser';
import CommitFilePicker from './CommitFilePicker';
import { CommitSubjectPreview, CommitTypeDetails, CommitTypeScopeError, CommitTypeSelect, type CommitTypeControl } from './CommitTypePicker';
import { BranchIcon } from '../../ui/Icons';
import Tooltip from '../../ui/Tooltip';

type ChangedFiles = React.ComponentProps<typeof FileBrowser>['files'];

interface GitChipViewProps {
  readonly info: WireGitInfo;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly commitMessage: string;
  readonly commitType: CommitTypeControl;
  /** The subject a commit would carry now; undefined while the scope is invalid. */
  readonly commitSubject: string | undefined;
  readonly newBranch: string;
  readonly picking: boolean;
  readonly picked: readonly string[] | undefined;
  readonly changed: ChangedFiles;
  readonly onDismissError: () => void;
  readonly onSwitch: (branch: string) => void;
  readonly onMerge: (branch: string) => void;
  readonly onDelete: (branch: string) => void;
  readonly onNewBranch: (value: string) => void;
  readonly onCreateBranch: (branch: string) => void;
  readonly onCommitMessage: (value: string) => void;
  readonly onRefreshFiles: () => void;
  readonly onTogglePicking: () => void;
  readonly onPick: (paths: readonly string[]) => void;
  readonly onCommit: () => void;
  readonly onPull: () => void;
  readonly incoming: GitIncomingState;
}

interface BranchesProps {
  readonly colors: ReadonlyMap<string, number>;
  readonly info: WireGitInfo;
  readonly working: boolean;
  readonly newBranch: string;
  readonly onSwitch: (branch: string) => void;
  readonly onMerge: (branch: string) => void;
  readonly onDelete: (branch: string) => void;
  readonly onNewBranch: (value: string) => void;
  readonly onCreateBranch: (branch: string) => void;
}

interface CommitProps {
  readonly branch: string;
  readonly color: number;
  readonly error: string | undefined;
  readonly dirty: boolean;
  readonly working: boolean;
  readonly message: string;
  readonly commitType: CommitTypeControl;
  readonly subject: string | undefined;
  readonly picking: boolean;
  readonly picked: readonly string[] | undefined;
  readonly changed: ChangedFiles;
  readonly onMessage: (value: string) => void;
  readonly onRefreshFiles: () => void;
  readonly onTogglePicking: () => void;
  readonly onPick: (paths: readonly string[]) => void;
  readonly onCommit: () => void;
}

function Branches({ colors, info, working, newBranch, onSwitch, onMerge, onDelete, onNewBranch, onCreateBranch }: BranchesProps) {
  return (
    <section className="git-branches" aria-label="Branches">
      <div className="history-branches-heading">
        <h3>Branches</h3>
        <span>{info.branches.length} local</span>
      </div>
      <div className="git-branch-list">
        {info.branches.map((branch) => (
          <BranchRow key={branch} branch={branch} colors={colors} info={info} working={working} onSwitch={onSwitch} onMerge={onMerge} onDelete={onDelete} />
        ))}
      </div>
      <BranchCreate branches={info.branches} working={working} name={newBranch} onName={onNewBranch} onCreate={onCreateBranch} />
    </section>
  );
}

function BranchRow({
  colors,
  branch,
  info,
  working,
  onSwitch,
  onMerge,
  onDelete,
}: Pick<BranchesProps, 'info' | 'colors' | 'working' | 'onSwitch' | 'onMerge' | 'onDelete'> & {
  readonly branch: string;
}) {
  const current = branch === info.branch;
  return (
    <div className={`history-branch-row ${current ? 'active' : ''}`}>
      <button
        className="history-branch-switch"
        disabled={working || current}
        aria-current={current ? true : undefined}
        aria-label={current ? `${branch}, current branch` : `Switch to ${branch}`}
        onClick={() => onSwitch(branch)}
      >
        <span className="history-branch-icon" style={{ color: gitBranchColor(colors.get(branch) ?? 0) }}>
          <BranchIcon size={14} />
        </span>
        <Tooltip className="history-branch-name" text={branch} />
        {info.parked.includes(branch) && !current && (
          <span className="branch-parked" title="Changes waiting on this branch">
            Saved changes
          </span>
        )}
      </button>
      <BranchActions branch={branch} current={info.branch} trunk={info.trunk} disabled={working} onMerge={onMerge} onDelete={onDelete} />
    </div>
  );
}

function CommitControls({
  branch,
  color,
  dirty,
  working,
  message,
  commitType,
  subject,
  picking,
  picked,
  changed,
  onMessage,
  onTogglePicking,
  onRefreshFiles,
  onPick,
  onCommit,
  error,
}: CommitProps) {
  const pickedCount = picked?.length ?? 0;
  const blocked = commitType.state.kind === 'invalid';
  const label = !dirty ? 'Nothing to commit' : !picking ? 'Commit all changes' : `Commit ${pickedCount} file${pickedCount === 1 ? '' : 's'}`;
  return (
    <>
      <div className="divider" />
      <h3 className="git-commit-destination">
        Commit to{' '}
        <span className={`history-graph-color-${color}`} style={{ color: gitBranchColor(color) }}>
          <BranchIcon size={12} />
          {branch}
        </span>
      </h3>
      <div className="dropdown-row" style={{ flexDirection: 'column', gap: 6 }}>
        <input
          placeholder="Commit message"
          aria-label="Commit message"
          disabled={working}
          value={message}
          onChange={(event) => onMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && dirty && !working && !blocked) {
              onCommit();
            }
          }}
        />
        {/* The message keeps the full width; the optional type and its scope share the row beneath. */}
        <div className="git-commit-type-row">
          <CommitTypeSelect control={commitType} disabled={working} />
          <CommitTypeDetails control={commitType} disabled={working} />
        </div>
        <CommitTypeScopeError control={commitType} />
        <CommitSubjectPreview subject={subject} convention={commitType.state.kind === 'ready' ? commitType.state.convention : undefined} />
        <div className="git-commit-action-row">
          <button className="primary" disabled={working || blocked || !dirty || (picking && pickedCount === 0)} onClick={onCommit}>
            {label}
          </button>
          {dirty && (
            <CommitFilePicker
              files={changed}
              picked={picked}
              picking={picking}
              working={working}
              error={error}
              onTogglePicking={onTogglePicking}
              onRefresh={onRefreshFiles}
              onPick={onPick}
            />
          )}
        </div>
      </div>
    </>
  );
}

export default function GitChipView(props: GitChipViewProps) {
  const working = props.busy !== undefined;
  const colors = gitBranchColors(props.info.branches, props.info.trunk ?? 'main');
  return (
    <div className="git-panel-controls" aria-label="Repository controls">
      {props.busy && (
        <p className="history-note" role="status">
          {props.busy}
        </p>
      )}

      {props.info.remote && <GitPullControl incoming={props.incoming} busy={props.busy} info={props.info} onPull={props.onPull} />}
      <Branches
        colors={colors}
        info={props.info}
        working={working}
        newBranch={props.newBranch}
        onSwitch={props.onSwitch}
        onMerge={props.onMerge}
        onDelete={props.onDelete}
        onNewBranch={props.onNewBranch}
        onCreateBranch={props.onCreateBranch}
      />
      <CommitControls
        branch={props.info.branch}
        color={colors.get(props.info.branch) ?? 0}
        error={props.error}
        onRefreshFiles={props.onRefreshFiles}
        dirty={props.info.dirty}
        working={working}
        message={props.commitMessage}
        commitType={props.commitType}
        subject={props.commitSubject}
        picking={props.picking}
        picked={props.picked}
        changed={props.changed}
        onMessage={props.onCommitMessage}
        onTogglePicking={props.onTogglePicking}
        onPick={props.onPick}
        onCommit={props.onCommit}
      />
    </div>
  );
}
