// The Files panel: every file and folder of the open project, dotfiles and `.git` included, as VS Code's Explorer
// shows them (docs/contracts.md, "Files panel"). The header creates, refreshes and collapses; the search finds files
// by name across the project; the tree (FileTree.tsx) does the rest. Opening a file shows it over the canvas
// (FileEditorView.tsx). The panel paints its last tree at once from filesState.ts and reads again in place; only the
// first open of a project, before any listing, shows placeholder rows (docs/ui-loading.md).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EXPLORER_ROOT, baseName, isProtectedPath, parentPath, type ExplorerPath, type FindAnswer } from '../../../shared/ipc/fileExplorer';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { EmptyState } from '../../ui/EmptyState';
import { CollapseVerticalIcon, FolderIcon, FolderPlusIcon, PlusIcon, RefreshIcon, SearchIcon } from '../../ui/Icons';
import { PanelHeader } from '../../ui/PanelHeader';
import { PanelSearch } from '../../ui/PanelSearch';
import { Skeleton, SkeletonRows } from '../../ui/Skeleton';
import { FileEntryIcon } from './fileIcons';
import { createIn, renameTo, type FilesActionContext } from './filesActions';
import { findFiles } from './filesBridge';
import { openInEditor } from './fileEditorControl';
import type { FilesHost } from './filesHost';
import { targetFolderOf, visibleRows } from './fileTreeModel';
import { FilesTipButton } from './FilesTipButton';
import { FileTree, type Editing } from './FileTree';
import { updateFilesView, useFilesView } from './filesState';
import { useFilesLoader } from './useFilesLoader';
import './files.css';

// Typing rests this long before a find runs, so each keystroke does not walk the project.
const FIND_SETTLE_MS = 150;

export default function FilesPanel({ host }: { readonly host: FilesHost }) {
  const translate = useTranslate();
  const { projectPath } = host;
  const view = useFilesView(projectPath);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const reported = useRef(new Set<ExplorerPath>());
  const refresh = useFilesLoader(projectPath, view, (folder) => {
    // One toast per folder that could not be read, not one per retry.
    if (!reported.current.has(folder)) {
      reported.current.add(folder);
      host.showToast(
        translate('workspace.files.error.filesystem', {
          name: folder === '' ? (projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath) : baseName(folder),
        }),
        'error',
      );
    }
  });
  const context = useMemo<FilesActionContext>(() => ({ host, translate, refresh }), [host, translate, refresh]);
  const rows = useMemo(() => visibleRows(view), [view]);

  const startCreate = (createKind: 'file' | 'directory'): void => {
    const parent = targetFolderOf(rows, view.focused);
    const safe = isProtectedPath(parent) ? EXPLORER_ROOT : parent;
    if (safe !== EXPLORER_ROOT && !view.open.has(safe)) {
      updateFilesView(projectPath, (current) => ({ ...current, open: new Set([...current.open, safe]) }));
    }
    setEditing({ kind: 'create', parent: safe, createKind });
  };
  const commitName = useCallback(
    (done: Editing, name: string) => {
      setEditing(undefined);
      if (done.kind === 'rename') {
        void renameTo(context, done.path, name);
        return;
      }
      void createIn(context, done.parent, name, done.createKind).then((created) => {
        if (created !== undefined && done.createKind === 'file') {
          void openInEditor(projectPath, created);
        }
      });
    },
    [context, projectPath],
  );

  const [query, setQuery] = useState('');
  const found = useFind(projectPath, query);
  const rootListed = view.listings.has(EXPLORER_ROOT);
  const root = view.listings.get(EXPLORER_ROOT);
  return (
    <section className="files-panel">
      <PanelHeader
        title={translate('workspace.files.title')}
        actions={
          <>
            <FilesTipButton label={translate('workspace.files.newFile')} onClick={() => startCreate('file')}>
              <PlusIcon size={14} />
            </FilesTipButton>
            <FilesTipButton label={translate('workspace.files.newFolder')} onClick={() => startCreate('directory')}>
              <FolderPlusIcon size={14} />
            </FilesTipButton>
            <FilesTipButton label={translate('workspace.files.refresh')} onClick={() => refresh([EXPLORER_ROOT, ...view.open])}>
              <RefreshIcon size={14} />
            </FilesTipButton>
            <FilesTipButton
              label={translate('workspace.files.collapseAll')}
              onClick={() => updateFilesView(projectPath, (current) => ({ ...current, open: new Set() }))}
            >
              <CollapseVerticalIcon size={14} />
            </FilesTipButton>
          </>
        }
      />
      <PanelSearch value={query} placeholder={translate('workspace.files.find')} clearLabel={translate('workspace.files.findClear')} onChange={setQuery} />
      {query.trim() !== '' ? (
        <FindResults projectPath={projectPath} found={found} onPicked={() => setQuery('')} />
      ) : !rootListed ? (
        <div className="files-loading">
          <SkeletonRows
            count={8}
            row={(width) => (
              <div className="files-skeleton-row">
                <Skeleton width="14px" height="14px" radius="3px" />
                <Skeleton width={`${width}%`} height="10px" />
              </div>
            )}
          />
        </div>
      ) : root !== undefined && root.entries.length === 0 && editing === undefined ? (
        <EmptyState icon={<FolderIcon size={20} />} title={translate('workspace.files.empty')} />
      ) : (
        <FileTree context={context} view={view} editing={editing} onEdit={setEditing} onCommitName={commitName} />
      )}
    </section>
  );
}

