// The Files panel in Desktop: the panel and the file editor over the canvas, wired to the app around them. Composed
// here, in the app layer, because the reference-updating moves belong to other features (eslint `stacki/source-layers`):
//
//   - a page file or page folder under the pages folder moves through the Pages panel's planner (`movePageTo`,
//     `renamePageFolder`): internal links, imports and `.stacki/pages.json` follow it;
//   - a component file under a component folder moves through the Components panel's rename (imports, tags and the
//     `.stacki/components.json` recipe keys follow it, with its own Undo);
//   - anything else is a plain move, and nothing in the project's code is rewritten.
//
// A file the canvas has open is edited in the Code panel's editor, inside the file editor's frame: the page editor is
// that file's one writer, so the two can never write over each other.
import { useMemo, useRef } from 'react';
import { isComponentFileName } from '../../../shared/properties/componentNaming';
import { baseName, parentPath, parseExplorerPath, type ExplorerPath } from '../../../shared/ipc/fileExplorer';
import { revealInFiles } from '../../features/files/fileEditorControl';
import { canRailTab } from '../../lib/roleAccess';
import FilesPanel from '../../features/files/FilesPanel';
import FileEditorView from '../../features/files/FileEditorView';
import { codeIntelAnswers } from '../../features/codeIntel/codeIntelSession';
import { useCodeIntel } from '../../features/codeIntel/useCodeIntel';
import type { FilesHost, ReferenceMove } from '../../features/files/filesHost';
import { useFilesView } from '../../features/files/filesState';
import { useCurrentRole } from '../../lib/useCurrentRole';
import type { ShellView } from '../App';
import { CodeTab } from './AppShell';
import { useComponentManagement } from './useComponentManagement';

const PAGE_FILE = /\.(astro|md|mdx)$/i;

/**
 * What the Git panel's list of changes takes from the Files panel: a signal that moves when the marks do (so the list
 * follows an edit or a commit made anywhere), and a way to open a changed file there, for a role that has that panel.
 */
export function useGitChangesHost(app: ShellView): { readonly changesSignal: string; readonly onOpenFile: ((path: string) => void) | undefined } {
  const role = useCurrentRole();
  const projectPath = app.project.path;
  const changesSignal = useFilesView(projectPath).git.answer;
  const { setLeftTab } = app;
  const onOpenFile = (path: string): void => {
    setLeftTab('files');
    revealInFiles(projectPath, parseExplorerPath(path), 'file');
  };
  return { changesSignal, onOpenFile: canRailTab(role, 'files') ? onOpenFile : undefined };
}

export function FilesTab({ app }: { readonly app: ShellView }) {
  const host = useFilesHost(app);
  return <FilesPanel host={host} />;
}

/** The open file over the canvas, shown while the Files panel is the left panel and kept mounted otherwise. */
export function FilesCover({ app }: { readonly app: ShellView }) {
  const projectPath = app.project.path;
  const view = useFilesView(projectPath);
  const editor = view.editor;
  const intelligence = useCodeIntel(projectPath, editor?.path);
  // Which editor a file gets is decided when it opens and kept: switching it later would unmount the other with its
  // unsaved text. Both writers are witnessed by the bytes they read, so neither can write over the other.
  const decided = useRef<{ readonly opening: number; readonly live: boolean } | undefined>(undefined);
  if (editor === undefined) {
    decided.current = undefined;
    return undefined;
  }
  if (decided.current?.opening !== editor.opening) {
    decided.current = { opening: editor.opening, live: isCanvasFile(app, editor.path) };
  }
  const live = decided.current.live;
  return (
    <FileEditorView
      key={`${projectPath}|${editor.opening}`}
      projectPath={projectPath}
      platform={window.avb.platform}
      path={editor.path}
      hidden={app.leftTab !== 'files'}
      showToast={app.showToast}
      // Only a file there is something to ask about: a config or a note keeps the plain editor.
      codeExtensions={codeIntelAnswers(editor.path) ? intelligence : undefined}
      liveEditor={live ? <CodeTab app={app} /> : undefined}
    />
  );
}

