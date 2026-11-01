// What a field's checks are called in its settings, and how a typed value
// becomes one (RemoteCollectionSettings.tsx): a length is in characters for
// text and in items for a list, a range is a value for numbers.
import type { SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import {
  FIELD_CHECKS,
  type FieldCheckKey,
  type FieldChecks,
} from '../../../shared/properties/fieldChecks';

const LIST_KINDS: readonly SettingsFieldKind[] = ['list', 'multiImage', 'multiReference'];

/** A check's label, in the unit the field's kind measures it in. */
export function checkLabel(key: FieldCheckKey, kind: SettingsFieldKind): string {
  const unit = kind === 'number' ? '' : LIST_KINDS.includes(kind) ? ' items' : ' characters';
  const labels: Readonly<Record<FieldCheckKey, string>> = {
    min: kind === 'number' ? 'Minimum number' : `Minimum${unit}`,
    max: kind === 'number' ? 'Maximum number' : `Maximum${unit}`,
    length: `Exactly this many${unit}`,
    gt: 'Greater than',
    lt: 'Less than',
    multipleOf: 'Multiple of',
    integer: 'Whole numbers only',
    sign: 'Sign',
    pattern: 'Matches the pattern (regular expression)',
    startsWith: 'Starts with',
    endsWith: 'Ends with',
    includes: 'Contains',
    trim: 'Trim spaces from both ends',
    letterCase: 'Letter case',
    minDate: 'Earliest date',
    maxDate: 'Latest date',
    minWidth: 'Minimum image width (pixels)',
    maxWidth: 'Maximum image width (pixels)',
    minHeight: 'Minimum image height (pixels)',
    maxHeight: 'Maximum image height (pixels)',
    nullable: 'Allow an empty value (null)',
  };
  return labels[key];
}

/** The choices of a check that is one of a few. */
export function choicesFor(kind: 'sign' | 'case'): readonly { value: string; label: string }[] {
  return kind === 'sign'
    ? [
        { value: '', label: 'Any' },
        { value: 'positive', label: 'Positive (above 0)' },
        { value: 'nonnegative', label: 'Zero or positive' },
        { value: 'negative', label: 'Negative (below 0)' },
        { value: 'nonpositive', label: 'Zero or negative' },
      ]
    : [
        { value: '', label: 'As typed' },
        { value: 'lower', label: 'Lowercase' },
        { value: 'upper', label: 'Uppercase' },
      ];
}

/** A typed value as its check holds it; an empty or unreadable one clears the check. */
export function typedValue(
  kind: (typeof FIELD_CHECKS)[FieldCheckKey],
  typed: string,
): FieldChecks[FieldCheckKey] {
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
export function withCheck(
  checks: FieldChecks,
  key: FieldCheckKey,
  value: FieldChecks[FieldCheckKey],
): FieldChecks {
  const rest = Object.fromEntries(Object.entries(checks).filter(([name]) => name !== key));
  return value === undefined ? rest : { ...rest, [key]: value };
}
