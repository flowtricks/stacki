// The Files panel's tree: a WAI-ARIA tree (one focusable container, rows named through aria-activedescendant) drawn
// as a window of fixed-height rows over a spacer, so a folder of thousands of entries costs only the rows on screen.
// Pointer, keyboard, drag and drop, the context menu and the inline name field all end in filesActions.ts; this file
// only decides what was asked for.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { assert } from '../../../shared/core/assert';
import {
  EXPLORER_ROOT,
  baseName,
  entryNameProblem,
  isFolderKind,
  isProtectedPath,
  parentPath,
  parseExplorerPath,
  type ExplorerPath,
} from '../../../shared/ipc/fileExplorer';
import { useTranslate } from '../../lib/i18n/useTranslate';
import FittedTooltip from '../../ui/FittedTooltip';
import { ChevronDownIcon, ChevronRightIcon } from '../../ui/Icons';
import Menu, { type MenuEntry } from '../../ui/Menu';
import { registerMenuEditTarget } from '../../ui/menuEditTarget';
import { currentDesktopPlatform, shortcutLabel } from '../../lib/shortcutLabel';
import { tooltipAnchor, tooltipHost } from '../../ui/delayedTooltip';
import { FileEntryIcon } from '../../ui/ElementIcons';
import { GitStatusBadge, gitTone, gitWords } from '../../ui/GitStatus';
import { fileGitMark } from './fileGitMarks';
import { importInto, trashPaths, transferInto, type FilesActionContext } from './filesActions';
import { revealEntry } from './filesBridge';
import { openInEditor } from './fileEditorControl';
import {
  clickSelection,
  dropFolderOf,
  dropVerdict,
  keyMove,
  rangeBetween,
  rowPath,
  targetFolderOf,
  visibleRows,
  type TreeKey,
  type TreeRow,
} from './fileTreeModel';
import { gitMarksOf, updateFilesView, type FilesView } from './filesState';

/** One row's height: every row is the same, so the window is arithmetic. */
export const ROW_PX = 32;
// Rows drawn above and below the visible window, so a fast scroll never shows a gap.
const OVERSCAN_ROWS = 12;
// How long a drag rests on a closed folder before the folder opens to receive it.
const DRAG_OPEN_DELAY_MS = 700;
const DRAG_TYPE = 'application/x-stacki-files';
const TREE_KEYS: ReadonlySet<string> = new Set(['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End', 'PageDown', 'PageUp']);

export type Editing =
  | { readonly kind: 'rename'; readonly path: ExplorerPath }
  | { readonly kind: 'create'; readonly parent: ExplorerPath; readonly createKind: 'file' | 'directory' };

type DisplayRow = TreeRow | { readonly kind: 'input'; readonly depth: number; readonly editing: Extract<Editing, { readonly kind: 'create' }> };

export interface FileTreeProps {
  readonly context: FilesActionContext;
  readonly view: FilesView;
  readonly editing: Editing | undefined;
  readonly onEdit: (editing: Editing | undefined) => void;
  readonly onCommitName: (editing: Editing, name: string) => void;
}

