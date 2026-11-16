import { useEffect, useRef, useState } from 'react';
import { CodeInline } from '../../ui/CodeBlock';
import { confirmDialog } from '../../ui/ConfirmDialog';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { commitInPlace } from './model/commitInPlace';
import { checkTrackExpression, parseTrackList, type TrackExpressionProblem } from './model/gridTemplate';
import { repeatTracks } from './gridTracks';
import VariableConnect from './VariableConnect';

// The Columns / Rows control for a track list that is not "N equal tracks"
// (classifyTrackCount): the value itself, as text, in the cell the count stepper
// would fill, so the layout does not move and the number is never a guess at what
// `repeat(auto-fit, minmax(min(100%, 20rem), 1fr))` is. A variable in it is the
// same purple chip every other field shows (VariableConnect), the text is coloured
// as CSS, and it is written the way the stepper writes: on Enter or blur, through
// the style write pipeline, so it is undoable and a hover or selection never writes.
//
// Only the "Switch to count" button turns the value into a count, after a question:
// typing here never does, and neither does anything automatic.

export interface GridTrackExpressionProps {
  /** The resolved value for the active selector, with its `!important` if it has one. */
  readonly value: string;
  /** The property the field holds: grid-template-columns or grid-template-rows. */
  readonly prop: string;
  /** What the field is called ("Grid columns"). */
  readonly ariaLabel: string;
  /** Said once by the question before the value is replaced: `repeat(N, cell)`'s cell. */
  readonly cell: string;
  readonly busy: boolean;
  readonly onCommit: (value: string, important: boolean) => void;
}

function problemKey(problem: TrackExpressionProblem): 'style.gridControls.trackExpressionEmpty' | 'style.gridControls.trackExpressionMalformed' {
  switch (problem) {
    case 'empty':
      return 'style.gridControls.trackExpressionEmpty';
    case 'malformed':
      return 'style.gridControls.trackExpressionMalformed';
    default: {
      const exhaustive: never = problem;
      return exhaustive;
    }
  }
}

export default function GridTrackExpression(props: GridTrackExpressionProps) {
  const { value, prop, ariaLabel, cell, busy, onCommit } = props;
  const translate = useTranslate();
  const [draft, setDraft] = useState(value);
  const draftRef = useRef(value);
  const focused = useRef(false);
  const change = (next: string) => {
    draftRef.current = next;
    setDraft(next);
  };
  // The value changed under the field (another selector, an undo): show it, unless
  // the person is in the middle of typing something else.
  useEffect(() => {
    if (!focused.current) {
      draftRef.current = value;
      setDraft(value);
    }
  }, [value]);
  const edited = draft.trim() !== value.trim();
  const check = checkTrackExpression(draft);
  const problem = edited && check.kind === 'invalid' ? check.problem : undefined;
  // Refused text writes nothing: it stays in the field with the error until it is fixed or Escape puts the value back.
  const commit = (text: string) => {
    if (text.trim() === value.trim()) {
      return;
    }
    const checked = checkTrackExpression(text);
    if (checked.kind === 'ok') {
      onCommit(checked.value, checked.important);
    }
  };
  const switchToCount = async () => {
    const count = Math.max(1, parseTrackList(value).length);
    const answer = await confirmDialog({
      title: translate('style.gridControls.switchToCountTitle'),
      body: (
        <>
          <p>{translate('style.gridControls.switchToCountBody', { count })}</p>
          <CodeInline text={value} language="css" />
        </>
      ),
      confirmLabel: translate('style.gridControls.switchToCount'),
    });
    if (answer === true) {
      onCommit(repeatTracks(count, cell), false);
    }
  };
  return (
    <div className={`embed-editor_grid-count is-expression ${problem === undefined ? '' : 'is-invalid'}`}>
      <VariableConnect
        code
        ariaLabel={translate('style.gridControls.connectTracks', { name: ariaLabel })}
        disabled={busy}
        prop={prop}
        canvasProperty={prop}
        onPick={(binding) => {
          change(binding);
          commit(binding);
        }}
      >
        <input
          className="u-input embed-editor_size-input"
          value={draft}
          spellCheck={false}
          disabled={busy}
          aria-label={ariaLabel}
          aria-invalid={problem !== undefined}
          title={problem === undefined ? value : translate(problemKey(problem))}
          onChange={(event) => change(event.target.value)}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            commit(draftRef.current);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitInPlace(event.currentTarget);
            } else if (event.key === 'Escape') {
              change(value);
            }
          }}
        />
      </VariableConnect>
      <button
        type="button"
        className="embed-editor_grid-count-switch"
        disabled={busy}
        aria-label={translate('style.gridControls.switchToCount')}
        title={translate('style.gridControls.switchToCount')}
        onClick={() => void switchToCount()}
      >
        {/* i18n-ignore: the number sign, a symbol for "count". */}#
      </button>
    </div>
  );
}
