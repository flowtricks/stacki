// What the Navigator calls an `if`: its condition in short words a designer
// reads at a glance, cut with an ellipsis, with the full code as the row's tooltip.
//
//   variant === "play"                       → if Variant = Play
//   render && (isWritten ? content : true)   → if Render and Is Written…
//   !hidden || items.length > 0              → if not Hidden or Items is not empty
//
// The words come from the rich reading (conditionExpressionRich.ts): a name is
// titled, a single-word value is titled as a choice is, and a locked part of
// the code is named by the first name it reads, then an ellipsis. Code that
// cannot be read keeps the code as the label. Pure and bounded.

import { assert } from '../../shared/core/assert';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import { isCodeCondition, type ExpressionCondition, type ExpressionLiteral } from '../editor/conditionExpression';
import { readRichConditionExpression } from '../editor/conditionExpressionRich';

/** The longest label a condition row shows, ellipsis included: the length the Navigator gave `if` labels before. */
export const CONDITION_LABEL_LENGTH_MAX = 40;

export interface ConditionLabel {
  readonly label: string;
  /** The test as written, for the tooltip. */
  readonly title: string;
}

/** The Navigator's label for an `if` testing `test`. */
export function conditionLabel(test: string, translate: Translator = ENGLISH_TRANSLATE): ConditionLabel {
  const code = test.replace(/\s+/g, ' ').trim();
  const words = conditionWordsOf(test, translate);
  const label = translate('structure.cond.if', { condition: words ?? code });
  const cut = label.length > CONDITION_LABEL_LENGTH_MAX ? `${label.slice(0, CONDITION_LABEL_LENGTH_MAX - 1).trimEnd()}…` : label;
  assert(cut.length <= CONDITION_LABEL_LENGTH_MAX, 'conditionLabel: the label is bounded');
  return { label: cut, title: code };
}

/** The condition in words, or undefined when the code cannot be read. */
export function conditionWordsOf(test: string, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  const model = readRichConditionExpression(test);
  if (model === undefined || model.groups.length === 0) {
    return undefined;
  }
  const and = translate('structure.cond.and');
  const or = translate('structure.cond.or');
  const groups = model.groups.map((group) =>
    group.conditions.map((condition) => conditionWords(condition, translate)).join(group.match === 'all' ? ` ${and} ` : ` ${or} `),
  );
  assert(groups.length === model.groups.length, 'conditionWordsOf: one phrase per group');
  return groups.join(` ${or} `);
}

function conditionWords(condition: ExpressionCondition, translate: Translator): string {
  if (isCodeCondition(condition)) {
    const first = /[A-Za-z_$][\w$]*/.exec(condition.code);
    return first === null ? '…' : `${nameWords(first[0])}…`;
  }
  const subject = nameWords(condition.subject);
  switch (condition.operator) {
    case 'isTrue':
      return subject;
    case 'isFalse':
      return translate('structure.cond.not', { subject });
    case 'equals':
      return translate('props.conditional.words.equals', { subject, value: literalWords(condition.value) });
    case 'notEquals':
      return translate('props.conditional.words.notEquals', { subject, value: literalWords(condition.value) });
    case 'isAnyOf':
      return translate('props.conditional.words.isAnyOf', { subject, values: condition.values.map(literalWords).join(', ') });
    case 'isNoneOf':
      return translate('props.conditional.words.isNoneOf', { subject, values: condition.values.map(literalWords).join(', ') });
    case 'isSet':
    case 'isNotSet':
    case 'isEmpty':
    case 'isNotEmpty':
      return `${subject} ${translate(`props.condition.operator.${condition.operator}`)}`;
    case 'greaterThan':
    case 'lessThan':
    case 'atLeast':
    case 'atMost':
    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith':
    case 'lengthEquals':
    case 'lengthGreaterThan':
      return `${subject} ${translate(`props.condition.operator.${condition.operator}`)} ${literalWords(condition.value)}`;
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

/** A name in scope as words: `isWritten` is Is Written, `card.fluted` is Card Fluted. */
export function nameWords(name: string): string {
  const words = name
    .replace(/\[["']?([^\]"']*)["']?\]/g, ' $1')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_.?-]+/)
    .filter((word) => word !== '');
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || name;
}

// A one-word value reads as a choice does (play is Play); anything else as written, so words are never changed.
function literalWords(literal: ExpressionLiteral): string {
  if (literal.kind !== 'string') {
    return String(literal.value);
  }
  return /^[a-z][a-z0-9]*$/.test(literal.value) ? literal.value.charAt(0).toUpperCase() + literal.value.slice(1) : literal.value;
}