export function FileTree(props: FileTreeProps) {
  const { context, view, editing } = props;
  const translate = useTranslate();
  const { projectPath, platform } = context.host;
  const tree = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => visibleRows(view), [view]);
  const display = useMemo(() => withInputRow(rows, editing), [rows, editing]);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportPx, setViewportPx] = useState(600);
  const [menu, setMenu] = useState<{ readonly x: number; readonly y: number; readonly row: TreeRow | undefined } | undefined>(undefined);
  const [dropFolder, setDropFolder] = useState<ExplorerPath | undefined>(undefined);
  const dragOpen = useRef<{ readonly path: ExplorerPath; readonly timer: ReturnType<typeof setTimeout> } | undefined>(undefined);

  useLayoutEffect(() => {
    const element = tree.current;
    if (element === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(() => setViewportPx(element.clientHeight));
    observer.observe(element);
    setViewportPx(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const select = useCallback(
    (next: { readonly selected: ReadonlySet<ExplorerPath>; readonly focused: ExplorerPath; readonly anchor?: ExplorerPath }) =>
      updateFilesView(projectPath, (current) => ({ ...current, selected: next.selected, focused: next.focused, anchor: next.anchor ?? current.anchor })),
    [projectPath],
  );
  const toggleFolder = useCallback(
    (path: ExplorerPath, open: boolean) =>
      updateFilesView(projectPath, (current) => {
        const next = new Set(current.open);
        if (open) {
          next.add(path);
        } else {
          next.delete(path);
        }
        return { ...current, open: next };
      }),
    [projectPath],
  );
  const activate = useCallback(
    (row: TreeRow) => {
      if (row.kind !== 'entry') {
        return;
      }
      if (isFolderKind(row.entryKind)) {
        toggleFolder(row.path, row.open !== true);
        return;
      }
      if (row.entryKind === 'file' || row.entryKind === 'link-file') {
        void openInEditor(projectPath, row.path);
      }
    },
    [projectPath, toggleFolder],
  );

  const selectedPaths = useCallback((): readonly ExplorerPath[] => {
    const chosen = [...view.selected].filter((path) => path !== '');
    return chosen.length > 0 ? chosen : view.focused === undefined ? [] : [view.focused];
  }, [view.selected, view.focused]);

  const clipboard = useMemo(
    () => ({
      copy: () => updateFilesView(projectPath, (current) => ({ ...current, clipboard: { mode: 'copy', paths: selectedPaths() } })),
      cut: () =>
        updateFilesView(projectPath, (current) => ({
          ...current,
          clipboard: { mode: 'cut', paths: selectedPaths().filter((path) => !isProtectedPath(path)) },
        })),
      paste: (target: ExplorerPath) => {
        const held = view.clipboard;
        if (held === undefined || held.paths.length === 0 || isProtectedPath(target)) {
          return;
        }
        if (held.mode === 'cut') {
          updateFilesView(projectPath, (current) => ({ ...current, clipboard: undefined }));
        }
        void transferInto(context, held.paths, target, held.mode === 'cut' ? 'move' : 'copy');
      },
    }),
    [context, projectPath, selectedPaths, view.clipboard],
  );
  useEffect(() => {
    const element = tree.current;
    if (element === null) {
      return undefined;
    }
    return registerMenuEditTarget(element, { copy: clipboard.copy, paste: () => clipboard.paste(targetFolderOf(rows, view.focused)) });
  }, [clipboard, rows, view.focused]);

  const scrollToRow = (path: ExplorerPath): void => {
    const element = tree.current;
    const index = display.findIndex((row) => row.kind === 'entry' && row.path === path);
    if (element === null || index < 0) {
      return;
    }
    const top = index * ROW_PX;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (top + ROW_PX > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + ROW_PX - element.clientHeight;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget) {
      return;
    }
    const focusedRow = rows.find((row) => row.kind === 'entry' && row.path === view.focused);
    if (TREE_KEYS.has(event.key)) {
      event.preventDefault();
      const move = keyMove(rows, view.focused, treeKey(event.key), Math.max(1, Math.floor(viewportPx / ROW_PX) - 1));
      if (move.kind === 'focus') {
        const extend = event.shiftKey && view.anchor !== undefined;
        select({
          selected: extend && view.anchor !== undefined ? new Set(rangeBetween(rows, view.anchor, move.path)) : new Set([move.path]),
          focused: move.path,
          ...(extend ? {} : { anchor: move.path }),
        });
        scrollToRow(move.path);
      } else if (move.kind === 'open' || move.kind === 'close') {
        toggleFolder(move.path, move.kind === 'open');
      }
      return;
    }
    if (focusedRow === undefined || focusedRow.kind !== 'entry') {
      return;
    }
    if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      if (!focusedRow.protected) {
        props.onEdit({ kind: 'rename', path: focusedRow.path });
      }
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      activate(focusedRow);
      return;
    }
    if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault();
      const paths = selectedPaths().filter((path) => !isProtectedPath(path));
      if (paths.length > 0) {
        void trashPaths(context, paths);
      }
      return;
    }
    if (event.key === 'Escape') {
      updateFilesView(projectPath, (current) => ({
        ...current,
        clipboard: undefined,
        selected: new Set(current.focused === undefined ? [] : [current.focused]),
      }));
      return;
    }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const index = display.indexOf(focusedRow);
      const box = tree.current?.getBoundingClientRect();
      setMenu({ x: (box?.left ?? 0) + 24, y: (box?.top ?? 0) + (index + 1) * ROW_PX - (tree.current?.scrollTop ?? 0), row: focusedRow });
    }
  };

  const onRowClick = (event: MouseEvent, row: TreeRow): void => {
    const path = rowPath(row);
    if (path === undefined) {
      return;
    }
    tree.current?.focus();
    const toggle = event.metaKey || event.ctrlKey;
    const extend = event.shiftKey;
    select({
      selected: clickSelection(rows, view.selected, { path, anchor: view.anchor, toggle, extend }),
      focused: path,
      ...(extend ? {} : { anchor: path }),
    });
    if (!toggle && !extend) {
      activate(row);
    }
  };

  const openMenu = (event: MouseEvent, row: TreeRow | undefined): void => {
    event.preventDefault();
    event.stopPropagation();
    tree.current?.focus();
    const path = row === undefined ? undefined : rowPath(row);
    if (path !== undefined && !view.selected.has(path)) {
      select({ selected: new Set([path]), focused: path, anchor: path });
    }
    setMenu({ x: event.clientX, y: event.clientY, row });
  };

  // Drags: entries of this tree carry their paths; files from the operating system carry File objects.
  const draggedPaths = (event: DragEvent): readonly ExplorerPath[] | undefined => {
    if (!event.dataTransfer.types.includes(DRAG_TYPE)) {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(event.dataTransfer.getData(DRAG_TYPE));
      return Array.isArray(parsed) ? parsed.map((each: unknown) => parseExplorerPath(each)) : undefined;
    } catch {
      return undefined;
    }
  };
  const clearDragOpen = (): void => {
    if (dragOpen.current !== undefined) {
      clearTimeout(dragOpen.current.timer);
      dragOpen.current = undefined;
    }
  };
  const onDragOver = (event: DragEvent, row: TreeRow | undefined): void => {
    const folder = dropFolderOf(row);
    const internal = event.dataTransfer.types.includes(DRAG_TYPE);
    const external = event.dataTransfer.types.includes('Files');
    if (!internal && !external) {
      return;
    }
    if (isProtectedPath(folder)) {
      setDropFolder(undefined);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const transfer = event.dataTransfer;
    transfer.dropEffect = internal && !(event.altKey || event.ctrlKey) ? 'move' : 'copy';
    setDropFolder(folder);
    if (row?.kind === 'entry' && row.open === false && dragOpen.current?.path !== row.path) {
      clearDragOpen();
      const path = row.path;
      dragOpen.current = { path, timer: setTimeout(() => toggleFolder(path, true), DRAG_OPEN_DELAY_MS) };
    }
  };
  const onDrop = (event: DragEvent, row: TreeRow | undefined): void => {
    clearDragOpen();
    setDropFolder(undefined);
    const folder = dropFolderOf(row);
    if (isProtectedPath(folder)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const paths = draggedPaths(event);
    if (paths !== undefined) {
      const mode = event.altKey || event.ctrlKey ? 'copy' : 'move';
      const verdict = dropVerdict(paths, folder, mode);
      if (verdict.kind === 'allowed') {
        void transferInto(context, paths, folder, mode);
      } else if (verdict.reason !== 'same-folder') {
        context.host.showToast(translate(verdict.reason === 'protected' ? 'workspace.files.protected' : 'workspace.files.error.intoItself'), 'error');
      }
      return;
    }
    const sources = [...event.dataTransfer.files]
      .map((file) => window.avb.getFilePath(file))
      .filter((each): each is string => typeof each === 'string' && each.length > 0);
    void importInto(context, sources, folder);
  };
  const onDragStart = (event: DragEvent, row: TreeRow): void => {
    const path = rowPath(row);
    if (path === undefined || row.kind !== 'entry' || row.protected) {
      event.preventDefault();
      return;
    }
    const paths = view.selected.has(path) ? selectedPaths().filter((each) => !isProtectedPath(each)) : [path];
    const transfer = event.dataTransfer;
    transfer.setData(DRAG_TYPE, JSON.stringify(paths));
    transfer.effectAllowed = 'copyMove';
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_PX) - OVERSCAN_ROWS);
  const last = Math.min(display.length, Math.ceil((scrollTop + viewportPx) / ROW_PX) + OVERSCAN_ROWS);
  const focusedIndex = display.findIndex((row) => row.kind === 'entry' && row.path === view.focused);
  return (
    <>
      <div
        ref={tree}
        className="files-tree"
        role="tree"
        aria-label={translate('workspace.files.tree')}
        aria-multiselectable="true"
        aria-activedescendant={focusedIndex >= 0 ? rowId(focusedIndex) : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onContextMenu={(event) => openMenu(event, undefined)}
        onDragOver={(event) => onDragOver(event, undefined)}
        onDragLeave={() => setDropFolder(undefined)}
        onDrop={(event) => onDrop(event, undefined)}
        onCut={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            clipboard.cut();
          }
        }}
        data-drop-root={dropFolder === EXPLORER_ROOT ? 'true' : undefined}
      >
        <div className="files-tree-space" style={{ height: display.length * ROW_PX }}>
          {display.slice(first, last).map((row, offset) => {
            const index = first + offset;
            const top = index * ROW_PX;
            if (row.kind === 'input') {
              return (
                <div
                  key="files-input"
                  className="files-row files-row-input"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-selected="false"
                  style={{ top, paddingInlineStart: indent(row.depth) }}
                >
                  <span className="files-chevron" aria-hidden="true" />
                  <FileEntryIcon name="" kind={row.editing.createKind === 'directory' ? 'directory' : 'file'} open={false} />
                  <NameInput
                    initial=""
                    platform={platform}
                    onCommit={(name) => props.onCommitName(row.editing, name)}
                    onCancel={() => props.onEdit(undefined)}
                  />
                </div>
              );
            }
            if (row.kind === 'more') {
              return (
                <div
                  key={`more:${row.path}`}
                  id={rowId(index)}
                  className="files-row files-row-more"
                  role="treeitem"
                  aria-level={row.depth + 1}
                  aria-disabled="true"
                  aria-selected="false"
                  style={{ top, paddingInlineStart: indent(row.depth) + 18 }}
                >
                  {translate('workspace.files.more', { count: row.hidden })}
                </div>
              );
            }
            const renaming = editing?.kind === 'rename' && editing.path === row.path;
            const selected = view.selected.has(row.path);
            const cut = view.clipboard?.mode === 'cut' && view.clipboard.paths.includes(row.path);
            const dirty = view.editor?.path === row.path && view.editor.dirty;
            const mark = fileGitMark(gitMarksOf(view), row.path, { folder: isFolderKind(row.entryKind) });
            return (
              <div
                key={row.path}
                id={rowId(index)}
                className="files-row"
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected}
                aria-expanded={row.open}
                aria-busy={row.loading ? 'true' : undefined}
                // A dimmed row has no badge to speak for it; a letter or dot says its own words (ui/GitStatus.tsx).
                aria-description={row.protected ? translate('workspace.files.protected') : mark?.kind === 'ignored' ? gitWords(mark, translate) : undefined}
                data-git={gitTone(mark)}
                data-selected={selected ? 'true' : undefined}
                data-focused={index === focusedIndex ? 'true' : undefined}
                data-open-file={view.editor?.path === row.path ? 'true' : undefined}
                data-protected={row.protected ? 'true' : undefined}
                data-cut={cut ? 'true' : undefined}
                data-drop={isFolderKind(row.entryKind) && dropFolder === row.path ? 'true' : undefined}
                data-path={row.path}
                draggable={!row.protected && !renaming}
                style={{ top, paddingInlineStart: indent(row.depth) }}
                onClick={(event) => onRowClick(event, row)}
                onContextMenu={(event) => openMenu(event, row)}
                onDragStart={(event) => onDragStart(event, row)}
                onDragOver={(event) => onDragOver(event, row)}
                onDrop={(event) => onDrop(event, row)}
                onDragEnd={() => {
                  clearDragOpen();
                  setDropFolder(undefined);
                }}
              >
                <span
                  className="files-chevron"
                  aria-hidden="true"
                  data-open={row.open === true ? 'true' : undefined}
                  onClick={(event) => {
                    if (row.open !== undefined) {
                      event.stopPropagation();
                      toggleFolder(row.path, !row.open);
                    }
                  }}
                >
                  {row.open === true && <ChevronDownIcon size={12} />}
                  {row.open === false && <ChevronRightIcon size={12} className="icon-mirror-rtl" />}
                </span>
                <span className="files-icon">
                  <FileEntryIcon name={row.name} kind={row.entryKind} open={row.open} />
                </span>
                {renaming ? (
                  <NameInput
                    initial={row.name}
                    platform={platform}
                    onCommit={(name) => props.onCommitName(editing, name)}
                    onCancel={() => props.onEdit(undefined)}
                  />
                ) : (
                  <span className="files-name">
                    <bdi dir="ltr">{row.name}</bdi>
                  </span>
                )}
                {dirty && <span className="files-dirty" aria-label={translate('workspace.files.editor.unsaved')} />}
                <GitStatusBadge mark={mark} />
              </div>
            );
          })}
        </div>
      </div>
      {menu !== undefined && (
        <ContextMenu context={context} view={view} rows={rows} at={menu} onEdit={props.onEdit} clipboard={clipboard} onClose={() => setMenu(undefined)} />
      )}
    </>
  );
}

