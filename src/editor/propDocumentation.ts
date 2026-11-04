// A prop's doc comment, read as its tooltip and its settings. The settings are
// JSDoc tags written by the property settings form (propDeclaration.ts):
//
//   @min 0          the least a number prop takes
//   @max 10         the most
//   @decimals 0     how many decimals it keeps (0 is a whole number)
//   @onLabel Shown  what a switch prop's on side is called
//   @offLabel Hidden
//
// A tag left out is the setting's default: no bound, any precision, On and
// Off. The text before the first tag is the tooltip. The doc arrives as the
// schema read it from the file, so every value is checked here before use.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

/** A number prop's range and precision; undefined is None (or Auto for decimals). */
export interface NumberSettings {
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly decimals: number | undefined;
}

/** What a switch prop's two sides are called. */
export interface SwitchSettings {
  readonly onLabel: string;
  readonly offLabel: string;
}

/** A doc comment read as a tooltip and settings. */
export interface PropDocumentation {
  readonly tooltip: string;
  readonly number: NumberSettings;
  readonly switch: SwitchSettings;
}

export const NUMBER_DECIMALS_MAX = 10;
export const SWITCH_LABELS = { onLabel: 'On', offLabel: 'Off' } as const;
const LABEL_CHARS_MAX = 40;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/** The tooltip and settings a doc comment states; tags that are not valid settings are ignored. */
export function readPropDocumentation(documentation: string | undefined): PropDocumentation {
  const text = documentation ?? '';
  assert(text.length <= LIMITS.attrCharsMax * 4, 'readPropDocumentation: doc text is bounded');
  const tagAt = text.search(/(^|\s)@\w/);
  const tooltip = (tagAt < 0 ? text : text.slice(0, tagAt)).replace(/\s+/g, ' ').trim();
  const min = numberTag(text, 'min');
  const max = numberTag(text, 'max');
  const decimals = numberTag(text, 'decimals');
  const number: NumberSettings = {
    min,
    // A max below the min contradicts it; the min, written first, stands.
    max: min !== undefined && max !== undefined && max < min ? undefined : max,
    decimals: decimals !== undefined && Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= NUMBER_DECIMALS_MAX ? decimals : undefined,
  };
  const result: PropDocumentation = {
    tooltip,
    number,
    switch: { onLabel: labelTag(text, 'onLabel') ?? SWITCH_LABELS.onLabel, offLabel: labelTag(text, 'offLabel') ?? SWITCH_LABELS.offLabel },
  };
  assert(
    result.number.min === undefined || result.number.max === undefined || result.number.min <= result.number.max,
    'readPropDocumentation: the range is ordered',
  );
  return result;
}

/** A typed number held to its settings: clamped into the range, rounded to its decimals. */
export function settledNumber(value: number, settings: NumberSettings): number {
  assert(Number.isFinite(value), 'settledNumber: the value is a number');
  let out = value;
  if (settings.min !== undefined && out < settings.min) {
    out = settings.min;
  }
  if (settings.max !== undefined && out > settings.max) {
    out = settings.max;
  }
  if (settings.decimals !== undefined) {
    out = Number(out.toFixed(settings.decimals));
  }
  assert(Number.isFinite(out), 'settledNumber: the result is a number');
  return out;
}

/** Why a typed number falls outside its settings, or undefined when it fits them. */
export function numberNote(value: number, settings: NumberSettings): string | undefined {
  if (!Number.isFinite(value)) {
    return 'Enter a number.';
  }
  if (settings.min !== undefined && value < settings.min) {
    return `The least this takes is ${settings.min}.`;
  }
  if (settings.max !== undefined && value > settings.max) {
    return `The most this takes is ${settings.max}.`;
  }
  if (settings.decimals !== undefined && Number(value.toFixed(settings.decimals)) !== value) {
    return settings.decimals === 0 ? 'This takes whole numbers.' : `This keeps ${settings.decimals} decimals.`;
  }
  return undefined;
}

function numberTag(text: string, name: string): number | undefined {
  const match = new RegExp(`@${name}[ \\t]+(\\S+)`).exec(text) ?? undefined;
  const value = match?.[1];
  return value !== undefined && NUMBER.test(value) ? Number(value) : undefined;
}

function labelTag(text: string, name: string): string | undefined {
  const match = new RegExp(`@${name}[ \\t]+([^\\n@*]+)`).exec(text) ?? undefined;
  const label = match?.[1]?.trim();
  return label === undefined || label === '' || label.length > LABEL_CHARS_MAX ? undefined : label;
}

const SETTING_TAG = /(?<=^|\s)@(min|max|decimals|onLabel|offLabel)\b[^\n@]*/g;

/** The doc as a reader sees it: the settings tags this module writes taken out, every other word kept. */
export function withoutSettingTags(documentation: string): string {
  assert(documentation.length <= LIMITS.attrCharsMax * 4, 'withoutSettingTags: doc text is bounded');
  return documentation.replace(SETTING_TAG, '').replace(/\s+/g, ' ').trim();
}

/** A switch prop's labels, when its doc names them; undefined keeps the field's own words. */
export function statedSwitchLabels(documentation: string | undefined): SwitchSettings | undefined {
  const text = documentation ?? '';
  if (!/@(onLabel|offLabel)\b/.test(text)) {
    return undefined;
  }
  return readPropDocumentation(text).switch;
}
