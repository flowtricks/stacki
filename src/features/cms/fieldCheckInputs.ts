// What a field's checks are called in its settings, and how a typed value
// becomes one (RemoteCollectionSettings.tsx): a length is in characters for
// text and in items for a list, a range is a value for numbers.
import type { SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import { FIELD_CHECKS, type FieldCheckKey, type FieldChecks } from '../../../shared/properties/fieldChecks';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';

const LIST_KINDS: readonly SettingsFieldKind[] = ['list', 'multiImage', 'multiReference'];

/** A check's label, in the unit the field's kind measures it in. */
export function checkLabel(key: FieldCheckKey, kind: SettingsFieldKind, translate: Translator = ENGLISH_TRANSLATE): string {
  const unit: 'number' | 'items' | 'characters' = kind === 'number' ? 'number' : LIST_KINDS.includes(kind) ? 'items' : 'characters';
  const labels: Readonly<Record<FieldCheckKey, MessageKey>> = {
    min: unit === 'number' ? 'cms.check.minNumber' : unit === 'items' ? 'cms.check.minItems' : 'cms.check.minCharacters',
    max: unit === 'number' ? 'cms.check.maxNumber' : unit === 'items' ? 'cms.check.maxItems' : 'cms.check.maxCharacters',
    length: unit === 'number' ? 'cms.check.lengthPlain' : unit === 'items' ? 'cms.check.lengthItems' : 'cms.check.lengthCharacters',
    gt: 'cms.check.gt',
    lt: 'cms.check.lt',
    multipleOf: 'cms.check.multipleOf',
    integer: 'cms.check.integer',
    sign: 'cms.check.sign',
    pattern: 'cms.check.pattern',
    startsWith: 'cms.check.startsWith',
    endsWith: 'cms.check.endsWith',
    includes: 'cms.check.includes',
    trim: 'cms.check.trim',
    letterCase: 'cms.check.letterCase',
    minDate: 'cms.check.minDate',
    maxDate: 'cms.check.maxDate',
    minWidth: 'cms.check.minWidth',
    maxWidth: 'cms.check.maxWidth',
    minHeight: 'cms.check.minHeight',
    maxHeight: 'cms.check.maxHeight',
    nullable: 'cms.check.nullable',
  };
  return translate(labels[key]);
}

/** The choices of a check that is one of a few. */
export function choicesFor(kind: 'sign' | 'case', translate: Translator = ENGLISH_TRANSLATE): readonly { value: string; label: string }[] {
  return kind === 'sign'
    ? [
        { value: '', label: translate('cms.choice.any') },
        { value: 'positive', label: translate('cms.choice.positive') },
        { value: 'nonnegative', label: translate('cms.choice.nonnegative') },
        { value: 'negative', label: translate('cms.choice.negative') },
        { value: 'nonpositive', label: translate('cms.choice.nonpositive') },
      ]
    : [
        { value: '', label: translate('cms.choice.asTyped') },
        { value: 'lower', label: translate('cms.choice.lowercase') },
        { value: 'upper', label: translate('cms.choice.uppercase') },
      ];
}

/** A typed value as its check holds it; an empty or unreadable one clears the check. */
export function typedValue(kind: (typeof FIELD_CHECKS)[FieldCheckKey], typed: string): FieldChecks[FieldCheckKey] {
  if (typed.trim() === '') {
    return undefined;
  }
  if (kind === 'number') {
    const value = Number(typed);
    return Number.isFinite(value) ? value : undefined;
  }
  return typed;
}

/** The checks with one set or, given undefined, cleared. */
export function withCheck(checks: FieldChecks, key: FieldCheckKey, value: FieldChecks[FieldCheckKey]): FieldChecks {
  const rest = Object.fromEntries(Object.entries(checks).filter(([name]) => name !== key));
  return value === undefined ? rest : { ...rest, [key]: value };
}
