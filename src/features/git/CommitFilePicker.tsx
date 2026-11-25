import { useTranslate } from '../../lib/i18n/useTranslate';
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
