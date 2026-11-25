// The style panel's side of the project's length unit (shared/properties/lengthUnit.ts).
//
// The host carries one setting for the whole panel, derived from the project
// scan. Controls ask it here rather than each deciding for themselves:
//
//   writtenValue    the funnel every set and live set passes through: a value's
//                   px lengths become rem in a rem project, whichever control,
//                   gesture or typed text produced them;
//   sliderLength    how a slider beside a length field maps to it: in a rem
//                   project the slider moves in whole pixels and writes rem;
//   useLengthUnit   the setting for a component to render with.

import { useSyncExternalStore } from 'react';
import { assert } from '../../../../shared/core/assert';
import {
  convertPxLengths,
  formatPxLength,
  lengthUnitName,
  projectDefaultUnit,
  pxPerLengthUnit,
  type LengthUnit,
} from '../../../../shared/properties/lengthUnit';
import { clampNonNegative } from './cssProperties';
import { getHost, onHostChange } from './host';

/** The project's length unit, as the host has it now. */
export function projectLengthUnit(): LengthUnit {
  return getHost().lengthUnit;
}

/** The project's length unit, re-rendering when a rescan changes it. */
export function useLengthUnit(): LengthUnit {
  return useSyncExternalStore(onHostChange, projectLengthUnit);
}

/**
 * A value as the panel writes it: a negative gap or padding clamped to zero,
 * then every px length in the project's unit. Held here, at the one place a
 * set and a live set both pass, because a value reaches a write from a typed
 * edit, an arrow step, a drag, a variable pick and the add-property row — a
 * unit enforced in one control is a unit the other four ways around it miss.
 */
export function writtenValue(prop: string, typed: string, lengthUnit: LengthUnit = projectLengthUnit()): string {
  return convertPxLengths(clampNonNegative(prop, typed), lengthUnit);
}

/** How a slider maps onto a length field's value. */
export interface SliderLength {
  /** The slider's position for the current value; undefined when it has none (var(), calc()). */
  readonly position: number | undefined;
  /** The slider's range and step, in the slider's own space. */
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** The value a slider position writes. */
  readonly format: (position: number) => string;
  /** The unit a bare typed number takes, and a cleared field shows. */
  readonly unit: string;
}

/**
 * A slider beside a length field. `range` is in px for a px default (shadow
 * offsets, blur), otherwise in the default unit (%, deg).
 *
 * A px project keeps the slider exactly as it was: it moves in the value's own
 * unit. A rem project moves a px-or-rem length in whole pixels — range and
 * step stay what they were — and writes rem, so a drag lands on 0.0625rem steps
 * at a 16px root. Other units (%, em, deg) are left in their own unit.
 */
export function sliderLength(
  value: { readonly amount: number; readonly unit: string } | undefined,
  defaultUnit: string,
  range: { readonly min: number; readonly max: number },
  lengthUnit: LengthUnit,
): SliderLength {
  assert(range.min <= range.max, 'sliderLength: the range is ordered');
  const unit = value?.unit ?? projectDefaultUnit(defaultUnit, lengthUnit);
  const pxPerUnit = pxPerLengthUnit(unit, lengthUnit);
  if (lengthUnit.kind === 'rem' && pxPerUnit !== undefined) {
    return {
      position: value === undefined ? undefined : value.amount * pxPerUnit,
      min: range.min,
      max: range.max,
      step: 1,
      format: (position) => formatPxLength(position, lengthUnit),
      unit: lengthUnitName(lengthUnit),
    };
  }
  return {
    position: value?.amount,
    min: range.min,
    max: range.max,
    step: 1,
    format: (position) => `${position}${unit}`,
    unit,
  };
}
