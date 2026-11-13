import { useId, useMemo, useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';
import { ChevronRightIcon, CloseIcon } from '../../ui/Icons';
import FileStatus from '../git/FileStatus';
import HistoryFileDiff from './HistoryFileDiff';
import HistoryFilesToolbar from './HistoryFilesToolbar';
import { selectHistoryFiles, type HistoryFileFilter, type HistoryFileSort } from './historyFileList';
import { summarizeHistoryFiles } from './historyFileSummary';
import { historyFileLabel } from './historyModel';

interface HistoryFilesDialogProps {
  readonly commit: HistoryCommit;
  readonly projectPath: string;
  readonly files: readonly HistoryCommitFile[];
  readonly onClose: () => void;
  readonly onRestoreFile?: ((commit: HistoryCommit, file: HistoryCommitFile) => void) | undefined;
}

export default function HistoryFilesDialog(props: HistoryFilesDialogProps) {
  const translate = useTranslate();
  const titleId = useId();
  const [selected, setSelected] = useState<HistoryCommitFile | undefined>(undefined);
  const [filter, setFilter] = useState<HistoryFileFilter>('all');
  const [sort, setSort] = useState<HistoryFileSort>('path');
  const counts = useMemo(() => summarizeHistoryFiles(props.files), [props.files]);
  const visible = useMemo(() => selectHistoryFiles(props.files, { filter, sort }), [props.files, filter, sort]);
  return (
    <Popup className={`modal history-files-dialog ${selected ? 'with-diff' : ''}`} labelledBy={titleId} onClose={props.onClose}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">
            <h2 id={titleId}>{selected ? historyFileLabel(selected, translate) : translate('history.dialog.title', { count: props.files.length })}</h2>
            <button autoFocus className="ghost" aria-label={translate('history.dialog.close')} onClick={close}>
              <CloseIcon size={16} />
            </button>
          </div>
          <p className="history-files-commit">
            {props.commit.subject} · {props.commit.shortHash}
          </p>
          {!selected && <HistoryFilesToolbar counts={counts} filter={filter} sort={sort} onFilter={setFilter} onSort={setSort} />}
          <HistoryFilesContent
            {...props}
            files={visible}
            selected={selected}
            select={setSelected}
            onRestoreFile={
              props.onRestoreFile
                ? (commit, file) =>
                    finish(() => {
                      props.onClose();
                      props.onRestoreFile?.(commit, file);
                    })
                : undefined
            }
          />
        </>
      )}
    </Popup>
  );
}

function HistoryFilesContent({
  selected,
  select,
  ...props
}: HistoryFilesDialogProps & {
  readonly selected: HistoryCommitFile | undefined;
  readonly select: (file: HistoryCommitFile | undefined) => void;
}) {
  const translate = useTranslate();
  if (selected) {
    return (
      <HistoryFileDiff
        key={selected.path}
        projectPath={props.projectPath}
        commit={props.commit}
        file={selected}
        onBack={() => select(undefined)}
        onRestore={
          props.onRestoreFile
            ? () => {
                props.onRestoreFile?.(props.commit, selected);
              }
            : undefined
        }
      />
    );
  }
  return (
    <div className="history-files" tabIndex={0} aria-label={translate('history.files.listLabel')}>
      {props.files.length === 0 && (
        <p className="history-empty" role="status">
          {translate('history.files.noMatch')}
        </p>
      )}
      {props.files.map((file) => (
        <HistoryChangedFile key={file.path} file={file} onOpen={() => select(file)} />
      ))}
    </div>
  );
}

function HistoryChangedFile({ file, onOpen }: { readonly file: HistoryCommitFile; readonly onOpen: () => void }) {
  const translate = useTranslate();
  return (
    <button className="history-file history-file-open" onClick={onOpen} aria-label={translate('history.files.viewDiff', { path: file.path })}>
      <FileStatus status={file.status} inCommit />
      <span className="history-file-label">
        <span>{historyFileLabel(file, translate)}</span>
        <span className="history-file-path">{file.path}</span>
        {file.from && <span className="history-file-path">{translate('history.files.from', { path: file.from })}</span>}
      </span>
      <ChevronRightIcon size={12} />
    </button>
  );
}
