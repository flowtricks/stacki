import type { GitIncomingState } from './useGitIncoming';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { IpcResults, WireGitInfo } from '../../../shared/ipc/ipcResults';
import type { Result } from '../../../shared/core/result';
import { assert } from '../../../shared/core/assert';
import { cleanError } from '../../lib/cleanError';
import { deleteBranchAction, mergeBranchAction, tidyUp } from './gitActions';
import { checkoutGitBranch, commitGitChanges, initializeGit, pullGitBranch, readGitStatus, resolveGitMerge } from './gitChipBridge';
import { BranchIcon } from '../../ui/Icons';
import type { Conflict, ConflictChoices } from './gitConflictModel';
import GitChipView from './GitChipView';
import MergeConflictModal from './MergeConflictModal';
import SwitchBranchModal from './SwitchBranchModal';

type ToastKind = 'error' | 'success' | 'info';
type ShowToast = (message: string, kind: ToastKind) => void;
type ActionWork = () => Promise<void>;
type RunAction = (work: ActionWork, successMessage: string | undefined, label?: string) => Promise<boolean>;

interface GitProject {
  readonly path: string;
  readonly name: string;
}

interface GitChipProps {
  readonly info: IpcResults['git:info'] | undefined;
  readonly refresh: () => Promise<unknown>;
  readonly busy: string | undefined;
  readonly project: GitProject;
  readonly showToast: ShowToast;
  readonly flushSave: () => Promise<unknown>;
  readonly incoming?: GitIncomingState;
  readonly onWorktreeChanged?: (() => Promise<unknown>) | undefined;
  readonly withBranchChange?: <Value>(work: () => Promise<Value>) => Promise<Value>;
}

interface RepositoryProps extends GitChipProps {
  readonly info: WireGitInfo;
  readonly runAction: RunAction;
  readonly busy: string | undefined;
  readonly error: string | undefined;
  readonly setError: React.Dispatch<React.SetStateAction<string | undefined>>;
}

type PendingConflict = Conflict & { readonly deleteAfter: boolean };
interface SwitchTarget {
  readonly branch: string;
  readonly files: readonly string[];
}

async function gitValue<Value>(pending: Promise<Result<Value, string>>): Promise<Value> {
  const result = await pending;
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.value;
}

function useActionRunner({
  flushSave,
  refresh,
  onWorktreeChanged,
  showToast,
  externalBusy,
}: {
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly onWorktreeChanged: (() => Promise<unknown>) | undefined;
  readonly showToast: ShowToast;
  readonly externalBusy: string | undefined;
}) {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const pending = useRef(false);
  const runAction = useCallback<RunAction>(
    async (work, successMessage, label = 'Working…') => {
      if (pending.current || externalBusy) {
        return false;
      }
      // A synchronous lock also covers repeated clicks before React rerenders.
      pending.current = true;
      setBusy(label);
      setError(undefined);
      try {
        await flushSave();
        await work();
        await refresh();
        await onWorktreeChanged?.();
        if (successMessage) {
          showToast(successMessage, 'success');
        }
        return true;
      } catch (caught: unknown) {
        const message = cleanError(caught);
        setError(message);
        showToast(message, 'error');
        return false;
      } finally {
        pending.current = false;
        setBusy(undefined);
      }
    },
    [externalBusy, flushSave, onWorktreeChanged, refresh, showToast],
  );
  return { busy, error, setError, runAction } as const;
}

export default function GitChip(props: GitChipProps) {
  const { info, refresh } = props;
  const action = useActionRunner({
    flushSave: props.flushSave,
    refresh,
    onWorktreeChanged: props.onWorktreeChanged,
    showToast: props.showToast,
    externalBusy: props.busy,
  });
  if (!info) {
    return (
      <p className="history-note" role="status">
        Reading repository…
      </p>
    );
  }
  if (!info.isRepo) {
    return <InitializeGitChip projectPath={props.project.path} busy={action.busy ?? props.busy} runAction={action.runAction} />;
  }
  return (
    <RepositoryGitChip
      {...props}
      info={info}
      refresh={refresh}
      runAction={action.runAction}
      busy={action.busy ?? props.busy}
      error={action.error}
      setError={action.setError}
    />
  );
}

