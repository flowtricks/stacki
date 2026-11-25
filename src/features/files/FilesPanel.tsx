// The Files panel: every file and folder of the open project, dotfiles and `.git` included, as VS Code's Explorer
// shows them (docs/contracts.md, "Files panel"). The header creates, refreshes and collapses; the search finds files
// by name across the project; the tree (FileTree.tsx) does the rest. Opening a file shows it over the canvas
// (FileEditorView.tsx). FilesKeeper.tsx reads the tree from the moment the project opens, so the panel paints it from
// filesState.ts in its first frame. Placeholder rows show only while the very first read is still unanswered, and a read
// that fails or never answers ends them: a toast says so and a Refresh button asks again (docs/ui-loading.md).
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
import { refreshFolders } from './filesReader';
import { filesView, updateFilesView, useFilesView } from './filesState';
import './files.css';

// Typing rests this long before a find runs, so each keystroke does not walk the project.
const FIND_SETTLE_MS = 150;

export default function FilesPanel({ host }: { readonly host: FilesHost }) {
  const translate = useTranslate();
  const { projectPath } = host;
  const view = useFilesView(projectPath);
  const [editing, setEditing] = useState<Editing | undefined>(undefined);
  const refresh = useCallback((folders: readonly ExplorerPath[]) => refreshFolders(projectPath, folders), [projectPath]);
  useReadFailures(host, view.failed);
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
  const root = view.listings.get(EXPLORER_ROOT);
  const refreshShown = (): void => refresh([EXPLORER_ROOT, ...view.open]);
  return (
    <section className="files-panel">
      <PanelHeader
        title={translate('workspace.files.title')}
        actions={
          <>
            {/* The Pages panel's order and size: new folder, then new file (PagesPanel.tsx). */}
            <FilesTipButton label={translate('workspace.files.newFolder')} onClick={() => startCreate('directory')}>
              <FolderPlusIcon size={13} />
            </FilesTipButton>
            <FilesTipButton label={translate('workspace.files.newFile')} onClick={() => startCreate('file')}>
              <PlusIcon size={13} />
            </FilesTipButton>
            <FilesTipButton label={translate('workspace.files.refresh')} onClick={refreshShown}>
              <RefreshIcon size={13} />
            </FilesTipButton>
            <FilesTipButton
              label={translate('workspace.files.collapseAll')}
              onClick={() => updateFilesView(projectPath, (current) => ({ ...current, open: new Set() }))}
            >
              <CollapseVerticalIcon size={13} />
            </FilesTipButton>
          </>
        }
      />
      <PanelSearch value={query} placeholder={translate('workspace.files.find')} clearLabel={translate('workspace.files.findClear')} onChange={setQuery} />
      {query.trim() !== '' ? (
        <FindResults projectPath={projectPath} found={found} onPicked={() => setQuery('')} />
      ) : root === undefined && view.failed.has(EXPLORER_ROOT) ? (
        <div className="files-failed">
          <button type="button" onClick={refreshShown}>
            <RefreshIcon size={13} />
            {translate('workspace.files.refresh')}
          </button>
        </div>
      ) : root === undefined ? (
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
      ) : root.entries.length === 0 && editing === undefined ? (
        <EmptyState icon={<FolderIcon size={20} />} title={translate('workspace.files.empty')} />
      ) : (
        <FileTree context={context} view={view} editing={editing} onEdit={setEditing} onCommitName={commitName} />
      )}
    </section>
  );
}

// Says which folder could not be read: one toast per folder while the panel is open, not one per retry. A failure from
// before the panel opened is asked again first and told only if it fails again, so a passing one is never mentioned.
function useReadFailures(host: FilesHost, failed: ReadonlySet<ExplorerPath>): void {
  const translate = useTranslate();
  const { projectPath, showToast } = host;
  const failedAtOpen = useRef(failed);
  const reported = useRef(new Set<ExplorerPath>());
  useEffect(() => {
    refreshFolders(projectPath, [...filesView(projectPath).failed]);
  }, [projectPath]);
  useEffect(() => {
    if (failed === failedAtOpen.current) {
      return;
    }
    for (const folder of failed) {
      if (!reported.current.has(folder)) {
        reported.current.add(folder);
        const name = folder === '' ? (projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath) : baseName(folder);
        showToast(translate('workspace.files.error.read', { name }), 'error');
      }
    }
  }, [failed, projectPath, showToast, translate]);
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
              <span className="files-icon">
                <FileEntryIcon name={name} kind={match.folder ? 'directory' : 'file'} open={false} />
              </span>
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
