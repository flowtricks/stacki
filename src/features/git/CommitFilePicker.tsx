import { useTranslate } from '../../lib/i18n/useTranslate';
import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { IpcResults } from '../../../shared/ipc/ipcResults';
import type { FileGitState } from '../../../shared/ipc/fileExplorer';
import { createCoalescedRun } from '../../lib/coalescedRun';
import { translateFailure } from '../../lib/i18n/translateErrorText';
import { FileEntryIcon } from '../../ui/ElementIcons';
import { GitStatusBadge, gitTone, type GitMark } from '../../ui/GitStatus';
import { SkeletonRows } from '../../ui/Skeleton';
import { readGitStatus } from './gitChipBridge';
import type { ShowToast } from './useGitSession';
import Popup from '../../ui/Popup';
import { ChevronDownIcon, ChevronRightIcon, CloseIcon, FileIcon } from '../../ui/Icons';
import FileBrowser from './FileBrowser';
import type { BrowserFile } from './FileBrowser';

interface CommitFilePickerProps {
  readonly files: readonly BrowserFile[];
  readonly picked: readonly string[] | undefined;
  readonly picking: boolean;
  readonly working: boolean;
  readonly error: string | undefined;
  readonly onTogglePicking: () => void;
  readonly onRefresh: () => void;
  readonly onPick: (paths: readonly string[]) => void;
}

