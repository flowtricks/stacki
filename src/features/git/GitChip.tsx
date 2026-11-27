import type { GitIncomingState } from './useGitIncoming';
import React, { useEffect, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { IpcResults, WireGitInfo } from '../../../shared/ipc/ipcResults';
import { gitValue, type GitHost, type GitSession, type PendingConflict, type RunAction } from './useGitSession';
import { assert } from '../../../shared/core/assert';
import { translateFailure, translateReference } from '../../lib/i18n/translateErrorText';
import { deleteBranchAction, mergeBranchAction } from './gitActions';
import { checkoutGitBranch, commitGitChanges, initializeGit, readGitStatus } from './gitChipBridge';
import { BranchIcon } from '../../ui/Icons';
import { SkeletonRows } from '../../ui/Skeleton';
import GitChipView from './GitChipView';
import { buildCommitSubject } from './commitType';
import { commitTypeConvention, useCommitType, type CommitTypeControl } from './CommitTypePicker';
import type { CommitConvention } from './commitType';
import SwitchBranchModal from './SwitchBranchModal';

interface GitChipProps {
  /** The shared lock, pull path and merge review (useGitSession.ts); its review is drawn by GitSessionDialogs. */
  readonly session: GitSession;
  readonly incoming?: GitIncomingState;
  readonly withBranchChange?: <Value>(work: () => Promise<Value>) => Promise<Value>;
  /** The chord that pulls from anywhere, where the editor has one; the pull button's tooltip names it. */
  readonly pullShortcut?: string | undefined;
  /** What changes when the host sees the working tree change, so the list of changes follows it. */
  readonly changesSignal?: unknown;
  /** Opens a changed file from that list, where the host has somewhere to open it. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
}

interface RepositoryProps extends Pick<GitHost, 'project' | 'showToast'>, Omit<GitChipProps, 'session'> {
  readonly session: GitSession;
  readonly translate: Translator;
  readonly info: WireGitInfo;
  readonly runAction: RunAction;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly setError: React.Dispatch<React.SetStateAction<string | undefined>>;
}

interface SwitchTarget {
  readonly branch: string;
  readonly files: readonly string[];
}

export default function GitChip({ session, ...rest }: GitChipProps) {
  const translate = useTranslate();
  const { host, busy, setError, runAction } = session;
  // A failure from before the panel opened was already said by its toast; the panel opens clean.
  useEffect(() => setError(undefined), [setError]);
  const { info, project, showToast } = host;
  if (!info) {
    return <SkeletonRows count={1} />;
  }
  if (!info.isRepo) {
    return <InitializeGitChip projectPath={project.path} busy={busy} runAction={runAction} translate={translate} />;
  }
  return (
    <RepositoryGitChip
      {...rest}
      session={session}
      project={project}
      showToast={showToast}
      translate={translate}
      info={info}
      runAction={runAction}
      busy={busy}
      error={session.error}
      setError={setError}
    />
  );
}

function InitializeGitChip({
  projectPath,
  busy,
  runAction,
  translate,
}: {
  readonly projectPath: string;
  readonly busy: string | undefined;
  readonly runAction: RunAction;
  readonly translate: Translator;
}) {
  const initialize = (): void => {
    void runAction(
      async () => {
        await gitValue(initializeGit(projectPath));
      },
      translate('git.chip.initialized'),
      translate('git.busy.initializing'),
    );
  };
  return (
    <button className="primary git-initialize" disabled={busy !== undefined} onClick={initialize}>
      {busy ? <span className="mini-spinner" /> : <BranchIcon size={12} />}
      {busy ?? translate('git.chip.initialize')}
    </button>
  );
}

function RepositoryGitChip(props: RepositoryProps) {
  const state = useRepositoryState(props.session);
  useChangedFiles(props, state);
  const commitType = useCommitType(props.project);
  const actions = useRepositoryActions(props, state, commitType);
  const commit = useCommitAction(props, state, commitType);
  const subject = commitType.state.kind === 'ready' ? buildCommitSubject(state.commitMessage, commitType.state.convention, COMMIT_MESSAGE_FALLBACK) : undefined;
  return (
    <>
      <GitChipView
        changes={{
          projectPath: props.project.path,
          info: props.info,
          signal: props.changesSignal,
          onOpenFile: props.onOpenFile,
          showToast: props.showToast,
        }}
        info={props.info}
        busy={props.busy}
        error={props.error}
        commitMessage={state.commitMessage}
        commitType={commitType}
        commitSubject={subject}
        newBranch={state.newBranch}
        picking={state.picking}
        picked={state.picked}
        changed={state.changed}
        onDismissError={() => props.setError(undefined)}
        onSwitch={actions.requestSwitch}
        onMerge={actions.mergeBranch}
        onDelete={actions.deleteBranch}
        onNewBranch={state.setNewBranch}
        onCreateBranch={actions.createBranch}
        onCommitMessage={state.setCommitMessage}
        onTogglePicking={() => state.setPicking((value) => !value)}
        onRefreshFiles={() => state.setSelectionRevision((value) => value + 1)}
        onPick={state.setPicked}
        onCommit={commit}
        onPull={() => props.session.pull(incomingCommits(props.incoming))}
        incoming={props.incoming ?? { kind: 'checking' }}
        pullShortcut={props.pullShortcut}
        pullAccess={props.session.host.pullAccess}
      />
      <GitModals
        {...props}
        switchTo={state.switchTo}
        setSwitchTo={state.setSwitchTo}
        parkThenSwitch={actions.parkThenSwitch}
        commitThenSwitch={actions.commitThenSwitch}
        switchConvention={commitTypeConvention(commitType)}
      />
    </>
  );
}

function incomingCommits(incoming: GitIncomingState | undefined): number | undefined {
  return incoming?.kind === 'ready' ? incoming.commits : undefined;
}

function useRepositoryState({ setConflict }: GitSession) {
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [switchTo, setSwitchTo] = useState<SwitchTarget | undefined>(undefined);
  // The files picked for a partial commit; undefined until the picker loads them.
  const [picked, setPicked] = useState<readonly string[] | undefined>(undefined);
  const [changed, setChanged] = useState<IpcResults['git:status']>([]);
  const [picking, setPicking] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  return {
    commitMessage,
    newBranch,
    switchTo,
    changed,
    picked,
    picking,
    selectionRevision,
    setSelectionRevision,
    setCommitMessage,
    setNewBranch,
    setSwitchTo,
    setConflict,
    setChanged,
    setPicked,
    setPicking,
  } as const;
}

interface ChangedState {
  readonly selectionRevision: number;
  readonly picking: boolean;
  readonly setChanged: React.Dispatch<React.SetStateAction<IpcResults['git:status']>>;
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | undefined>>;
}

function useChangedFiles(props: RepositoryProps, state: ChangedState): void {
  const { picking, selectionRevision, setChanged, setPicked } = state;
  const { info, project, setError, translate } = props;
  useEffect(() => {
    if (!picking) {
      return;
    }
    let active = true;
    setError(undefined);
    void readGitStatus(project.path).then((result) => {
      if (!active) {
        return;
      }
      if (!result.ok) {
        setError(translateFailure(result, translate));
        setChanged([]);
        setPicked([]);
        return;
      }
      setChanged(result.value);
      const paths = result.value.map((file) => file.path);
      const available = new Set(paths);
      setPicked((current) => current?.filter((path) => available.has(path)) ?? paths);
    });
    return () => {
      active = false;
    };
  }, [info, setError, selectionRevision, project.path, picking, setChanged, setPicked, translate]);
}

interface ActionState {
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
  readonly setNewBranch: React.Dispatch<React.SetStateAction<string>>;
}

function useRepositoryActions(props: RepositoryProps, state: ActionState, commitType: CommitTypeControl) {
  const requestSwitch = (branch: string): void => {
    if (branch === props.info.branch) {
      return;
    }
    void props.runAction(() => switchBranch(props, state, branch), undefined, props.translate('git.busy.switching'));
  };
  const mergeBranch = (branch: string): void => {
    void mergeBranchAction({
      projectPath: props.project.path,
      branch,
      into: props.info.branch,
      trunk: props.info.trunk,
      run: (work, label) => void props.runAction(work, undefined, label),
      showToast: props.showToast,
      translate: props.translate,
      onConflict: (next) => {
        state.setConflict(next);
      },
    });
  };
  const deleteBranch = (branch: string): void => {
    void deleteBranchAction({
      projectPath: props.project.path,
      branch,
      parked: props.info.parked.includes(branch),
      run: (work, label) => void props.runAction(work, undefined, label),
      showToast: props.showToast,
      translate: props.translate,
    });
  };
  return {
    requestSwitch,
    mergeBranch,
    deleteBranch,
    createBranch: (branch: string) => createNamedBranch(props, state, branch),
    parkThenSwitch: (branch: string) => parkAndSwitch(props, branch),
    commitThenSwitch: (branch: string, message: string) =>
      commitAndSwitch(props, branch, buildCommitSubject(message, commitTypeConvention(commitType), message)),
  } as const;
}

async function switchBranch(props: RepositoryProps, state: ActionState, branch: string): Promise<void> {
  const result = await checkoutBranch(props, branch, { kind: 'switch' });
  if (!result.ok) {
    state.setSwitchTo({ branch, files: result.files });
    return;
  }
  if (result.error) {
    props.showToast(translateReference(result.error, result.errorRef, props.translate), 'error');
  } else if (result.restored) {
    props.showToast(props.translate('git.chip.pickedUp', { branch }), 'success');
  } else if (result.parked) {
    props.showToast(props.translate('git.chip.waiting', { branch, from: result.from }), 'success');
  } else {
    props.showToast(props.translate('git.chip.switched', { branch }), 'success');
  }
}

function checkoutBranch(props: RepositoryProps, branch: string, mode: Parameters<typeof checkoutGitBranch>[2]) {
  const work = () => gitValue(checkoutGitBranch(props.project.path, branch, mode));
  return props.withBranchChange ? props.withBranchChange(work) : work();
}

function createNamedBranch(props: RepositoryProps, state: ActionState, branch: string): void {
  state.setNewBranch('');
  void props.runAction(
    async () => {
      const result = await checkoutBranch(props, branch, { kind: 'create' });
      assert(result.ok, 'Creating a branch cannot return a blocked checkout');
    },
    props.translate('git.chip.created', { branch }),
    props.translate('git.busy.creating'),
  );
}

async function parkAndSwitch(props: RepositoryProps, branch: string): Promise<boolean> {
  const from = props.info.branch;
  return props.runAction(
    async () => {
      const result = await checkoutBranch(props, branch, { kind: 'park' });
      assert(result.ok, 'Parking before checkout cannot return a blocked checkout');
      if (result.error) {
        props.showToast(translateReference(result.error, result.errorRef, props.translate), 'error');
      } else if (result.restored) {
        props.showToast(props.translate('git.chip.pickedUp', { branch }), 'success');
      }
    },
    props.translate('git.chip.waiting', { branch, from }),
    props.translate('git.busy.switching'),
  );
}

function commitAndSwitch(props: RepositoryProps, branch: string, message: string): Promise<boolean> {
  const from = props.info.branch;
  return props.runAction(
    async () => {
      await gitValue(commitGitChanges(props.project.path, message));
      const result = await checkoutBranch(props, branch, { kind: 'switch' });
      assert(result.ok, 'Committed work must permit the requested checkout');
    },
    props.translate('git.chip.committedSwitched', { from, branch }),
    props.translate('git.busy.committing'),
  );
}

interface CommitState {
  readonly commitMessage: string;
  readonly picking: boolean;
  readonly picked: readonly string[] | undefined;
  readonly changed: IpcResults['git:status'];
  readonly setCommitMessage: React.Dispatch<React.SetStateAction<string>>;
  readonly setPicked: React.Dispatch<React.SetStateAction<readonly string[] | undefined>>;
  readonly setPicking: React.Dispatch<React.SetStateAction<boolean>>;
}

// What a commit says when the message is left empty. A picked type still
// applies to it, so `feat` with no message commits `feat: Update from Stacki`.
const COMMIT_MESSAGE_FALLBACK = 'Update from Stacki';

function useCommitAction(props: RepositoryProps, state: CommitState, commitType: CommitTypeControl): () => void {
  return () => {
    if (commitType.state.kind === 'invalid') {
      // The scope field already says what is wrong; Commit is disabled until it is fixed.
      return;
    }
    const message = buildCommitSubject(state.commitMessage, commitType.state.convention, COMMIT_MESSAGE_FALLBACK);
    // Explicit selections stay explicit even when they include every visible file;
    // files arriving after selection must not be silently added to the commit.
    const paths = state.picking ? state.picked : undefined;
    if (props.busy || (state.picking && !state.picked?.length)) {
      return;
    }
    void props
      .runAction(
        async () => {
          await gitValue(commitGitChanges(props.project.path, message, paths));
        },
        paths ? props.translate('git.chip.savedFiles', { count: paths.length }) : props.translate('git.chip.committed'),
        props.translate('git.busy.committing'),
      )
      .then((done) => {
        if (done) {
          state.setCommitMessage('');
          commitType.resetForNextCommit();
          state.setPicked(undefined);
          state.setPicking(false);
        }
      });
  };
}

interface ModalProps extends RepositoryProps {
  readonly switchTo: SwitchTarget | undefined;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly parkThenSwitch: (branch: string) => Promise<boolean>;
  readonly commitThenSwitch: (branch: string, message: string) => Promise<boolean>;
  readonly switchConvention: CommitConvention;
}

function GitModals(props: ModalProps) {
  return props.switchTo && <CheckoutModal {...props} switchTo={props.switchTo} />;
}

function CheckoutModal(props: ModalProps & { readonly switchTo: SwitchTarget }) {
  return (
    <SwitchBranchModal
      from={props.info.branch}
      to={props.switchTo.branch}
      files={props.switchTo.files}
      busy={props.busy}
      convention={props.switchConvention}
      onCancel={() => props.setSwitchTo(undefined)}
      onLeaveHere={() => {
        // runAction reports its own failures and resolves false; it never rejects.
        void props.parkThenSwitch(props.switchTo.branch).then((done) => {
          if (done) {
            props.setSwitchTo(undefined);
          }
        });
      }}
      onCommitFirst={(message: string) => {
        // runAction reports its own failures and resolves false; it never rejects.
        void props.commitThenSwitch(props.switchTo.branch, message).then((done) => {
          if (done) {
            props.setSwitchTo(undefined);
          }
        });
      }}
    />
  );
}
