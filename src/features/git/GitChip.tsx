import type { GitIncomingState } from './useGitIncoming';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import type { IpcResults, WireGitInfo } from '../../../shared/ipc/ipcResults';
import { assert } from '../../../shared/core/assert';
import { cleanErrorKeepingReference, type Failure } from '../../lib/cleanError';
import { translateErrorText, translateFailure, translateReference } from '../../lib/i18n/translateErrorText';
import { withReferencedMessage } from '../../../shared/core/i18n/referencedMessage';
import { deleteBranchAction, mergeBranchAction, tidyUp } from './gitActions';
import { checkoutGitBranch, commitGitChanges, initializeGit, pullGitBranch, readGitStatus, resolveGitMerge } from './gitChipBridge';
import { BranchIcon } from '../../ui/Icons';
import type { Conflict, ConflictChoices } from './gitConflictModel';
import GitChipView from './GitChipView';
import { buildCommitSubject } from './commitType';
import { commitTypeConvention, useCommitType, type CommitTypeControl } from './CommitTypePicker';
import type { CommitConvention } from './commitType';
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
  readonly translate: Translator;
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

async function gitValue<Value>(pending: Promise<{ readonly ok: true; readonly value: Value } | Failure>): Promise<Value> {
  const result = await pending;
  if (!result.ok) {
    // The reference rides in the message so `runAction` can show our own sentences in the person's language.
    throw new Error(withReferencedMessage(result.error, result.errorRef));
  }
  return result.value;
}

function useActionRunner({
  flushSave,
  refresh,
  onWorktreeChanged,
  showToast,
  externalBusy,
  translate,
}: {
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  readonly onWorktreeChanged: (() => Promise<unknown>) | undefined;
  readonly showToast: ShowToast;
  readonly externalBusy: string | undefined;
  readonly translate: Translator;
}) {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const pending = useRef(false);
  const runAction = useCallback<RunAction>(
    async (work, successMessage, label = translate('git.busy.working')) => {
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
        const message = translateErrorText(cleanErrorKeepingReference(caught), translate);
        setError(message);
        showToast(message, 'error');
        return false;
      } finally {
        pending.current = false;
        setBusy(undefined);
      }
    },
    [externalBusy, flushSave, onWorktreeChanged, refresh, showToast, translate],
  );
  return { busy, error, setError, runAction } as const;
}

export default function GitChip(props: GitChipProps) {
  const translate = useTranslate();
  const { info, refresh } = props;
  const action = useActionRunner({
    flushSave: props.flushSave,
    refresh,
    onWorktreeChanged: props.onWorktreeChanged,
    showToast: props.showToast,
    externalBusy: props.busy,
    translate,
  });
  if (!info) {
    return (
      <p className="history-note" role="status">
        {translate('git.chip.reading')}
      </p>
    );
  }
  if (!info.isRepo) {
    return <InitializeGitChip projectPath={props.project.path} busy={action.busy ?? props.busy} runAction={action.runAction} translate={translate} />;
  }
  return (
    <RepositoryGitChip
      {...props}
      translate={translate}
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
  const state = useRepositoryState();
  useChangedFiles(props, state);
  const commitType = useCommitType(props.project);
  const actions = useRepositoryActions(props, state, commitType);
  const commit = useCommitAction(props, state, commitType);
  const subject = commitType.state.kind === 'ready' ? buildCommitSubject(state.commitMessage, commitType.state.convention, COMMIT_MESSAGE_FALLBACK) : undefined;
  return (
    <>
      <GitChipView
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
        switchConvention={commitTypeConvention(commitType)}
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
        props.showToast(props.translate('git.pull.dirty'), 'error');
      } else {
        props.showToast(props.translate(result.changed ? 'git.pull.done' : 'git.pull.upToDate'), 'success');
      }
    },
    undefined,
    props.translate('git.busy.pulling'),
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
  readonly conflict: PendingConflict | undefined;
  readonly setSwitchTo: React.Dispatch<React.SetStateAction<SwitchTarget | undefined>>;
  readonly setConflict: React.Dispatch<React.SetStateAction<PendingConflict | undefined>>;
  readonly parkThenSwitch: (branch: string) => Promise<boolean>;
  readonly commitThenSwitch: (branch: string, message: string) => Promise<boolean>;
  readonly switchConvention: CommitConvention;
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
    const done = await props.runAction(() => resolveConflict(props, choices), undefined, props.translate('git.busy.merging'));
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
      translate: props.translate,
    });
  } else {
    props.showToast(props.translate('git.action.merge.done', { branch: props.conflict.branch, into: result.into }), 'success');
  }
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
