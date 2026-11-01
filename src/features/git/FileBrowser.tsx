import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, FolderOpenIcon } from '../../ui/Icons';
import FileStatus from './FileStatus';
import { assert } from '../../../shared/core/assert';

const FILE_LIMITS = { entriesMax: 100_000, pathCharsMax: 8_192, depthMax: 64 } as const;
export interface BrowserFile {
  readonly path: string;
  readonly name?: string;
  readonly status?: string | undefined;
}
interface FileTree<T extends BrowserFile> {
  readonly dirs: ReadonlyMap<string, FileTree<T>>;
  readonly files: readonly (T & { readonly name: string })[];
}
interface TreeBuilder<T extends BrowserFile> {
  dirs: Map<string, TreeBuilder<T>>;
  files: (T & { readonly name: string })[];
}

// Every file in the project, as a tree you can search and tick.
//
// Two things needed the same thing and each had half of it: the commit picker
// listed only files that had changed, flat and with no way to find anything;
// the History panel could say what a version touched but never what the
// project actually contains. So this is one component doing both — the whole
// project, with what has happened to each file marked on it.
//
// It stays useful at both sizes. A project with eight files should not make
// you expand anything; one with eight hundred should be searchable and should
// not draw eight hundred rows. Hence: folders start open when the project is
// small, search flattens the tree to matches only, and ticking a folder ticks
// what is inside it.

// --- Searching --------------------------------------------------------------
//
// Subsequence matching, the way editors do it: "spi" finds "src/pages/index".
// Plain substring matching would not, and typing the separators is exactly the
// work this is meant to save.
export function fuzzyScore(query: string, path: string): number {
  assert(query.length <= FILE_LIMITS.pathCharsMax, 'FileBrowser: query limit exceeded');
  assert(path.length <= FILE_LIMITS.pathCharsMax, 'FileBrowser: path limit exceeded');
  const queryLower = query.toLowerCase();
  const pathLower = path.toLowerCase();
  if (!queryLower) {
    return 0;
  }
  let qi = 0;
  let score = 0;
  let streak = 0;
  let firstHit = -1;
  for (let i = 0; i < pathLower.length && qi < queryLower.length; i++) {
    if (pathLower[i] !== queryLower[qi]) {
      streak = 0;
      continue;
    }
    if (firstHit === -1) {
      firstHit = i;
    }
    // Runs of consecutive matches are worth more than the same letters
    // scattered, so "index" beats "i…n…d…e…x" spread across a long path.
    streak++;
    score += 1 + streak;
    // A match right after a separator is the start of a name, which is nearly
    // always what was meant.
    if (i === 0 || '/-_.'.includes(pathLower.charAt(i - 1))) {
      score += 4;
    }
    qi++;
  }
  if (qi < queryLower.length) {
    return -1;
  } // not all of the query is in there
  // Shorter paths, and matches nearer the front, first.
  return score - firstHit * 0.05 - pathLower.length * 0.02;
}

