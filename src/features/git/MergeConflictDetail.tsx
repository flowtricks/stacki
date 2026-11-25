import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Conflict, ConflictChoice } from './gitConflictModel';
import type { MergeConflictModel } from './useMergeConflict';
import MergeResultEditor from './MergeResultEditor';
import { CodeBlock } from '../../ui/CodeBlock';

interface DetailProps {
  readonly model: MergeConflictModel;
  readonly conflict: Conflict;
  readonly working: boolean;
}
export function MergeConflictDetail({ model, conflict, working }: DetailProps) {
  const translate = useTranslate();
  const { draft, file } = model;
  if (draft === undefined) {
    return <MergeWhole model={model} conflict={conflict} working={working} />;
  }
  return (
    <section className="conflict-detail" aria-label={translate('git.conflict.mergeResult')}>
      <div className="merge-result-toolbar">
        <div>
          <strong>{translate('git.conflict.finalCode')}</strong>
          <span title={file.path}>{file.path}</span>
        </div>
        <div className="merge-legend">
          <span className="merge-branch-ours">{model.ours}</span>
          <span className="merge-branch-theirs">{conflict.branch}</span>
          {draft.mode === 'edited' && <span className="merge-manual-label">{translate('git.conflict.yourEdits')}</span>}
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
  const translate = useTranslate();
  const region = model.draft?.regions[model.active];
  const clash = model.clashes[model.active];
  if (region === undefined || clash === undefined) {
    return undefined;
  }
  const total = model.clashes.length;
  const status =
    region.choice === 'custom'
      ? translate('git.conflict.status.manual')
      : region.review === 'pending'
        ? translate('git.conflict.status.choose')
        : clash.merged !== undefined && region.choice === 'merged'
          ? translate('git.conflict.status.combined')
          : region.choice === 'both'
            ? translate('git.conflict.status.both')
            : translate('git.conflict.status.keeping', { branch: region.choice === 'theirs' ? conflict.branch : model.ours });
  return (
    <div className="merge-change-inspector">
      <div className="merge-change-toolbar">
        <div className="merge-change-navigation">
          <button aria-label={translate('git.conflict.previous')} disabled={working} onClick={() => model.select((model.active + total - 1) % total)}>
            ↑
          </button>
          <span>{translate('git.conflict.changeOf', { index: model.active + 1, total })}</span>
          <button aria-label={translate('git.conflict.next')} disabled={working} onClick={() => model.select((model.active + 1) % total)}>
            ↓
          </button>
        </div>
        <span className="merge-change-status">{status}</span>
      </div>
      <div className="merge-change-options">
        <SourceChoice model={model} conflict={conflict} working={working} choice="ours" />
        <SourceChoice model={model} conflict={conflict} working={working} choice="theirs" />
        {clash.merged !== undefined && <ChoiceButton model={model} working={working} choice="merged" label={translate('git.conflict.combine')} />}
        {clash.changedBy === 'both' && clash.merged === undefined && (
          <ChoiceButton model={model} working={working} choice="both" label={translate('git.conflict.keepBoth')} />
        )}
      </div>
      {!region.selectable && <p className="hint-text">{translate('git.conflict.spansMultiple')}</p>}
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
  const translate = useTranslate();
  const clash = model.clashes[model.active];
  const text = clash?.[choice] ?? '';
  const label = choice === 'ours' ? model.ours : conflict.branch;
  return (
    <div className={`merge-source-option merge-source-${choice}`}>
      <ChoiceButton model={model} working={working} choice={choice} label={translate('git.conflict.keep', { branch: label })} />
      <div className="merge-source-preview">
        {text === '' ? (
          <span className="hint-text">{translate('git.conflict.removeText')}</span>
        ) : (
          <CodeBlock text={text} filename={model.file.path} className="merge-source-code" />
        )}
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
  const translate = useTranslate();
  return (
    <section className="conflict-detail conflict-whole">
      <h3>{model.file.path}</h3>
      <p>{translate('git.conflict.notText')}</p>
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
