import { assert } from '../core/assert';
// Disk guide validation is independent of browser CSS.supports and geometry.
import { boolean, record, text } from '../core/boundary';
import { GUIDE_LIMITS } from './guideLimits';

export function validateGuidePreferences(input: unknown): void {
  const value = record(input);
  boolean(value['visible']);
  boolean(value['numbers']);
  const color = text(value['color']);
  if (color.length === 0 || color.length > GUIDE_LIMITS.colorCharsMax || color.includes('var(')) {
    throw new Error('Invalid guide color');
  }
  boundedNumber(value['opacity'], GUIDE_LIMITS.opacityMin, GUIDE_LIMITS.opacityMax);
  const columns = record(value['columns']);
  switch (columns['kind']) {
    case 'automatic':
      break;
    case 'count': {
      const count = boundedNumber(columns['count'], GUIDE_LIMITS.columnPickMin, GUIDE_LIMITS.columnPickMax);
      if (!Number.isSafeInteger(count)) {
        throw new Error('Guide columns must be a whole number');
      }
      break;
    }
    case 'variable':
      variableName(columns['name']);
      break;
    default:
      throw new Error('Invalid guide column setting');
  }
  for (const key of ['margin', 'gutter', 'widthMax']) {
    if (value[key] !== undefined) {
      validateGuideSize(value[key]);
    }
  }
}

function validateGuideSize(input: unknown): void {
  const value = record(input);
  if (value['kind'] === 'variable') {
    variableName(value['name']);
    return;
  }
  if (value['kind'] !== 'length') {
    throw new Error('Invalid guide size');
  }
  const length = record(value['length']);
  const unit = length['unit'];
  if (unit !== 'px' && unit !== 'rem') {
    throw new Error('Invalid guide unit');
  }
  boundedNumber(length['amount'], 0, unit === 'px' ? GUIDE_LIMITS.lengthPxMax : GUIDE_LIMITS.lengthRemMax);
}

function variableName(input: unknown): void {
  const name = text(input);
  if (name.length > GUIDE_LIMITS.variableCharsMax || !/^--[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error('Invalid guide variable name');
  }
}

function boundedNumber(input: unknown, minimum: number, maximum: number): number {
  assert(minimum >= 0, 'Guide bounds never accept negative dimensions or counts');
  assert(minimum <= maximum, 'Guide numeric bounds are ordered');
  if (typeof input !== 'number' || !Number.isFinite(input) || input < minimum || input > maximum) {
    throw new Error('Guide number is outside its allowed range');
  }
  return input;
}
