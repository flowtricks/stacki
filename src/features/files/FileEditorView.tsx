// The file the Files panel opened, over the canvas (as the Instructions and CMS views cover it): a header with the
// name, the save status in place, Save and Close, and below it the code editor, a media preview or an empty state for
// a file that is not text. Hidden, not unmounted, while another left panel is shown, so unsaved text, the caret and
// the undo history survive a look elsewhere.
//
// A file that is the one open on the canvas is not edited here: the page editor already writes it (single writer),
// so the host passes that editor in (`liveEditor`) and it is shown in this frame instead.
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { Extension } from '@codemirror/state';
import { FILE_EXPLORER_LIMITS, baseName, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { useFormat, useTranslate } from '../../lib/i18n/useTranslate';
import CodeEditor from '../../ui/CodeEditor';
import { choiceDialog, confirmDialog } from '../../ui/ConfirmDialog';
import { EmptyState } from '../../ui/EmptyState';
import { CloseIcon, WarningTriangleIcon } from '../../ui/Icons';
import { sourceCandidates } from '../../ui/AssetThumb';
import { codeIndentStyleFor } from '../../ui/codeIndentStyle';
import { explorerErrorText } from './filesActions';
import { allowClose, guardClose, onCloseRequested } from './filesBridge';
import { closeEditor, noteEditorDirty, registerEditorSettler, settleOpenEditor, type Settled } from './fileEditorControl';
import type { FilesToastKind } from './filesHost';
import { gitMarksOf, updateFilesView, useFilesView } from './filesState';
import { editorLanguageFor } from './fileLanguage';
import { GitStatusBadge, gitTone } from '../../ui/GitStatus';
import { fileGitMark } from './fileGitMarks';
import { FilesTipButton } from './FilesTipButton';
import { useFileDocument, type FileDocument } from './useFileDocument';
import './files.css';
import { FileTypeIcon } from '../../ui/ElementIcons';

export interface FileEditorViewProps {
  readonly projectPath: string;
  readonly platform: string;
  readonly path: ExplorerPath;
  readonly hidden: boolean;
  readonly showToast: (message: string, kind: FilesToastKind) => void;
  /** More editor behaviour from the app: the project's code intelligence. Read when the file's editor is made. */
  readonly codeExtensions?: Extension | undefined;
  /** The page editor, when this file is the one open on the canvas. */
  readonly liveEditor: ReactNode;
}

export default function FileEditorView(props: FileEditorViewProps) {
  const translate = useTranslate();
  const name = baseName(props.path);
  const separator = props.platform === 'win32' ? '\\' : '/';
  const absolute = `${props.projectPath}${separator}${props.path.split('/').join(separator)}`;
  return (
    <div className={`cms-view files-editor ${props.hidden ? 'hidden' : ''}`} role="region" aria-label={translate('workspace.files.editor.region', { name })}>
      {props.liveEditor === undefined ? <TextOrMedia {...props} name={name} absolute={absolute} /> : <LiveFrame {...props} name={name} />}
    </div>
  );
}

function LiveFrame(props: FileEditorViewProps & { readonly name: string }) {
  const translate = useTranslate();
  return (
    <div className="files-editor-frame">
      <EditorHead
        projectPath={props.projectPath}
        name={props.name}
        path={props.path}
        status={translate('workspace.files.editor.canvas')}
        onClose={() => void closeEditor(props.projectPath)}
      >
        {undefined}
      </EditorHead>
      <div className="files-editor-body files-editor-live">{props.liveEditor}</div>
    </div>
  );
}

function TextOrMedia(props: FileEditorViewProps & { readonly name: string; readonly absolute: string }) {
  const translate = useTranslate();
  const { formatBytes } = useFormat();
  const { projectPath, path, name, showToast } = props;
  const deleted = useCallback(() => {
    showToast(translate('workspace.files.editor.deleted', { name }), 'warning');
    updateFilesView(projectPath, (view) => (view.editor?.path === path ? { ...view, editor: undefined } : view));
  }, [projectPath, path, name, showToast, translate]);
  const document = useFileDocument(projectPath, path, deleted);
  const save = useSave(props, document);
  useDirtyReport(projectPath, path, { dirty: document.dirty });
  useSettler(name, document, save);
  const { load, text } = document;
  let status: string | undefined;
  if (document.saving) {
    status = translate('workspace.files.editor.saving');
  } else if (text?.session.conflict !== undefined) {
    status = undefined;
  } else if (text !== undefined) {
    status = translate(document.dirty ? 'workspace.files.editor.unsaved' : 'workspace.files.editor.saved');
  }
  return (
    <div
      className="files-editor-frame"
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void save();
        }
      }}
    >
      <EditorHead projectPath={projectPath} name={name} path={path} status={status} dirty={document.dirty} onClose={() => void closeEditor(projectPath)}>
        {text?.session.conflict !== undefined && (
          <button type="button" className="files-editor-conflict" onClick={() => void askConflict(name, document, translate)}>
            <WarningTriangleIcon size={12} />
            {translate('workspace.files.editor.changedOnDisk')}
          </button>
        )}
        {load.kind === 'text' && (
          <button type="button" className="primary files-editor-save" disabled={!document.dirty || document.saving} onClick={() => void save()}>
            {translate('workspace.files.editor.save')}
          </button>
        )}
      </EditorHead>
      <div className="files-editor-body">
        {load.kind === 'text' && text !== undefined && (
          <CodeEditor
            key={path}
            language={editorLanguageFor(name)}
            {...(codeIndentStyleFor(path) === 'spaces' ? { indentation: 'spaces' as const } : {})}
            stickyHeaders={false}
            extensions={props.codeExtensions}
            value={text.session.draft}
            onChange={(draft: string) => document.edit(draft)}
          />
        )}
        {load.kind === 'other' && load.content.kind === 'media' && (
          <MediaPreview kind={load.content.media} source={sourceCandidates(props.absolute)[0]} name={name} />
        )}
        {load.kind === 'other' && load.content.kind === 'binary' && (
          <EmptyState
            icon={<FileTypeIcon name={name} size={20} />}
            title={translate('workspace.files.editor.binary')}
            description={translate('workspace.files.editor.binaryHint', { size: formatBytes(load.content.sizeBytes) })}
            align="center"
          />
        )}
        {load.kind === 'other' && load.content.kind === 'too-large' && (
          <EmptyState
            icon={<FileTypeIcon name={name} size={20} />}
            title={translate('workspace.files.editor.tooLarge')}
            description={translate('workspace.files.editor.tooLargeHint', {
              size: formatBytes(load.content.sizeBytes),
              limit: formatBytes(FILE_EXPLORER_LIMITS.textBytesMax),
            })}
            align="center"
          />
        )}
        {load.kind === 'failed' && (
          <EmptyState icon={<FileTypeIcon name={name} size={20} />} title={explorerErrorText(load.error, translate, name)} align="center" />
        )}
      </div>
    </div>
  );
}