function treeKey(key: string): TreeKey {
  assert(TREE_KEYS.has(key), 'treeKey: a tree key');
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp':
    case 'ArrowRight':
    case 'ArrowLeft':
    case 'Home':
    case 'End':
    case 'PageDown':
    case 'PageUp':
      return key;
    default:
      throw new Error('treeKey: not a tree key');
  }
}

function rowId(index: number): string {
  return `files-row-${index}`;
}

// The Navigator's indent: its row padding, then 12px a level (styles.css, .navigator).
function indent(depth: number): number {
  return 6 + depth * 12;
}

// The rows with the new-entry field placed first inside its folder (the root's at the top).
function withInputRow(rows: readonly TreeRow[], editing: Editing | undefined): readonly DisplayRow[] {
  if (editing?.kind !== 'create') {
    return rows;
  }
  if (editing.parent === EXPLORER_ROOT) {
    return [{ kind: 'input', depth: 0, editing }, ...rows];
  }
  const index = rows.findIndex((row) => row.kind === 'entry' && row.path === editing.parent);
  const parent = rows[index];
  if (parent === undefined || parent.kind !== 'entry') {
    return rows;
  }
  return [...rows.slice(0, index + 1), { kind: 'input', depth: parent.depth + 1, editing }, ...rows.slice(index + 1)];
}

