// What an agent changed in one turn: "N files changed +A −R", a row per file (name, counts, and
// Keep or Undo while it is pending, Kept or Undone after), each row opening to the file's diff.
//
// Keep and Undo are the existing review flow, unchanged: the card only calls `onReview`. A drifted
// undo (the file moved on since the agent's edit) reaches the merge editor through the caller's
// `runReview`, which is why the bulk actions wait for one file's review before the next.
import { useEffect, useRef, useState } from 'react';
import type { ChatFileChange, ChatId, TurnId } from '../../../../shared/properties/ai/chatModel';
import { ChevronDownIcon, ChevronRightIcon, ExternalIcon } from '../../../ui/Icons';
import { CHANGE_DIFF_LIMITS, loadFileDiff, rememberedCounts, type LoadedDiff } from './changeDiffs';
import { countsLabel, type ChangeCounts } from './diffModel';
import { DiffView } from './DiffView';
import { relativePath } from './paths';
import './diff.css';

type ReviewAction = 'keep' | 'undo';

/** Where the card reads each pending file's text from; without it the card still reviews, but shows no diffs or counts. */
export interface ChangeSource {
  readonly chat: ChatId;
  readonly turn: TurnId;
}

export function ChangesCard({
  files,
  projectPath,
  onReview,
  source,
  onOpenFile,
}: {
  readonly files: readonly ChatFileChange[];
  readonly projectPath: string;
  /** Settles one file. May return a promise (a drifted undo waits for the merge editor); bulk actions wait for it. */
  readonly onReview: (path: string, action: ReviewAction) => void | Promise<void>;
  readonly source?: ChangeSource | undefined;
  /** Shows a changed file in the editor. Without it the row has no "Open file" button. */
  readonly onOpenFile?: ((path: string) => void) | undefined;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set());
  const loaded = useLoadedDiffs(source, files);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const pending = files.filter((file) => file.review === 'pending');
  const countsOfFile = (file: ChatFileChange): ChangeCounts | undefined => countsFor(source, file.path, loaded);
  const totals = totalCounts(files.map(countsOfFile));
  // Reviews run one after another: two drifted undos at once would stack two merge editors on one screen.
  const review = async (paths: readonly string[], action: ReviewAction): Promise<void> => {
    setWorking((previous) => new Set([...previous, ...paths]));
    for (const path of paths) {
      try {
        await onReview(path, action);
      } finally {
        if (alive.current) {
          setWorking((previous) => new Set([...previous].filter((candidate) => candidate !== path)));
        }
      }
    }
  };
  return (
    <div className="ai-changes-card" aria-label="Changes in this turn">
      <div className="ai-changes-card-head">
        <span className="ai-changes-card-title">
          <span>
            {files.length} file{files.length === 1 ? '' : 's'} changed
          </span>
          {totals !== undefined && <span className="ai-changes-total">{countsLabel(totals)}</span>}
        </span>
        {pending.length > 1 && (
          <span className="ai-changes-bulk">
            <button
              disabled={working.size > 0}
              onClick={() =>
                void review(
                  pending.map((file) => file.path),
                  'undo',
                )
              }
            >
              Undo all
            </button>
            <button
              className="ai-changes-keep"
              disabled={working.size > 0}
              onClick={() =>
                void review(
                  pending.map((file) => file.path),
                  'keep',
                )
              }
            >
              Keep all
            </button>
          </span>
        )}
      </div>
      {files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          projectPath={projectPath}
          counts={countsOfFile(file)}
          diff={loaded.get(file.path)}
          open={open.has(file.path)}
          busy={working.has(file.path)}
          onToggle={() =>
            setOpen((previous) => {
              const next = new Set(previous);
              if (!next.delete(file.path)) {
                next.add(file.path);
              }
              return next;
            })
          }
          onReview={(action) => void review([file.path], action)}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function FileRow({
  file,
  projectPath,
  counts,
  diff,
  open,
  busy,
  onToggle,
  onReview,
  onOpenFile,
}: {
  readonly file: ChatFileChange;
  readonly projectPath: string;
  readonly counts: ChangeCounts | undefined;
  readonly diff: LoadedDiff | 'loading' | undefined;
  readonly open: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
  readonly onReview: (action: ReviewAction) => void;
  readonly onOpenFile: ((path: string) => void) | undefined;
}) {
  const relative = relativePath(file.path, projectPath);
  const slash = relative.lastIndexOf('/');
  const name = relative.slice(slash + 1);
  const folder = slash < 0 ? '' : relative.slice(0, slash);
  return (
    <div className={`ai-file ai-file-${file.review}${open ? ' ai-file-open' : ''}`}>
      <div className="ai-file-row">
        <button className="ai-file-toggle" aria-expanded={open} title={file.path} onClick={onToggle}>
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
          <span className="ai-file-text">
            <span className="ai-file-line">
              <span className="ai-file-name">{name}</span>
              {file.change !== 'modified' && (
                <span className={`ai-file-kind ai-file-kind-${file.change}`}>{file.change === 'created' ? 'New' : 'Deleted'}</span>
              )}
            </span>
            {folder !== '' && <span className="ai-file-folder">{folder}</span>}
          </span>
          {counts !== undefined && (
            <span className="ai-file-counts">
              <span className="ai-file-added">+{counts.added}</span> <span className="ai-file-removed">{`\u2212${counts.removed}`}</span>
            </span>
          )}
        </button>
        {file.review === 'pending' ? (
          <span className="ai-file-actions">
            <button disabled={busy} onClick={() => onReview('keep')}>
              Keep
            </button>
            <button disabled={busy} onClick={() => onReview('undo')}>
              Undo
            </button>
          </span>
        ) : (
          <span className="ai-file-done">{file.review === 'kept' ? 'Kept' : 'Undone'}</span>
        )}
        {onOpenFile !== undefined && (
          <button className="ai-file-open-button" title="Open file" aria-label={`Open ${name}`} onClick={() => onOpenFile(file.path)}>
            <ExternalIcon size={13} />
          </button>
        )}
      </div>
      {open && (
        <div className="ai-file-body">
          <FileBody file={file} diff={diff} projectPath={projectPath} />
        </div>
      )}
    </div>
  );
}

function FileBody({
  file,
  diff,
  projectPath,
}: {
  readonly file: ChatFileChange;
  readonly diff: LoadedDiff | 'loading' | undefined;
  readonly projectPath: string;
}) {
  if (file.review !== 'pending') {
    // The host keeps a file's text only while its change is pending.
    return <p className="ai-file-gone">The diff is no longer available once a change is {file.review}.</p>;
  }
  if (diff === undefined || diff === 'loading') {
    return <p className="ai-file-gone">Loading the diff…</p>;
  }
  if (diff.state === 'unavailable') {
    return <p className="ai-file-gone">The diff could not be loaded.</p>;
  }
  return <DiffView diff={diff.sides} projectPath={projectPath} header="none" />;
}

/**
 * The diffs of the card's pending files, fetched once each when the card appears (the counts in the
 * header need them), up to `autoLoadMax`; the card's state holds the answers as they arrive.
 */
function useLoadedDiffs(source: ChangeSource | undefined, files: readonly ChatFileChange[]): ReadonlyMap<string, LoadedDiff | 'loading'> {
  const [loaded, setLoaded] = useState<ReadonlyMap<string, LoadedDiff | 'loading'>>(new Map());
  const chat = source?.chat;
  const turn = source?.turn;
  const pendingKey = files
    .filter((file) => file.review === 'pending')
    .map((file) => file.path)
    .join('\u0000');
  useEffect(() => {
    if (chat === undefined || turn === undefined || pendingKey === '') {
      return;
    }
    let active = true;
    const paths = pendingKey.split('\u0000').slice(0, CHANGE_DIFF_LIMITS.autoLoadMax);
    setLoaded((previous) => new Map([...previous, ...paths.filter((path) => !previous.has(path)).map((path): [string, 'loading'] => [path, 'loading'])]));
    for (const path of paths) {
      void loadFileDiff(chat, turn, path).then((result) => {
        if (active) {
          setLoaded((previous) => new Map(previous).set(path, result));
        }
      });
    }
    return () => {
      active = false;
    };
  }, [chat, turn, pendingKey]);
  return loaded;
}

function countsFor(source: ChangeSource | undefined, path: string, loaded: ReadonlyMap<string, LoadedDiff | 'loading'>): ChangeCounts | undefined {
  if (source === undefined) {
    return undefined;
  }
  const entry = loaded.get(path);
  if (entry !== undefined && entry !== 'loading') {
    return entry.state === 'ready' ? entry.counts : undefined;
  }
  // A settled file is not loaded again; the counts seen while it was pending are still remembered.
  const remembered = rememberedCounts(source.chat, source.turn, path);
  return remembered === 'none' ? undefined : remembered;
}

/** The sum of the counts, but only when every file has them: a total that leaves a file out would read as the whole. */
function totalCounts(all: readonly (ChangeCounts | undefined)[]): ChangeCounts | undefined {
  let added = 0;
  let removed = 0;
  for (const counts of all) {
    if (counts === undefined) {
      return undefined;
    }
    added += counts.added;
    removed += counts.removed;
  }
  return all.length === 0 ? undefined : { added, removed };
}