export default function CommitFilePicker(props: CommitFilePickerProps) {
  const [open, setOpen] = useState(false);
  const translate = useTranslate();
  const count = props.picked?.length ?? 0;
  return (
    <>
      <button
        className="git-pick-toggle"
        disabled={props.working}
        aria-haspopup="dialog"
        aria-label={translate('git.commit.chooseWhat')}
        title={props.picking ? translate('git.commit.selectedCount', { count }) : translate('git.commit.chooseWhat')}
        onClick={() => {
          if (!props.picking) {
            props.onTogglePicking();
          }
          props.onRefresh();
          setOpen(true);
        }}
      >
        <FileIcon size={13} />
        <span>{props.picking ? translate('git.commit.filesButtonCount', { count }) : translate('git.commit.filesButton')}</span>
      </button>
      {open && <CommitFilesDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function CommitFilesDialog(props: CommitFilePickerProps & { readonly onClose: () => void }) {
  const translate = useTranslate();
  const titleId = useId();
  return (
    <Popup className="modal git-commit-files-dialog" labelledBy={titleId} onClose={props.onClose}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">
            <h2 id={titleId}>{translate('git.commit.chooseFiles')}</h2>
            <button className="ghost" aria-label={translate('git.commit.closeSelection')} onClick={close}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="git-commit-files-content">
            {props.error ? <ErrorToast message={props.error} recovery={[{ label: translate('ui.retry'), run: props.onRefresh }]} /> : undefined}
            {props.picked === undefined ? (
              <p role="status">{translate('git.commit.loadingFiles')}</p>
            ) : (
              <FileBrowser
                files={props.files}
                selectable
                selected={props.picked}
                onSelect={props.onPick}
                emptyMessage={translate('git.commit.nothingChanged')}
                autoFocusSearch
              />
            )}
          </div>
          <div className="modal-footer">
            <button
              className="ghost"
              onClick={() =>
                finish(() => {
                  props.onTogglePicking();
                  props.onClose();
                })
              }
            >
              {translate('git.commit.useAll')}
            </button>
            <button className="primary" onClick={close}>
              {translate('git.done')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// ---------------------------------------------------------------------------
// The list of changes under the commit box
// ---------------------------------------------------------------------------
//
// What the working tree holds that no commit does, as VS Code's source control lists it: closed each time the panel
// opens, with the count on its header. It only shows; which files a commit takes is still the picker's choice above.
// It lives with the picker because both are the files of the next commit (and Studio's release is at its file bound).
//
// It reads the picker's own list (`git:status`), when the panel's git info is read again and when the host says the
// tree changed (`signal`): there is no timer of its own. The last list read stays on screen until a different one
// arrives, and is held per project so a reopened panel paints it at once.

/** Rows drawn; the header still counts everything, and a last line says how many are not shown. */
export const CHANGE_ROWS_MAX = 200;
/** Projects whose last list is held. */
const HELD_PROJECTS_MAX = 8;

type StatusFiles = IpcResults['git:status'];
const heldChanges = new Map<string, StatusFiles>();

interface ChangesProps {
  readonly projectPath: string;
  /** Git's summary of the tree: a new one means git was just read. */
  readonly info: { readonly dirty: boolean };
  /** A host that follows the tree more closely passes what changes when it does. */
  readonly signal?: unknown;
  /** Opens a file that is still on disk; absent where the host has nowhere to open it. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
  readonly showToast: ShowToast;
}

export function ChangesList(props: ChangesProps) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const files = useChanges(props);
  // Nothing to say: no header and no empty line. Before the first read, git's summary already knows whether there is.
  if (files === undefined ? !props.info.dirty : files.length === 0) {
    return undefined;
  }
  const hidden = files === undefined ? 0 : Math.max(0, files.length - CHANGE_ROWS_MAX);
  return (
    <div className="history-section git-changes">
      <button type="button" className="history-section-head" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
        <span className="history-section-title">{translate('git.changes.title')}</span>
        {files !== undefined && <span className="history-section-count">{files.length}</span>}
        <span className="history-section-chevron" aria-hidden="true">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      <div id={listId} hidden={!open}>
        {open && files === undefined && <SkeletonRows count={3} />}
        {open && files !== undefined && (
          <ul className="git-changes-list" aria-label={translate('git.changes.title')}>
            {files.slice(0, CHANGE_ROWS_MAX).map((file) => (
              <li key={file.path}>
                <ChangeRow file={file} onOpenFile={props.onOpenFile} />
              </li>
            ))}
            {hidden > 0 && <li className="git-changes-more">{translate('git.changes.more', { count: hidden })}</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function ChangeRow({ file, onOpenFile }: { readonly file: StatusFiles[number]; readonly onOpenFile: ChangesProps['onOpenFile'] }) {
  const state = changeState(file);
  const mark: GitMark = { kind: 'change', state, from: file.from };
  const slash = file.path.lastIndexOf('/');
  const name = file.path.slice(slash + 1);
  const content = (
    <>
      <span className="git-change-icon">
        <FileEntryIcon name={name} kind="file" open={undefined} />
      </span>
      <bdi className="git-change-name" dir="ltr">
        {name}
      </bdi>
      <span className="git-change-folder">{slash < 0 ? undefined : <bdi dir="ltr">{file.path.slice(0, slash)}</bdi>}</span>
      <GitStatusBadge mark={mark} />
    </>
  );
  // A deleted file has nothing to open.
  if (onOpenFile === undefined || state === 'deleted') {
    return (
      <div className="git-change" data-git={gitTone(mark)}>
        {content}
      </div>
    );
  }
  return (
    <button type="button" className="git-change" data-git={gitTone(mark)} onClick={() => onOpenFile(file.path)}>
      {content}
    </button>
  );
}

/** The state a row shows. Studio's reply has the letter and no state. */
export function changeState(file: Pick<StatusFiles[number], 'state' | 'status' | 'untracked'>): FileGitState {
  if (file.state !== undefined) {
    return file.state;
  }
  if (file.untracked) {
    return 'untracked';
  }
  switch (file.status.charAt(0)) {
    case 'A':
    case 'C':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'U':
      return 'conflicted';
    default:
      return 'modified';
  }
}

// A path git names twice (removed from the index and still on disk) is one row, its later record: the working tree's.
function onePerPath(files: StatusFiles): StatusFiles {
  return [...new Map(files.map((file) => [file.path, file])).values()];
}

function useChanges({ projectPath, info, signal, showToast }: ChangesProps): StatusFiles | undefined {
  const translate = useTranslate();
  const [shown, setShown] = useState(() => ({ projectPath, files: heldChanges.get(projectPath) }));
  const told = useRef(false);
  const latest = useRef({ showToast, translate });
  latest.current = { showToast, translate };
  // One read at a time with at most one waiting, however often the tree changes.
  const reader = useMemo(
    () =>
      createCoalescedRun(async () => {
        const result = await readGitStatus(projectPath);
        if (!result.ok) {
          // A list that cannot be confirmed is not shown. Said once until a read succeeds again.
          heldChanges.delete(projectPath);
          setShown({ projectPath, files: undefined });
          if (!told.current) {
            told.current = true;
            latest.current.showToast(translateFailure(result, latest.current.translate), 'error');
          }
          return;
        }
        told.current = false;
        const files = onePerPath(result.value);
        // The same list again keeps its rows: nothing is drawn again.
        if (JSON.stringify(heldChanges.get(projectPath)) !== JSON.stringify(files)) {
          heldChanges.delete(projectPath);
          heldChanges.set(projectPath, files);
          for (const oldest of [...heldChanges.keys()].slice(0, Math.max(0, heldChanges.size - HELD_PROJECTS_MAX))) {
            heldChanges.delete(oldest);
          }
        }
        setShown({ projectPath, files: heldChanges.get(projectPath) });
      }),
    [projectPath],
  );
  useEffect(() => {
    void reader.request();
  }, [reader, info, signal]);
  return shown.projectPath === projectPath ? shown.files : heldChanges.get(projectPath);
}