/** The best matches for a query, most likely first. */
export function search<T extends BrowserFile>(files: readonly T[], query: string, limit = 60): T[] {
  assert(files.length <= FILE_LIMITS.entriesMax, 'FileBrowser: file limit exceeded');
  assert(Number.isSafeInteger(limit), 'FileBrowser: valid result limit');
  assert(limit >= 0, 'FileBrowser: valid result limit');
  if (!query.trim()) {
    return [];
  }
  return files
    .map((file) => ({ file: file, score: fuzzyScore(query.trim(), file.path) }))
    .filter((scored) => scored.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((scored) => scored.file);
}

// --- The tree ---------------------------------------------------------------

/** Files grouped into nested folders, folders before files, both by name. */
export function buildTree<T extends BrowserFile>(files: readonly T[]): FileTree<T> {
  assert(files.length <= FILE_LIMITS.entriesMax, 'FileBrowser: file limit exceeded');
  // This builder alone owns mutation. Renderers receive only its readonly projection.
  const root: TreeBuilder<T> = { dirs: new Map(), files: [] };
  const nodes = [root];
  for (const file of files) {
    assert(file.path.length <= FILE_LIMITS.pathCharsMax, 'FileBrowser: path limit exceeded');
    const parts = file.path.split('/');
    assert(parts.length <= FILE_LIMITS.depthMax, 'FileBrowser: path depth limit exceeded');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.dirs.get(part);
      if (!child) {
        assert(nodes.length < FILE_LIMITS.entriesMax, 'FileBrowser: folder limit exceeded');
        child = { dirs: new Map(), files: [] };
        node.dirs.set(part, child);
        nodes.push(child);
      }
      node = child;
    }
    const name = parts.at(-1);
    assert(name !== undefined, 'FileBrowser: split path includes a basename');
    node.files.push({ ...file, name });
  }
  for (const node of nodes) {
    node.files.sort((left, right) => left.name.localeCompare(right.name));
    node.dirs = new Map([...node.dirs.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
  return root;
}

/** Every file path under a folder, for ticking the folder as one. */
function pathsUnder<T extends BrowserFile>(node: FileTree<T>): string[] {
  const pending = [node];
  const paths: string[] = [];
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < FILE_LIMITS.entriesMax, 'FileBrowser: subtree folder limit exceeded');
    const current = pending.pop();
    assert(current !== undefined, 'FileBrowser: queued folder exists');
    for (const file of current.files) {
      paths.push(file.path);
    }
    assert(paths.length <= FILE_LIMITS.entriesMax, 'FileBrowser: subtree file limit exceeded');
    // Reversed children preserve the legacy depth-first order without shifting the worklist.
    pending.push(...[...current.dirs.values()].reverse());
  }
  return paths;
}

interface FileBrowserProps<T extends BrowserFile> {
  readonly files: readonly T[];
  readonly selectable?: boolean;
  readonly selected?: readonly string[];
  readonly onSelect?: (paths: string[]) => void;
  readonly onOpen?: (file: T) => void;
  readonly emptyMessage?: string;
  readonly autoFocusSearch?: boolean;
}

export default function FileBrowser<T extends BrowserFile>(props: FileBrowserProps<T>) {
  const { files, selected, onSelect, emptyMessage = 'No files.' } = props;
  const state = useFileBrowser(props);
  const { query, setQuery, inputRef, matches, searching, selectable, tree, onKeyDown } = state;
  return (
    <div className="file-browser">
      <div className="fb-search">
        <input ref={inputRef} value={query} placeholder="Search files…" onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        {query && (
          <button className="ghost" onClick={() => setQuery('')} title="Clear">
            ×
          </button>
        )}
      </div>

      <div className="fb-list">
        {!files?.length && <div className="fb-empty">{emptyMessage}</div>}

        {searching ? (
          <>
            {!matches.length && <div className="fb-empty">Nothing matches “{query}”.</div>}
            {matches.map((file, i) => (
              <FileRow state={state} key={file.path} file={file} depth={0} index={i} />
            ))}
          </>
        ) : (
          files?.length > 0 && <FileNode state={state} node={tree} prefix="" depth={0} />
        )}
      </div>

      {selectable && (
        <div className="fb-foot">
          <button className="ghost" onClick={() => onSelect?.(selected?.length === files.length ? [] : files.map((file) => file.path))}>
            {selected?.length === files.length ? 'Clear all' : 'Select all'}
          </button>
          <span className="fb-selected">
            {selected?.length || 0} of {files?.length || 0}
          </span>
        </div>
      )}
    </div>
  );
}

function useFileBrowser<T extends BrowserFile>({ files, selected, onSelect, onOpen, selectable = false, autoFocusSearch = false }: FileBrowserProps<T>) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState(() => new Set<string>());
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocusSearch) {
      inputRef.current?.focus();
    }
  }, [autoFocusSearch]);

  const tree = useMemo(() => buildTree(files || []), [files]);
  const matches = useMemo(() => search(files || [], query), [files, query]);
  const searching = query.trim().length > 0;

  useEffect(() => setActive(0), [query]);

  const isOn = (path: string) => !!selected?.includes(path);
  const toggle = (paths: readonly string[], options: { readonly remove: boolean }): void => {
    if (onSelect) {
      onSelect(fileBrowserSelection(selected ?? [], paths, options));
    }
  };

  // Typing is the fastest way in, so the field takes the arrow keys and Enter
  // without anyone having to leave it.
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searching || !matches.length) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const file = matches[active];
      if (!file) {
        return;
      }
      if (selectable) {
        toggle([file.path], { remove: isOn(file.path) });
      } else {
        onOpen?.(file);
      }
    }
  };

  return {
    query,
    setQuery,
    closed,
    setClosed,
    active,
    inputRef,
    tree,
    matches,
    searching,
    isOn,
    toggle,
    onKeyDown,
    selectable,
    onOpen,
  };
}