// ---------------------------------------------------------------------------
// The inline name field
// ---------------------------------------------------------------------------

const PROBLEM_KEYS = {
  empty: 'workspace.files.nameProblem.empty',
  reserved: 'workspace.files.nameProblem.reserved',
  separator: 'workspace.files.nameProblem.separator',
  control: 'workspace.files.nameProblem.control',
  'too-long': 'workspace.files.nameProblem.tooLong',
  whitespace: 'workspace.files.nameProblem.whitespace',
  'windows-character': 'workspace.files.nameProblem.windowsCharacter',
  'windows-name': 'workspace.files.nameProblem.windowsName',
} as const;

function NameInput(props: { readonly initial: string; readonly platform: string; readonly onCommit: (name: string) => void; readonly onCancel: () => void }) {
  const translate = useTranslate();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(props.initial);
  const settled = useRef(false);
  const problem = entryNameProblem(value, props.platform);
  useLayoutEffect(() => {
    const element = input.current;
    if (element === null) {
      return;
    }
    element.focus();
    // The name without its extension is selected, as Finder and VS Code do: typing replaces the name, not the type.
    const dot = props.initial.lastIndexOf('.');
    element.setSelectionRange(0, dot > 0 ? dot : props.initial.length);
  }, [props.initial]);
  const finish = ({ commit }: { readonly commit: boolean }): void => {
    if (settled.current) {
      return;
    }
    if (commit && problem === undefined && value !== props.initial) {
      settled.current = true;
      props.onCommit(value);
      return;
    }
    if (commit && problem !== undefined && value !== '') {
      return;
    }
    settled.current = true;
    props.onCancel();
  };
  const box = input.current?.getBoundingClientRect();
  return (
    <>
      <input
        ref={input}
        className="files-name-input"
        aria-label={translate('workspace.files.name')}
        aria-invalid={problem !== undefined && value !== '' ? 'true' : undefined}
        value={value}
        spellCheck={false}
        dir="ltr"
        onChange={(event) => setValue(event.currentTarget.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            event.preventDefault();
            finish({ commit: true });
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish({ commit: false });
          }
        }}
        onBlur={() => finish({ commit: problem === undefined })}
      />
      {problem !== undefined && value !== '' && box !== undefined
        ? createPortal(
            <FittedTooltip role="tooltip" anchor={tooltipAnchor(box)}>
              {translate(PROBLEM_KEYS[problem])}
            </FittedTooltip>,
            tooltipHost(input.current ?? undefined),
          )
        : undefined}
    </>
  );
}

