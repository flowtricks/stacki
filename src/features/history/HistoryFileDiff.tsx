import { ErrorToast } from '../../ui/ErrorToast';
import { useEffect, useState } from 'react';
import { CodeTokens, useCodeLines } from '../../ui/CodeBlock';
import { languageFor } from '../../ui/codeHighlight';
import { ChevronLeftIcon } from '../../ui/Icons';
import type { HistoryCommit, HistoryCommitFile } from './historyBridge';
import { readHistoryDiff } from './historyDiffBridge';
import { parseHistoryPatch } from './historyDiffModel';
import type { HistoryDiffLine } from './historyDiffModel';

type DiffState =
  { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly rows: readonly HistoryDiffLine[] };

export default function HistoryFileDiff({
  projectPath,
  commit,
  file,
  onBack,
  onRestore,
}: {
  readonly projectPath: string;
  readonly commit: HistoryCommit;
  readonly file: HistoryCommitFile;
  readonly onBack: () => void;
  readonly onRestore?: (() => void) | undefined;
}) {
  const [revision, setRevision] = useState(0);
  const state = useHistoryDiff(projectPath, commit.hash, file, revision);
  return (
    <div className="history-diff">
      <div className="history-diff-toolbar">
        <button autoFocus onClick={onBack}>
          <ChevronLeftIcon size={12} /> All files
        </button>
        <span className="history-diff-path">{file.path}</span>
        {onRestore && <button onClick={onRestore}>Restore file…</button>}
      </div>
      <div className="history-diff-comparison">
        {commit.parents[0]?.slice(0, 7) ?? 'Empty tree'} → {commit.shortHash}
        {commit.isMerge ? ' · compared with first parent' : ''}
      </div>
      {state.kind === 'loading' && <p className="history-note">Loading diff…</p>}
      {state.kind === 'error' && <ErrorToast message={state.message} recovery={[{ label: 'Retry', run: () => setRevision((value) => value + 1) }]} />}
      {state.kind === 'ready' && <HistoryDiffLines rows={state.rows} path={file.path} />}
    </div>
  );
}

function useHistoryDiff(projectPath: string, commit: string, file: HistoryCommitFile, revision: number): DiffState {
  const [state, setState] = useState<DiffState>({ kind: 'loading' });
  const { path, from } = file;
  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void readHistoryDiff({ projectPath, commit, path, from }).then((result) => {
      if (active) {
        setState(result.ok ? { kind: 'ready', rows: parseHistoryPatch(result.value) } : { kind: 'error', message: result.error });
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, commit, path, from, revision]);
  return state;
}

function HistoryDiffLines({ rows, path }: { readonly rows: readonly HistoryDiffLine[]; readonly path: string }) {
  if (rows.length === 0) {
    return <p className="history-note">No text changes in this file.</p>;
  }
  return <HistoryDiffTable rows={rows} path={path} />;
}

function HistoryDiffTable({ rows, path }: { readonly rows: readonly HistoryDiffLine[]; readonly path: string }) {
  // The code rows are coloured as one text, so a comment or a tag that spans
  // lines keeps its colour on all of them. Both sides of a change share the text:
  // a diff is the only place they sit together, and a parser recovers past the seam.
  const lines = useCodeLines(
    rows
      .filter(isCodeRow)
      .map((row) => row.text)
      .join('\n'),
    languageFor(path),
  );
  let codeIndex = 0;
  return (
    <div className="history-diff-scroll" tabIndex={0} aria-label="File diff">
      <div className="history-diff-lines">
        {rows.map((row, index) => {
          const line = isCodeRow(row) ? lines[codeIndex++] : undefined;
          return (
            <div key={index} className={`history-diff-line ${row.kind}`}>
              {isCodeRow(row) ? (
                <>
                  <span className="history-diff-number">{'before' in row ? row.before : ''}</span>
                  <span className="history-diff-number">{'after' in row ? row.after : ''}</span>
                  <span className="history-diff-sign">{row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ' '}</span>
                  <span className="history-diff-code">{row.text === '' ? ' ' : <CodeTokens line={line} />}</span>
                </>
              ) : (
                <span className="history-diff-heading">{row.text}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function isCodeRow(row: HistoryDiffLine): boolean {
  return row.kind !== 'metadata' && row.kind !== 'hunk';
}