function EditorHead(props: {
  readonly projectPath: string;
  readonly name: string;
  readonly path: ExplorerPath;
  readonly status: string | undefined;
  readonly dirty?: boolean;
  readonly children: ReactNode;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  // The open file wears the same colour and letter as its row in the tree.
  const mark = fileGitMark(gitMarksOf(useFilesView(props.projectPath)), props.path, { folder: false });
  return (
    // The CMS and Instructions views' own header (cms-detail-head): the same height, title, muted mono path and actions.
    <div className="cms-detail-head files-editor-head">
      <span className="cms-detail-title files-editor-title" data-git={gitTone(mark)}>
        {props.dirty === true && <span className="files-dirty" aria-hidden="true" />}
        <FileTypeIcon name={props.name} />
        <bdi className="files-editor-name" dir="ltr">
          {props.name}
        </bdi>
        <GitStatusBadge mark={mark} />
      </span>
      {props.path !== props.name && (
        <span className="cms-detail-path files-editor-path">
          <bdi dir="ltr">{props.path}</bdi>
        </span>
      )}
      <span className="files-editor-actions">
        {props.status !== undefined && (
          <span className="files-editor-status" role="status">
            {props.status}
          </span>
        )}
        {props.children}
        <FilesTipButton label={translate('workspace.files.editor.close')} onClick={props.onClose}>
          <CloseIcon size={13} />
        </FilesTipButton>
      </span>
    </div>
  );
}

function MediaPreview(props: { readonly kind: 'image' | 'video' | 'audio'; readonly source: string; readonly name: string }) {
  const translate = useTranslate();
  const label = translate('workspace.files.editor.media', { name: props.name });
  return (
    <div className="files-editor-media">
      {props.kind === 'image' && <img src={props.source} alt={label} draggable={false} />}
      {props.kind === 'video' && <video src={props.source} controls aria-label={label} />}
      {props.kind === 'audio' && <audio src={props.source} controls aria-label={label} />}
    </div>
  );
}

type Translate = ReturnType<typeof useTranslate>;

// Save with every answer handled: a conflict asks, a deleted file offers to come back, a failure is a toast.
function useSave(props: FileEditorViewProps & { readonly name: string }, document: FileDocument): () => Promise<boolean> {
  const translate = useTranslate();
  const { name, showToast } = props;
  return useCallback(async () => {
    const saved = await document.save();
    switch (saved.outcome) {
      case 'saved':
        return true;
      case 'conflict':
        await askConflict(name, document, translate);
        return false;
      case 'missing': {
        const again = await confirmDialog({
          title: translate('workspace.files.editor.recreate.title', { name }),
          body: translate('workspace.files.editor.recreate.body'),
          confirmLabel: translate('workspace.files.editor.recreate.confirm'),
          cancelLabel: translate('workspace.files.cancel'),
        });
        if (again === false) {
          return false;
        }
        const recreated = await document.recreate();
        if (recreated.outcome !== 'saved') {
          showToast(explorerErrorText(recreated.error ?? { code: 'filesystem', names: [], detail: undefined }, translate, name), 'error');
        }
        return recreated.outcome === 'saved';
      }
      case 'failed':
        showToast(explorerErrorText(saved.error ?? { code: 'filesystem', names: [], detail: undefined }, translate, name), 'error');
        return false;
      default: {
        const exhaustive: never = saved.outcome;
        return exhaustive;
      }
    }
  }, [document, name, showToast, translate]);
}

async function askConflict(name: string, document: FileDocument, translate: Translate): Promise<void> {
  const conflict = document.text?.session.conflict;
  if (conflict === undefined) {
    return;
  }
  const answer = await choiceDialog({
    title: translate('workspace.files.editor.conflict.title', { name }),
    body: translate('workspace.files.editor.conflict.body'),
    choices: [
      ...(conflict.merged === undefined
        ? []
        : [
            {
              id: 'merge',
              label: translate('workspace.files.editor.conflict.merge'),
              hint: translate('workspace.files.editor.conflict.mergeHint'),
              recommended: true,
            },
          ]),
      { id: 'mine', label: translate('workspace.files.editor.conflict.mine'), hint: translate('workspace.files.editor.conflict.mineHint') },
      { id: 'theirs', label: translate('workspace.files.editor.conflict.theirs'), hint: translate('workspace.files.editor.conflict.theirsHint') },
    ],
    cancelLabel: translate('workspace.files.cancel'),
  });
  if (answer === 'merge' || answer === 'mine' || answer === 'theirs') {
    document.resolve(answer);
  }
}

// The tree's dot and main's close guard follow whether the text differs from the disk.
function useDirtyReport(projectPath: string, path: ExplorerPath, { dirty }: { readonly dirty: boolean }): void {
  useEffect(() => {
    noteEditorDirty(projectPath, path, { dirty });
    void guardClose({ unsaved: dirty }).catch(() => undefined);
  }, [projectPath, path, dirty]);
  useEffect(() => () => void guardClose({ unsaved: false }).catch(() => undefined), []);
}

// Switching files, closing the editor, leaving the project and closing the window ask here first.
function useSettler(name: string, document: FileDocument, save: () => Promise<boolean>): void {
  const translate = useTranslate();
  const latest = useRef({ document, save, name });
  latest.current = { document, save, name };
  useEffect(
    () =>
      registerEditorSettler(async (): Promise<Settled> => {
        const { document: current, save: saveNow, name: shown } = latest.current;
        if (!current.dirty) {
          return 'proceed';
        }
        const answer = await choiceDialog({
          title: translate('workspace.files.editor.settle.title', { name: shown }),
          body: translate('workspace.files.editor.settle.body'),
          choices: [
            { id: 'save', label: translate('workspace.files.editor.settle.save'), recommended: true },
            { id: 'discard', label: translate('workspace.files.editor.settle.discard') },
          ],
          cancelLabel: translate('workspace.files.cancel'),
        });
        if (answer === 'discard') {
          return 'proceed';
        }
        if (answer === 'save') {
          return (await saveNow()) ? 'proceed' : 'cancel';
        }
        return 'cancel';
      }),
    [translate],
  );
  useEffect(
    () =>
      onCloseRequested(() => {
        void settleOpenEditor().then((settled) => allowClose({ proceed: settled === 'proceed' }));
      }),
    [],
  );
}