type BrowserState<T extends BrowserFile> = ReturnType<typeof useFileBrowser<T>>;
function FileRow<T extends BrowserFile>({
  file,
  depth,
  index,
  state,
}: {
  readonly file: T;
  readonly depth: number;
  readonly index: number;
  readonly state: BrowserState<T>;
}) {
  const { active, searching, isOn, selectable, toggle, onOpen } = state;
  return (
    <div
      className={`fb-row ${index === active && searching ? 'active' : ''} ${isOn(file.path) ? 'on' : ''}`}
      style={{ paddingLeft: 6 + depth * 13 }}
      onClick={() => (selectable ? toggle([file.path], { remove: isOn(file.path) }) : onOpen?.(file))}
      title={file.path}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={isOn(file.path)}
          onChange={() => toggle([file.path], { remove: isOn(file.path) })}
          onClick={(event) => event.stopPropagation()}
        />
      )}
      <span className="fb-name">{file.name || file.path.split('/').pop()}</span>
      {/* Where it is, but only while searching — in the tree the indentation
          already says it, and repeating it would be noise on every row. */}
      {searching && <span className="fb-dir">{file.path.split('/').slice(0, -1).join('/')}</span>}
      <FileStatus status={file.status ?? undefined} />
    </div>
  );
}

function FileFolder<T extends BrowserFile>({
  name,
  node,
  prefix,
  depth,
  state,
}: {
  readonly name: string;
  readonly node: FileTree<T>;
  readonly prefix: string;
  readonly depth: number;
  readonly state: BrowserState<T>;
}) {
  const { closed, isOn, selectable, toggle, setClosed } = state;
  const key = prefix + name;
  const shut = closed.has(key);
  const paths = pathsUnder(node);
  const allOn = paths.length > 0 && paths.every(isOn);
  return (
    <>
      <div className="fb-folder" style={{ paddingLeft: 6 + depth * 13 }}>
        {selectable && (
          <input
            type="checkbox"
            checked={allOn}
            // Some but not all: the box says "not everything here", which is
            // a different fact from either ticked or empty.
            ref={(element) => {
              if (element) {
                element.indeterminate = !allOn && paths.some(isOn);
              }
            }}
            onChange={() => toggle(paths, { remove: allOn })}
            onClick={(event) => event.stopPropagation()}
          />
        )}
        <button
          className="fb-folder-head"
          onClick={() =>
            setClosed((previous) => {
              const next = new Set(previous);
              if (next.has(key)) {
                next.delete(key);
              } else {
                next.add(key);
              }
              return next;
            })
          }
        >
          <span className="fb-caret">{shut ? <ChevronRightIcon size={11} /> : <ChevronDownIcon size={11} />}</span>
          <span className="fb-folder-icon">{shut ? <FolderIcon size={12} /> : <FolderOpenIcon size={12} />}</span>
          <span className="fb-name">{name}</span>
          <span className="fb-count">{paths.length}</span>
        </button>
      </div>
      {!shut && <FileNode state={state} node={node} prefix={`${key}/`} depth={depth + 1} />}
    </>
  );
}

function FileNode<T extends BrowserFile>({
  node,
  prefix,
  depth,
  state,
}: {
  readonly node: FileTree<T>;
  readonly prefix: string;
  readonly depth: number;
  readonly state: BrowserState<T>;
}) {
  assert(depth <= FILE_LIMITS.depthMax, 'FileBrowser: render depth limit exceeded');
  return (
    <>
      {[...node.dirs.entries()].map(([name, child]) => (
        <FileFolder state={state} key={prefix + name} name={name} node={child} prefix={prefix} depth={depth} />
      ))}
      {node.files.map((file) => (
        <FileRow state={state} key={file.path} file={file} depth={depth} index={-1} />
      ))}
    </>
  );
}

function fileBrowserSelection(selected: readonly string[], paths: readonly string[], options: { readonly remove: boolean }): string[] {
  assert(selected.length <= FILE_LIMITS.entriesMax, 'FileBrowser: selection limit exceeded');
  assert(paths.length <= FILE_LIMITS.entriesMax, 'FileBrowser: toggle limit exceeded');
  const next = new Set(selected);
  for (const path of paths) {
    if (options.remove) {
      next.delete(path);
    } else {
      next.add(path);
    }
  }
  assert(next.size <= FILE_LIMITS.entriesMax, 'FileBrowser: resulting selection limit exceeded');
  return [...next];
}