function useFilesHost(app: ShellView): FilesHost {
  const management = useComponentManagement(app);
  const { project, showToast, pushCommand } = app;
  // The latest app state, read when a move runs rather than when the host was made.
  const latest = useRef(app);
  latest.current = app;
  return useMemo<FilesHost>(
    () => ({
      projectPath: project.path,
      platform: window.avb.platform,
      showToast,
      recordUndo: (command) => pushCommand({ label: command.label, undo: command.undo, redo: command.redo }),
      referenceMove: (from, to) => referenceMoveFor(latest.current, management.rename, { from, to }),
    }),
    [project.path, showToast, pushCommand, latest, management.rename],
  );
}

function referenceMoveFor(
  app: ShellView,
  rename: ReturnType<typeof useComponentManagement>['rename'],
  move: { readonly from: ExplorerPath; readonly to: ExplorerPath },
): ReferenceMove | undefined {
  const pages = (app.scan.pagesFolder ?? 'src/pages').replace(/\/+$/, '');
  const within = (path: string): string | undefined => (path.startsWith(`${pages}/`) ? path.slice(pages.length + 1) : undefined);
  const fromPage = within(move.from);
  const toPage = within(move.to);
  if (fromPage !== undefined && toPage !== undefined) {
    const page = app.scan.pages.find((each) => samePath(each.path, absoluteOf(app.project.path, move.from)));
    if (page !== undefined && PAGE_FILE.test(move.to)) {
      return async () => {
        try {
          await app.movePageTo(page, toPage);
          return true;
        } catch (error: unknown) {
          app.showToast(error instanceof Error ? error.message : String(error), 'error');
          return false;
        }
      };
    }
    if ((app.scan.pageFolders ?? []).includes(fromPage)) {
      return async () => {
        try {
          await app.renamePageFolder(fromPage, toPage);
          return true;
        } catch (error: unknown) {
          app.showToast(error instanceof Error ? error.message : String(error), 'error');
          return false;
        }
      };
    }
  }
  if (rename === undefined || !/\.astro$/i.test(move.from) || !/\.astro$/i.test(move.to)) {
    return undefined;
  }
  const component = app.scan.components.find((each) => each.file === move.from) ?? app.scan.layouts.find((each) => each.file === move.from);
  const inRoots = (path: string): boolean => rename.roots.some((root) => path.startsWith(`${root.replace(/\/+$/, '')}/`));
  if (component === undefined || !inRoots(move.from) || !inRoots(move.to) || !isComponentFileName(baseName(move.to).replace(/\.astro$/i, ''))) {
    return undefined;
  }
  const sameFolder = parentPath(move.from) === parentPath(move.to);
  const sameName = baseName(move.from) === baseName(move.to);
  const change = sameFolder ? 'rename' : sameName ? 'move' : 'both';
  return () => rename.apply(component, { from: move.from, to: move.to }, change);
}

// Whether `path` is the file the canvas edits: the page, or the component drilled into.
function isCanvasFile(app: ShellView, path: ExplorerPath): boolean {
  const open = app.currentPage;
  if (open === undefined || open.kind === 'route' || app.pageState === undefined) {
    return false;
  }
  return samePath(open.path, absoluteOf(app.project.path, path));
}

function absoluteOf(projectPath: string, path: ExplorerPath): string {
  const separator = window.avb.platform === 'win32' ? '\\' : '/';
  return `${projectPath.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
}

// macOS and Windows folders usually ignore case, so the canvas's path and the panel's may differ only in it.
function samePath(left: string, right: string): boolean {
  const normal = (value: string): string => {
    const slashes = value.replace(/\\/g, '/');
    return window.avb.platform === 'linux' ? slashes : slashes.toLowerCase();
  };
  return normal(left) === normal(right);
}
