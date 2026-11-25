// The branch chip beside Publish: which branch Publish will send, and a loud warning when it is not the default one.
//
// It never waits: the last branch read for this project paints in the first frame, the shared git info replaces it
// when it arrives, and a project nothing is known about yet draws no chip until the read answers. It
// stays current without its own watcher: the app already re-reads git on window focus, on a timer and on every save,
// and the shell adds the moment an AI turn ends (RefreshGitWhenAiTurnEnds), when a tool is most likely to have made a branch.
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import { BranchIcon } from '../../ui/Icons';
import { bootSnapshotFor } from '../../lib/bootSeed';
import { branchStatusOf, type BranchStatus } from './branchStatus';
import './branchIndicator.css';

interface Props {
  readonly projectPath: string;
  readonly info: IpcResults['git:info'] | undefined;
  /** Opens the panel that already holds the branch switcher. */
  readonly onOpen: (() => void) | undefined;
}

/** Projects whose last branch is remembered for the first frame of the next open; the oldest is forgotten first. */
const REMEMBERED_PROJECTS_MAX = 16;
const remembered = new Map<string, BranchStatus>();

/** Remember what was read (never a placeholder), most recent last, capped. Exported so a test can pin the bound. */
export function rememberBranchStatus(projectPath: string, status: BranchStatus): void {
  if (status.kind === 'unknown') {
    return;
  }
  remembered.delete(projectPath);
  remembered.set(projectPath, status);
  while (remembered.size > REMEMBERED_PROJECTS_MAX) {
    const oldest = remembered.keys().next();
    if (oldest.done === true) {
      break;
    }
    remembered.delete(oldest.value);
  }
}

/** The branch state remembered for `projectPath` this session, or the last session's (the boot snapshot). Never a placeholder. */
export function knownBranchStatus(projectPath: string): BranchStatus | undefined {
  return remembered.get(projectPath) ?? bootSnapshotFor(projectPath)?.branch;
}

export function forgetRememberedBranches(): void {
  remembered.clear();
}

export function BranchIndicator({ projectPath, info, onOpen }: Props) {
  const translate = useTranslate();
  const read = branchStatusOf(info);
  rememberBranchStatus(projectPath, read);
  const status = read.kind === 'unknown' ? (knownBranchStatus(projectPath) ?? read) : read;
  switch (status.kind) {
    case 'unknown':
      // Nothing is known about this project yet: nothing is drawn, rather than a stand-in shape.
      return undefined;
    case 'hidden':
      return undefined;
    case 'default':
      return <Chip state="quiet" label={status.name} title={translate('git.branch.indicator.tooltip', { name: status.name })} onOpen={onOpen} />;
    case 'other':
      return <Chip state="warning" label={status.name} title={translate('git.branch.indicator.tooltip', { name: status.name })} onOpen={onOpen} />;
    case 'detached':
      return (
        <Chip state="warning" label={translate('git.branch.indicator.detached')} title={translate('git.branch.indicator.detachedTooltip')} onOpen={onOpen} />
      );
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

function Chip(props: { readonly state: 'quiet' | 'warning'; readonly label: string; readonly title: string; readonly onOpen: (() => void) | undefined }) {
  return (
    <button
      type="button"
      className="stacki-branch-chip"
      data-state={props.state}
      title={props.title}
      aria-label={props.title}
      disabled={props.onOpen === undefined}
      onClick={props.onOpen}
    >
      <BranchIcon size={12} />
      <span>{props.label}</span>
    </button>
  );
}