function InitializeGitChip({
  projectPath,
  busy,
  runAction,
}: {
  readonly projectPath: string;
  readonly busy: string | undefined;
  readonly runAction: RunAction;
}) {
  const initialize = (): void => {
    void runAction(
      async () => {
        await gitValue(initializeGit(projectPath));
      },
      'Initialized git repository',
      'Initializing…',
    );
  };
  return (
    <button className="primary git-initialize" disabled={busy !== undefined} onClick={initialize}>
      {busy ? <span className="mini-spinner" /> : <BranchIcon size={12} />}
      {busy ?? 'Initialize Git'}
    </button>
  );
}

function RepositoryGitChip(props: RepositoryProps) {
  const state = useRepositoryState();
  useChangedFiles(props, state);
  const actions = useRepositoryActions(props, state);
  const commit = useCommitAction(props, state);
  return (
    <>
      <GitChipView
        info={props.info}
        busy={props.busy}
        error={props.error}
        commitMessage={state.commitMessage}
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
        onPull={() => pullFromGitHub(props, state)}
        incoming={props.incoming ?? { kind: 'checking' }}
      />
      <GitModals
        {...props}
        switchTo={state.switchTo}
        conflict={state.conflict}
        setSwitchTo={state.setSwitchTo}
        setConflict={state.setConflict}
        parkThenSwitch={actions.parkThenSwitch}
        commitThenSwitch={actions.commitThenSwitch}
      />
    </>
  );
}

function pullFromGitHub(props: RepositoryProps, state: ActionState): void {
  void props.runAction(
    async () => {
      const result = await gitValue(pullGitBranch(props.project.path, props.info.branch));
      if ('conflicted' in result) {
        state.setConflict({ ...result, deleteAfter: false });
      } else if ('dirty' in result) {
        props.showToast('Commit your local changes before pulling: incoming changes affect the same files.', 'error');
      } else {
        props.showToast(result.changed ? 'Pulled changes from GitHub' : 'Already up to date with GitHub', 'success');
      }
    },
    undefined,
    'Pulling…',
  );
}

function useRepositoryState() {
  const [commitMessage, setCommitMessage] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [switchTo, setSwitchTo] = useState<SwitchTarget | undefined>(undefined);
  const [conflict, setConflict] = useState<PendingConflict | undefined>(undefined);
  // The files picked for a partial commit; undefined until the picker loads them.
  const [picked, setPicked] = useState<readonly string[] | undefined>(undefined);
  const [changed, setChanged] = useState<IpcResults['git:status']>([]);
  const [picking, setPicking] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  return {
    commitMessage,
    newBranch,
    switchTo,
    conflict,
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
  const { info, project, setError } = props;
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
        setError(result.error);
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
  }, [info, setError, selectionRevision, project.path, picking, setChanged, setPicked]);
}

interface ActionState {
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
  readonly setNewBranch: React.Dispatch<React.SetStateAction<string>>;
}

function useRepositoryActions(props: RepositoryProps, state: ActionState) {
  const requestSwitch = (branch: string): void => {
    if (branch === props.info.branch) {
      return;
    }
    void props.runAction(() => switchBranch(props, state, branch), undefined, 'Switching…');
  };
  const mergeBranch = (branch: string): void => {
    void mergeBranchAction({
      projectPath: props.project.path,
      branch,
      into: props.info.branch,
      trunk: props.info.trunk,
      run: (work, label) => void props.runAction(work, undefined, label),
      showToast: props.showToast,
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
    });
  };
  return {
    requestSwitch,
    mergeBranch,
    deleteBranch,
    createBranch: (branch: string) => createNamedBranch(props, state, branch),
    parkThenSwitch: (branch: string) => parkAndSwitch(props, branch),
    commitThenSwitch: (branch: string, message: string) => commitAndSwitch(props, branch, message),
  } as const;
}

