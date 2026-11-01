import type { Conflict, ConflictChoice } from './gitConflictModel';
import type { MergeConflictModel } from './useMergeConflict';
import MergeResultEditor from './MergeResultEditor';
import Code from './Code';

interface DetailProps {
  readonly model: MergeConflictModel;
  readonly conflict: Conflict;
  readonly working: boolean;
}
export function MergeConflictDetail({ model, conflict, working }: DetailProps) {
  const { draft, file } = model;
  if (draft === undefined) {
    return <MergeWhole model={model} conflict={conflict} working={working} />;
  }
  return (
    <section className="conflict-detail" aria-label="Merge result">
      <div className="merge-result-toolbar">
        <div>
          <strong>Final code</strong>
          <span title={file.path}>{file.path}</span>
        </div>
        <div className="merge-legend">
          <span className="merge-branch-ours">{model.ours}</span>
          <span className="merge-branch-theirs">{conflict.branch}</span>
          {draft.mode === 'edited' && <span className="merge-manual-label">Your edits</span>}
        </div>
      </div>
      <MergeResultEditor
        key={file.path}
        path={file.path}
        draft={draft}
        clashes={model.clashes}
        active={model.active}
        busy={working}
        ours={model.ours}
        theirs={conflict.branch}
        onEdit={model.edit}
        onSelect={model.select}
      />
      {draft.regions.length > 0 && <MergeChangeInspector model={model} conflict={conflict} working={working} />}
    </section>
  );
}

function MergeChangeInspector({ model, conflict, working }: DetailProps) {
  const region = model.draft?.regions[model.active];
  const clash = model.clashes[model.active];
  if (region === undefined || clash === undefined) {
    return undefined;
  }
  const total = model.clashes.length;
  const status =
    region.choice === 'custom'
      ? 'Manually edited'
      : region.review === 'pending'
        ? 'Choose which version to keep'
        : clash.merged !== undefined && region.choice === 'merged'
          ? 'Independent edits combined'
          : region.choice === 'both'
            ? 'Keeping both blocks'
            : `Keeping ${region.choice === 'theirs' ? conflict.branch : model.ours}`;
  return (
    <div className="merge-change-inspector">
      <div className="merge-change-toolbar">
        <div className="merge-change-navigation">
          <button aria-label="Previous change" disabled={working} onClick={() => model.select((model.active + total - 1) % total)}>
            ↑
          </button>
          <span>
            Change {model.active + 1} of {total}
          </span>
          <button aria-label="Next change" disabled={working} onClick={() => model.select((model.active + 1) % total)}>
            ↓
          </button>
        </div>
        <span className="merge-change-status">{status}</span>
      </div>
      <div className="merge-change-options">
        <SourceChoice model={model} conflict={conflict} working={working} choice="ours" />
        <SourceChoice model={model} conflict={conflict} working={working} choice="theirs" />
        {clash.merged !== undefined && <ChoiceButton model={model} working={working} choice="merged" label="Combine edits" />}
        {clash.changedBy === 'both' && clash.merged === undefined && <ChoiceButton model={model} working={working} choice="both" label="Keep both blocks" />}
      </div>
      {!region.selectable && <p className="hint-text">Your edit spans multiple changes. Undo in the code editor to restore individual choices.</p>}
    </div>
  );
}

function SourceChoice({
  model,
  conflict,
  working,
  choice,
}: DetailProps & {
  readonly choice: 'ours' | 'theirs';
}) {
  const clash = model.clashes[model.active];
  const text = clash?.[choice] ?? '';
  const label = choice === 'ours' ? model.ours : conflict.branch;
  return (
    <div className={`merge-source-option merge-source-${choice}`}>
      <ChoiceButton model={model} working={working} choice={choice} label={`Keep ${label}`} />
      <div className="merge-source-preview">
        {text === '' ? <span className="hint-text">Remove this text</span> : <Code text={text} filename={model.file.path} maxHeight={84} />}
      </div>
    </div>
  );
}
function ChoiceButton({
  model,
  working,
  choice,
  label,
}: {
  readonly model: MergeConflictModel;
  readonly working: boolean;
  readonly choice: ConflictChoice;
  readonly label: string;
}) {
  const region = model.draft?.regions[model.active];
  return (
    <button
      className={`merge-choice ${region?.choice === choice ? 'on' : ''}`}
      disabled={working || !region?.selectable}
      aria-pressed={region?.choice === choice}
      onClick={() => model.choose(choice)}
    >
      {label}
    </button>
  );
}

function MergeWhole({ model, conflict, working }: DetailProps) {
  return (
    <section className="conflict-detail conflict-whole">
      <h3>{model.file.path}</h3>
      <p>This file cannot be compared as text. Choose the version to keep.</p>
      <div className="conflict-choice">
        {(['ours', 'theirs'] as const).map((choice) => (
          <button key={choice} className={model.whole[model.file.path] === choice ? 'on' : ''} disabled={working} onClick={() => model.setWhole(choice)}>
            {choice === 'ours' ? model.ours : conflict.branch}
          </button>
        ))}
      </div>
    </section>
  );
}
