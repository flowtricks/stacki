// One file's change as an inline unified diff: line numbers, additions and removals, the unchanged
// stretches folded behind "Show N lines", the words that changed inside an edited line marked, and
// every line coloured as its file's language. It is drawn inside a tool card, the changes card and
// a permission request, so it takes a plain before/after pair rather than anything about a chat.
//
// Unified, not split: the panel docks at about 330px, where two columns of code would each be
// 150px (a dozen characters of a line). A line that is wider than the panel scrolls sideways.
// The rows are coloured by the history diff's own classes (`history-diff-*`), as Stacki's other
// diffs are; the diff.css beside this file only lays them out for the narrow panel.
import { useMemo, useState } from 'react';
import { CodeTokens, useCodeLines } from '../../../ui/CodeBlock';
import { languageFor, type CodeLine } from '../../../ui/codeHighlight';
import { ExpandVerticalIcon } from '../../../ui/Icons';
import type { DiffRow } from '../lineDiff';
import {
  buildFileDiff,
  countsLabel,
  DIFF_VIEW_LIMITS,
  markTokens,
  visibleBlocks,
  wordRangesByRow,
  type CharRange,
  type DiffBlock,
  type FileDiff,
} from './diffModel';
import './diff.css';
import { relativePath } from './paths';

/** The two sides of a file's change; `undefined` is an absent file, so a created file has no old text. */
export interface DiffSides {
  readonly path: string;
  readonly oldText: string | undefined;
  readonly newText: string | undefined;
}

type TextDiff = Extract<FileDiff, { readonly kind: 'text' }>;

export function DiffView({
  diff,
  projectPath,
  header = 'path',
  size = 'regular',
}: {
  readonly diff: DiffSides;
  readonly projectPath: string;
  /** `none` when the caller already names the file (a row of the changes card). */
  readonly header?: 'path' | 'none';
  /** `compact` is a short window for a permission request; `regular` is the tall one. */
  readonly size?: 'regular' | 'compact';
}) {
  const model = useMemo(() => buildFileDiff(diff.oldText, diff.newText), [diff.oldText, diff.newText]);
  const name = relativePath(diff.path, projectPath);
  return (
    <div className={`ai-diffview ai-diffview-${size}`}>
      {header === 'path' && (
        <div className="ai-diffview-head">
          <span className="ai-diff-path" title={diff.path}>
            {name}
          </span>
          {diff.oldText === undefined && <span className="ai-diffview-kind">New file</span>}
          {diff.newText === undefined && <span className="ai-diffview-kind">Deleted</span>}
          {model.kind === 'text' && <span className="ai-diffview-counts">{countsLabel(model)}</span>}
        </div>
      )}
      <DiffBody model={model} path={diff.path} name={name} />
    </div>
  );
}

function DiffBody({ model, path, name }: { readonly model: FileDiff; readonly path: string; readonly name: string }) {
  switch (model.kind) {
    case 'binary':
      return <p className="ai-diffview-note">Binary file, no preview.</p>;
    case 'same':
      return <p className="ai-diffview-note">{model.lineEndingsChanged ? 'Only line endings changed.' : 'No changes to show.'}</p>;
    case 'text':
      return <TextRows model={model} path={path} name={name} />;
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
}

function TextRows({ model, path, name }: { readonly model: TextDiff; readonly path: string; readonly name: string }) {
  const [revealed, setRevealed] = useState<ReadonlyMap<number, number>>(new Map());
  const [extent, setExtent] = useState<'compact' | 'full'>('compact');
  // A very large pair is shown uncoloured: colouring both sides whole is the one cost that grows with the file.
  const language = model.oldText.length + model.newText.length <= DIFF_VIEW_LIMITS.highlightCharsMax ? languageFor(path) : undefined;
  const oldLines = useCodeLines(model.oldText, language);
  const newLines = useCodeLines(model.newText, language);
  const visible = useMemo(
    () =>
      visibleBlocks(model.rows, {
        context: DIFF_VIEW_LIMITS.contextLines,
        revealed,
        rowsMax: extent === 'compact' ? DIFF_VIEW_LIMITS.rowsCompactMax : DIFF_VIEW_LIMITS.rowsFullMax,
      }),
    [model.rows, revealed, extent],
  );
  const words = useMemo(() => wordRangesByRow(model.rows), [model.rows]);
  const reveal = (block: Extract<DiffBlock, { readonly kind: 'gap' }>): void => {
    setRevealed((previous) => new Map(previous).set(block.key, (previous.get(block.key) ?? 0) + block.step));
  };
  return (
    <div className="ai-diffview-scroll" tabIndex={0} aria-label={`Changes to ${name}`}>
      {!model.exact && <p className="ai-diffview-note">A large change: shown as the old lines removed and the new ones added.</p>}
      <div className="ai-diffview-lines">
        {visible.blocks.map((block) =>
          block.kind === 'gap' ? (
            <button key={`gap-${block.key}-${block.hidden}`} className="ai-diffview-gap" onClick={() => reveal(block)}>
              <ExpandVerticalIcon size={12} />
              {gapLabel(block)}
            </button>
          ) : (
            <Line
              key={block.index}
              row={block.row}
              line={block.row.kind === 'deleted' ? oldLines[block.row.before - 1] : newLines[block.row.after - 1]}
              marks={words.get(block.index)}
            />
          ),
        )}
      </div>
      {visible.cut > 0 && extent === 'compact' && (
        <button className="ai-diffview-gap" onClick={() => setExtent('full')}>
          Show full diff
        </button>
      )}
      {visible.cut > 0 && extent === 'full' && (
        <p className="ai-diffview-note">The diff is cut at {DIFF_VIEW_LIMITS.rowsFullMax.toLocaleString('en-US')} rows. Open the file to see the rest.</p>
      )}
    </div>
  );
}

function gapLabel(block: Extract<DiffBlock, { readonly kind: 'gap' }>): string {
  const lines = (count: number): string => `${count} line${count === 1 ? '' : 's'}`;
  return block.hidden <= block.step ? `Show ${lines(block.hidden)}` : `Show ${block.step} of ${lines(block.hidden)}`;
}

function Line({ row, line, marks }: { readonly row: DiffRow; readonly line: CodeLine | undefined; readonly marks: readonly CharRange[] | undefined }) {
  return (
    <div className={`history-diff-line ${row.kind}`}>
      <span className="history-diff-number">{row.kind === 'deleted' ? row.before : row.after}</span>
      <span className="history-diff-sign">{row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ''}</span>
      <span className="history-diff-code">
        {row.text === '' ? ' ' : marks === undefined || line === undefined ? <CodeTokens line={line} /> : <MarkedCode line={line} marks={marks} />}
      </span>
    </div>
  );
}

function MarkedCode({ line, marks }: { readonly line: CodeLine; readonly marks: readonly CharRange[] }) {
  return markTokens(line, marks).map((token, index) => (
    <span key={index} className={token.marked === 'changed' ? 'code-token ai-diff-word' : 'code-token'} style={token.style}>
      {token.text}
    </span>
  ));
}
