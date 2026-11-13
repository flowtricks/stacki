// The question asked before Publish starts from a branch other than the default one (or from no branch at all).
//
// Publish sends the current branch, and a branch can change without the person doing it (an AI tool made one, a
// terminal switched). So every way of starting a publish passes through `guard` first: on the default branch it runs
// the publish at once; anywhere else it asks, in this window, before anything is saved, committed or sent.
//
// Switching first is only offered as a clean switch. With uncommitted changes the dialog says so and stays open:
// carrying or parking someone's work is the History panel's job, with its own explanation, not a side effect of Publish.
import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { assert } from '../../../shared/core/assert';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { cleanError } from '../../lib/cleanError';
import Popup from '../../ui/Popup';
import { branchStatusOf, needsBranchWarning, type BranchStatus } from './branchStatus';
import { isBranchWarningSilenced, silenceBranchWarning } from './branchWarningPreference';
import { checkoutGitBranch, readGitInfo } from './gitChipBridge';

type Warned = Extract<BranchStatus, { readonly kind: 'other' | 'detached' }>;

interface Pending {
  readonly status: Warned;
  /** Whether the project had uncommitted changes when the question was asked. */
  readonly dirty: boolean;
  readonly proceed: () => void;
}

/** What a switch attempt came to; a refusal carries the sentence to show, already translated or as git said it. */
export type SwitchOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string };

interface GateOptions {
  readonly projectPath: string;
  /** The shared git info, used when a fresh read fails. */
  readonly repository: IpcResults['git:info'] | undefined;
  readonly flushSave: () => Promise<unknown>;
  readonly refresh: () => Promise<unknown>;
  /** The app's wrapper that reloads the preview and canvas around a branch change; absent runs the switch bare. */
  readonly withBranchChange?: (<Value>(work: () => Promise<Value>) => Promise<Value>) | undefined;
  /** After a switch: the project's files on disk now belong to another branch. */
  readonly onBranchSwitched?: (() => Promise<unknown>) | undefined;
}

export interface PublishBranchGate {
  /** Runs `proceed` now on the default branch, or after the person answers the question anywhere else. */
  readonly guard: (proceed: () => void) => void;
  readonly dialog: ReactNode;
}

export function usePublishBranchGate(options: GateOptions): PublishBranchGate {
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const checking = useRef(false);
  const guard = (proceed: () => void): void => {
    if (checking.current) {
      return;
    }
    checking.current = true;
    void askIfNeeded(options, proceed)
      .then((question) => {
        if (question === undefined) {
          proceed();
        } else {
          setPending(question);
        }
      })
      .finally(() => {
        checking.current = false;
      });
  };
  const dialog =
    pending === undefined ? undefined : <PublishBranchWarning key={pending.status.kind} {...dialogProps(options, pending, () => setPending(undefined))} />;
  return { guard, dialog };
}

/** The question to ask, or undefined when the publish may simply start. A fresh read, because the cached branch can be seconds old. */
async function askIfNeeded(options: GateOptions, proceed: () => void): Promise<Pending | undefined> {
  const fresh = await readGitInfo(options.projectPath);
  const info = fresh.ok ? fresh.value : options.repository;
  const status = branchStatusOf(info);
  if (!needsBranchWarning(status)) {
    return undefined;
  }
  if (status.kind === 'other' && isBranchWarningSilenced(options.projectPath, status.name)) {
    return undefined;
  }
  const dirty = info?.isRepo === true && info.dirty;
  return { status, dirty, proceed };
}

interface DialogProps {
  readonly status: Warned;
  readonly dirty: boolean;
  readonly publish: (remember: boolean) => void;
  readonly switchFirst: () => Promise<SwitchOutcome>;
  readonly cancel: () => void;
}

function dialogProps(options: GateOptions, pending: Pending, close: () => void): DialogProps {
  const { status, proceed } = pending;
  return {
    status,
    dirty: pending.dirty,
    publish: (remember) => {
      if (remember && status.kind === 'other') {
        silenceBranchWarning(options.projectPath, status.name);
      }
      close();
      proceed();
    },
    switchFirst: async () => {
      const outcome = await switchToDefault(options, status);
      if (outcome.ok) {
        close();
        proceed();
      }
      return outcome;
    },
    cancel: close,
  };
}

async function switchToDefault(options: GateOptions, status: Warned): Promise<SwitchOutcome> {
  assert(status.defaultName.length > 0, 'Branch warning: there is a branch to switch to');
  try {
    await options.flushSave();
    // The branch name goes to git as one argument (gitChipBridge), never inside a command line.
    const work = () => checkoutGitBranch(options.projectPath, status.defaultName, { kind: 'switch' });
    const result = await (options.withBranchChange === undefined ? work() : options.withBranchChange(work));
    if (!result.ok) {
      return { ok: false, message: result.error };
    }
    if (!result.value.ok) {
      // Git would overwrite local changes: nothing moved. The caller words this; the files are only a reason to stop.
      return { ok: false, message: '' };
    }
    await options.refresh();
    await options.onBranchSwitched?.();
    return { ok: true };
  } catch (error: unknown) {
    return { ok: false, message: cleanError(error) };
  }
}

function PublishBranchWarning({ status, dirty, publish, switchFirst, cancel }: DialogProps) {
  const translate = useTranslate();
  const [remember, setRemember] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const detached = status.kind === 'detached';
  const branch = status.kind === 'other' ? status.name : 'HEAD';
  const canSwitch = status.kind === 'other' || status.canSwitch;
  const trySwitch = async (): Promise<void> => {
    if (dirty) {
      setProblem(translate('publish.branchWarning.dirty', { branch }));
      return;
    }
    setProblem(undefined);
    setWorking(true);
    const outcome = await switchFirst();
    if (!outcome.ok) {
      setWorking(false);
      setProblem(
        outcome.message.length === 0
          ? translate('publish.branchWarning.dirty', { branch })
          : translate('publish.branchWarning.switchFailed', { default: status.defaultName, message: outcome.message }),
      );
    }
  };
  return (
    <Popup className="modal confirm-dialog stacki-branch-warning" role="alertdialog" onClose={cancel} dismissible={!working}>
      {({ close }) => (
        <>
          <div className="modal-header">
            {detached ? translate('publish.branchWarning.titleDetached') : translate('publish.branchWarning.title', { branch })}
          </div>
          <div className="modal-body confirm-body">
            <div>
              {detached
                ? translate('publish.branchWarning.bodyDetached', { default: status.defaultName })
                : translate('publish.branchWarning.body', { branch, default: status.defaultName })}
            </div>
            {problem !== undefined && <p className="stacki-branch-warning-problem">{problem}</p>}
            {!detached && (
              <label className="confirm-check">
                <input type="checkbox" checked={remember} disabled={working} onChange={(event) => setRemember(event.target.checked)} />
                <span>{translate('publish.branchWarning.remember')}</span>
              </label>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" disabled={working} onClick={close}>
              {translate('ui.cancel')}
            </button>
            {canSwitch && (
              <button type="button" disabled={working} onClick={() => void trySwitch()}>
                {working ? translate('git.busy.switching') : translate('publish.branchWarning.switch', { default: status.defaultName })}
              </button>
            )}
            <button type="button" className="primary" disabled={working} onClick={() => publish(remember)}>
              {detached ? translate('publish.branchWarning.confirmDetached') : translate('publish.branchWarning.confirm', { branch })}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