// ---------------------------------------------------------------------------
// The context menu
// ---------------------------------------------------------------------------

function ContextMenu(props: {
  readonly context: FilesActionContext;
  readonly view: FilesView;
  readonly rows: readonly TreeRow[];
  readonly at: { readonly x: number; readonly y: number; readonly row: TreeRow | undefined };
  readonly clipboard: { readonly copy: () => void; readonly cut: () => void; readonly paste: (target: ExplorerPath) => void };
  readonly onEdit: (editing: Editing | undefined) => void;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const [anchor, setAnchor] = useState<HTMLElement | undefined>(undefined);
  const { context, view, at, clipboard } = props;
  const { projectPath, platform } = context.host;
  const row = at.row?.kind === 'entry' ? at.row : undefined;
  const target = row === undefined ? EXPLORER_ROOT : dropFolderOf(row);
  const paths = row === undefined ? [] : view.selected.has(row.path) ? [...view.selected] : [row.path];
  const locked = paths.some((path) => isProtectedPath(path));
  const targetLocked = isProtectedPath(target);
  const separator = platform === 'win32' ? '\\' : '/';
  const absolute = (path: ExplorerPath): string => (path === '' ? projectPath : `${projectPath}${separator}${path.split('/').join(separator)}`);
  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => context.host.showToast(translate('workspace.files.copied'), 'success'),
      () => undefined,
    );
  };
  const chord = (key: string): string => shortcutLabel(key, 'primary', currentDesktopPlatform());
  const revealLabel =
    platform === 'darwin'
      ? 'workspace.files.menu.revealFinder'
      : platform === 'win32'
        ? 'workspace.files.menu.revealExplorer'
        : 'workspace.files.menu.revealFileManager';
  const entries: MenuEntry[] = [];
  if (row !== undefined && (row.entryKind === 'file' || row.entryKind === 'link-file')) {
    entries.push(
      { kind: 'item', id: 'open', label: translate('workspace.files.menu.open'), onSelect: () => void openInEditor(projectPath, row.path) },
      { kind: 'divider', id: 'd-open' },
    );
  }
  entries.push(
    {
      kind: 'item',
      id: 'new-file',
      label: translate('workspace.files.newFile'),
      disabled: targetLocked,
      onSelect: () => props.onEdit({ kind: 'create', parent: target, createKind: 'file' }),
    },
    {
      kind: 'item',
      id: 'new-folder',
      label: translate('workspace.files.newFolder'),
      disabled: targetLocked,
      onSelect: () => props.onEdit({ kind: 'create', parent: target, createKind: 'directory' }),
    },
    { kind: 'divider', id: 'd-new' },
  );
  if (row !== undefined) {
    entries.push(
      { kind: 'item', id: 'cut', label: translate('workspace.files.menu.cut'), disabled: locked, onSelect: clipboard.cut },
      { kind: 'item', id: 'copy', label: translate('workspace.files.menu.copy'), shortcut: chord('C'), onSelect: clipboard.copy },
    );
  }
  entries.push({
    kind: 'item',
    id: 'paste',
    label: translate('workspace.files.menu.paste'),
    shortcut: chord('V'),
    disabled: view.clipboard === undefined || view.clipboard.paths.length === 0 || targetLocked,
    onSelect: () => clipboard.paste(target),
  });
  if (row !== undefined) {
    entries.push({
      kind: 'item',
      id: 'duplicate',
      label: translate('workspace.files.menu.duplicate'),
      disabled: locked,
      onSelect: () => void transferInto(context, paths, parentPath(row.path) ?? EXPLORER_ROOT, 'copy'),
    });
  }
  const shown = row?.path ?? EXPLORER_ROOT;
  entries.push(
    { kind: 'divider', id: 'd-paths' },
    {
      kind: 'item',
      id: 'copy-path',
      label: translate('workspace.files.menu.copyPath'),
      onSelect: () => copyText(paths.length > 0 ? paths.map(absolute).join('\n') : absolute(shown)),
    },
    {
      kind: 'item',
      id: 'copy-relative',
      label: translate('workspace.files.menu.copyRelativePath'),
      onSelect: () => copyText(paths.length > 0 ? paths.join('\n') : '.'),
    },
    {
      kind: 'item',
      id: 'reveal',
      label: translate(revealLabel),
      onSelect: () =>
        void revealEntry(projectPath, shown).then((revealed) => {
          if (!revealed.ok) {
            context.host.showToast(translate('workspace.files.error.missing', { name: baseName(shown) }), 'error');
          }
        }),
    },
  );
  if (row !== undefined) {
    entries.push(
      { kind: 'divider', id: 'd-change' },
      {
        kind: 'item',
        id: 'rename',
        label: translate('workspace.files.menu.rename'),
        disabled: locked || paths.length !== 1,
        onSelect: () => props.onEdit({ kind: 'rename', path: row.path }),
      },
      {
        kind: 'item',
        id: 'trash',
        label: translate('workspace.files.menu.trash'),
        // The Navigator's Delete key, told the same way (StructureContextMenu.tsx).
        shortcut: platform === 'darwin' ? '⌘⌫' : 'Del',
        danger: true,
        disabled: locked,
        onSelect: () => void trashPaths(context, paths),
      },
    );
  }
  return (
    <>
      <span ref={(element) => setAnchor(element ?? undefined)} className="files-menu-anchor" style={{ left: at.x, top: at.y }} aria-hidden="true" />
      {anchor !== undefined && <Menu open anchor={anchor} entries={entries} label={translate('workspace.files.menu.label')} onClose={props.onClose} />}
    </>
  );
}