type FindState = { readonly kind: 'idle' } | { readonly kind: 'ready'; readonly matches: FindAnswer['matches']; readonly complete: boolean };

// The project-wide find: the latest query wins, and an older answer arriving late is dropped.
function useFind(projectPath: string, query: string): FindState {
  const [state, setState] = useState<FindState>({ kind: 'idle' });
  useEffect(() => {
    const needle = query.trim();
    if (needle === '') {
      setState({ kind: 'idle' });
      return undefined;
    }
    let active = true;
    const timer = setTimeout(() => {
      void findFiles(projectPath, needle).then((answer) => {
        if (active) {
          setState(
            answer.ok ? { kind: 'ready', matches: answer.value.matches, complete: answer.value.complete } : { kind: 'ready', matches: [], complete: true },
          );
        }
      });
    }, FIND_SETTLE_MS);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [projectPath, query]);
  return state;
}

function FindResults(props: { readonly projectPath: string; readonly found: FindState; readonly onPicked: () => void }) {
  const translate = useTranslate();
  const { found, projectPath } = props;
  if (found.kind === 'idle') {
    return (
      <div className="files-loading">
        <SkeletonRows count={4} />
      </div>
    );
  }
  if (found.matches.length === 0) {
    return <EmptyState icon={<SearchIcon size={20} />} title={translate('workspace.files.findNone')} />;
  }
  // Picking a result opens every folder above it and selects it in the tree; a file also opens in the editor.
  const pick = (path: ExplorerPath, kind: 'file' | 'folder'): void => {
    updateFilesView(projectPath, (view) => {
      const open = new Set(view.open);
      let parent = parentPath(path);
      while (parent !== undefined && parent !== EXPLORER_ROOT) {
        open.add(parent);
        parent = parentPath(parent);
      }
      if (kind === 'folder') {
        open.add(path);
      }
      return { ...view, open, selected: new Set([path]), focused: path, anchor: path };
    });
    if (kind === 'file') {
      void openInEditor(projectPath, path);
    }
    props.onPicked();
  };
  return (
    <ul className="files-results" aria-label={translate('workspace.files.find')}>
      {found.matches.map((match) => {
        const name = baseName(match.path);
        const folder = parentPath(match.path) ?? EXPLORER_ROOT;
        return (
          <li key={match.path}>
            <button type="button" className="files-result" onClick={() => pick(match.path, match.folder ? 'folder' : 'file')}>
              <FileEntryIcon name={name} kind={match.folder ? 'directory' : 'file'} open={false} />
              <span className="files-name">
                <bdi dir="ltr">{name}</bdi>
              </span>
              <span className="files-result-folder">
                <bdi dir="ltr">{folder}</bdi>
              </span>
            </button>
          </li>
        );
      })}
      {!found.complete && <li className="files-results-more">{translate('workspace.files.findMore')}</li>}
    </ul>
  );
}
