import { ErrorToast } from '../../ui/ErrorToast';
import { useId, useState } from 'react';
import Popup from '../../ui/Popup';
import { CloseIcon, FileIcon } from '../../ui/Icons';
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
  const count = props.picked?.length ?? 0;
  return (
    <>
      <button
        className="git-pick-toggle"
        disabled={props.working}
        aria-haspopup="dialog"
        aria-label="Choose what to commit"
        title={props.picking ? `${count} files selected` : 'Choose what to commit'}
        onClick={() => {
          if (!props.picking) {
            props.onTogglePicking();
          }
          props.onRefresh();
          setOpen(true);
        }}
      >
        <FileIcon size={13} />
        <span>Files{props.picking ? ` (${count})` : ''}</span>
      </button>
      {open && <CommitFilesDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

function CommitFilesDialog(props: CommitFilePickerProps & { readonly onClose: () => void }) {
  const titleId = useId();
  return (
    <Popup className="modal git-commit-files-dialog" labelledBy={titleId} onClose={props.onClose}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">
            <h2 id={titleId}>Choose files to commit</h2>
            <button className="ghost" aria-label="Close file selection" onClick={close}>
              <CloseIcon size={16} />
            </button>
          </div>
          <div className="git-commit-files-content">
            {props.error ? <ErrorToast message={props.error} recovery={[{ label: 'Retry', run: props.onRefresh }]} /> : undefined}
            {props.picked === undefined ? (
              <p role="status">Loading changed files…</p>
            ) : (
              <FileBrowser files={props.files} selectable selected={props.picked} onSelect={props.onPick} emptyMessage="Nothing has changed." autoFocusSearch />
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
              Use all files
            </button>
            <button className="primary" onClick={close}>
              Done
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
