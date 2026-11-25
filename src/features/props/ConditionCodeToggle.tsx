// The `{}` beside a condition's label: the same button a prop field has
// (PropFieldLabel.tsx), for every conditions editor. On, it shows the
// condition as code; pressed again it goes back to the controls, unless the
// code says more than the controls can draw, in which case it is disabled and
// its title says why (the pattern of "Use the normal field"). Code the controls
// cannot draw is shown as highlighted code alone: no sentence explains it.

import { BracesIcon } from '../../ui/Icons';
import { useCodeAccess } from '../../ui/CodeAccess';
import ExprInput from '../../ui/ExprInput';
import { scopeCompletions } from '../../editor/dataSuggest';
import type { DataContext } from '../../editor/dataScope';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { ConditionView, ConditionViewDecision } from './conditionViewDecision';

export function ConditionCodeToggle(props: { readonly decision: ConditionViewDecision; readonly onChoose: (view: ConditionView) => void }) {
  const translate = useTranslate();
  const access = useCodeAccess();
  if (!access) {
    return undefined;
  }
  const { decision } = props;
  const onCode = decision.view === 'code';
  const refused = onCode && decision.visualRefusal !== undefined;
  const title = refused
    ? translate('props.condition.tooComplexBlocked')
    : onCode
      ? translate('props.condition.useControls')
      : translate('props.condition.writeCode');
  return (
    <button
      type="button"
      className={`prop-expr-toggle${onCode ? ' on' : ''}`}
      title={title}
      aria-disabled={refused}
      aria-pressed={onCode}
      aria-label={translate('props.condition.asCode')}
      onClick={() => {
        if (!refused) {
          props.onChoose(onCode ? 'visual' : 'code');
        }
      }}
    >
      <BracesIcon size={12} />
    </button>
  );
}

/** The condition as code, highlighted as every expression field is, with the names in scope offered. */
export function ConditionCodeBox(props: {
  readonly code: string;
  /** The code the box was opened on: what a change from outside is told apart from. */
  readonly seed: string;
  readonly context: DataContext | undefined;
  readonly onChange: (code: string) => void;
}) {
  const translate = useTranslate();
  return (
    <div className="props-cond-field attr-value-field">
      <ExprInput
        value={props.code}
        syncValue={props.seed}
        placeholder={translate('props.binding.exampleCondition')}
        completions={scopeCompletions(props.context ?? {})}
        onChange={props.onChange}
      />
    </div>
  );
}
