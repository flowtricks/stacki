// A value picked from a few choices that each read as an icon: a prop's
// Visibility (Show, Hide, Required), in its settings and in the Value
// conditions editor's Value and Else rows. The segmented control the Style
// panel uses draws it (src/ui/SegmentedControl.tsx), compact: square icon
// buttons packed to the start of the row, the chosen one on the neutral
// lighter fill, each naming itself in the app’s delayed tooltip.

import type { ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import SegmentedControl from '../../ui/SegmentedControl';
import type { SegmentedOption } from '../../ui/SegmentedControl';
import './valueChoices.css';

/** One choice: the words the value is written as, the name a person reads, and its icon. */
export interface ValueChoice {
  readonly value: string;
  readonly label: string;
  readonly icon: ReactNode;
}

// More than this and the icons stop reading as one row in a sidebar field.
const CHOICES_MAX = 5;

/** The choices side by side; none is on while `value` is none of them. */
export function ValueChoiceSwitch(props: {
  readonly label: string;
  readonly value: string;
  readonly choices: readonly ValueChoice[];
  readonly disabled?: boolean | undefined;
  readonly className?: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  assert(props.choices.length > 0, 'ValueChoiceSwitch: there is something to choose');
  assert(props.choices.length <= CHOICES_MAX, 'ValueChoiceSwitch: the choices fit one row');
  const options: readonly SegmentedOption<string>[] = props.choices.map((choice) => ({
    value: choice.value,
    label: choice.icon,
    ariaLabel: choice.label,
    tooltip: choice.label,
  }));
  return (
    <SegmentedControl
      ariaLabel={props.label}
      className={['value-choices', props.className].filter((name) => name !== undefined).join(' ')}
      options={options}
      // Square buttons packed to the start, never a bar across the row (valueChoices.css).
      widthMode="hug"
      value={props.value}
      disabled={props.disabled === true}
      onChange={props.onChange}
    />
  );
}