async function switchBranch(props: RepositoryProps, state: ActionState, branch: string): Promise<void> {
  const result = await checkoutBranch(props, branch, { kind: 'switch' });
  if (!result.ok) {
    state.setSwitchTo({ branch, files: result.files });
    return;
  }
  if (result.error) {
    props.showToast(result.error, 'error');
  } else if (result.restored) {
    props.showToast(`Picked your changes back up on ${branch}`, 'success');
  } else if (result.parked) {
    props.showToast(`On ${branch} — your changes are waiting on ${result.from}`, 'success');
  } else {
    props.showToast(`Switched to ${branch}`, 'success');
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
    `Created branch ${branch}`,
    'Creating branch…',
  );
}

async function parkAndSwitch(props: RepositoryProps, branch: string): Promise<boolean> {
  const from = props.info.branch;
  return props.runAction(
    async () => {
      const result = await checkoutBranch(props, branch, { kind: 'park' });
      assert(result.ok, 'Parking before checkout cannot return a blocked checkout');
      if (result.error) {
        props.showToast(result.error, 'error');
      } else if (result.restored) {
        props.showToast(`Picked your changes back up on ${branch}`, 'success');
      }
    },
    `On ${branch} — your changes are waiting on ${from}`,
    'Switching…',
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
    `Committed to ${from}, now on ${branch}`,
    'Committing…',
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

function useCommitAction(props: RepositoryProps, state: CommitState): () => void {
  return () => {
    const message = state.commitMessage.trim() || 'Update from Stacki';
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
        paths ? `Saved ${paths.length} file${paths.length === 1 ? '' : 's'}` : 'Changes committed',
        'Committing…',
      )
      .then((done) => {
        if (done) {
          state.setCommitMessage('');
          state.setPicked(undefined);
          state.setPicking(false);
        }
      });
  };
}

interface ModalProps extends RepositoryProps {
  readonly switchTo: SwitchTarget | undefined;
  readonly conflict: PendingConflict | undefined;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
  readonly parkThenSwitch: (branch: string) => Promise<boolean>;
  readonly commitThenSwitch: (branch: string, message: string) => Promise<boolean>;
}

function GitModals(props: ModalProps) {
  return (
    <>
      {props.conflict && <ConflictModal {...props} conflict={props.conflict} />}
      {props.switchTo && <CheckoutModal {...props} switchTo={props.switchTo} />}
    </>
  );
}

function ConflictModal(props: ModalProps & { readonly conflict: PendingConflict }) {
  const resolve = async (choices: ConflictChoices): Promise<void> => {
    const done = await props.runAction(() => resolveConflict(props, choices), undefined, 'Merging…');
    if (done) {
      props.setConflict(undefined);
    }
  };
  return (
    <MergeConflictModal
      conflict={props.conflict}
      branches={props.info.branches}
      trunk={props.info.trunk ?? 'main'}
      busy={props.busy}
      onCancel={() => props.setConflict(undefined)}
      onResolve={(choices) => {
        // runAction reports its own failures (a toast and the chip's error).
        void resolve(choices);
      }}
    />
  );
}

async function resolveConflict(props: ModalProps & { readonly conflict: PendingConflict }, choices: ConflictChoices): Promise<void> {
  const result = await gitValue(resolveGitMerge(props.project.path, props.conflict.branch, choices));
  assert(result.ok, 'Merge resolution must complete');
  assert(result.into !== undefined, 'Merge resolution requires a target branch');
  if (props.conflict.deleteAfter) {
    await tidyUp({
      projectPath: props.project.path,
      branch: props.conflict.branch,
      into: result.into,
      changed: true,
      showToast: props.showToast,
    });
  } else {
    props.showToast(`Merged ${props.conflict.branch} into ${result.into}`, 'success');
  }
}

function CheckoutModal(props: ModalProps & { readonly switchTo: SwitchTarget }) {
  return (
    <SwitchBranchModal
      from={props.info.branch}
      to={props.switchTo.branch}
      files={props.switchTo.files}
      busy={props.busy}
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
