// A prop's doc comment, read as its tooltip and its settings. The settings are
// JSDoc tags written by the property settings form (propDeclaration.ts):
//
//   @min 0          the least a number prop takes
//   @max 10         the most
//   @decimals 0     how many decimals it keeps (0 is a whole number)
//   @format color   what a text prop holds (a colour, a link); the Kind picker writes it
//
// `@deprecated` is the author's, not a setting: the instance field shows a
// "Deprecated" tag with its text in the tooltip.
//
// A tag left out is the setting's default: no bound, any precision. A switch
// has no settings; old `@onLabel`/`@offLabel` tags are ignored (propTags.ts).
// The text before the first tag is the tooltip. The doc arrives as the schema
// read it from the file, so every value is checked before use.
//
// The tags are read by shared/properties/propTags.ts, the one tag reader the
// main process's prop model reads them with too, so a setting this form
// writes is the setting every panel shows (docs/plans/prop-controls.md §1.1).

import { assert } from '../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import { PROP_TAG_LIMITS, deprecationOf, readPropTags, withoutSettingTags } from '../../shared/properties/propTags';

export { deprecationOf, withoutSettingTags };

/** A number prop's range and precision; undefined is None (or Auto for decimals). */
export interface NumberSettings {
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly decimals: number | undefined;
}

/** A doc comment read as a tooltip and settings. */
export interface PropDocumentation {
  readonly tooltip: string;
  readonly number: NumberSettings;
  // The `@format` word (`color`, `uri`), or undefined when the doc states none.
  readonly format: string | undefined;
  // The `@deprecated` text ('' for the bare tag), or undefined when the prop is not deprecated.
  readonly deprecated: string | undefined;
}

export const NUMBER_DECIMALS_MAX = PROP_TAG_LIMITS.decimalsMax;

/** The tooltip and settings a doc comment states; tags that are not valid settings are ignored. */
export function readPropDocumentation(documentation: string | undefined): PropDocumentation {
  const tags = readPropTags(documentation);
  const result: PropDocumentation = {
    tooltip: tags.tooltip,
    number: { min: tags.min, max: tags.max, decimals: tags.decimals },
    format: tags.format,
    deprecated: tags.deprecated,
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
export function numberNote(value: number, settings: NumberSettings, translate: Translator = ENGLISH_TRANSLATE): string | undefined {
  if (!Number.isFinite(value)) {
    return translate('editor.propDocumentation.enterNumber');
  }
  if (settings.min !== undefined && value < settings.min) {
    return translate('editor.propDocumentation.least', { min: settings.min });
  }
  if (settings.max !== undefined && value > settings.max) {
    return translate('editor.propDocumentation.most', { max: settings.max });
  }
  if (settings.decimals !== undefined && Number(value.toFixed(settings.decimals)) !== value) {
    return settings.decimals === 0
      ? translate('editor.propDocumentation.wholeNumbers')
      : translate('editor.propDocumentation.decimals', { count: settings.decimals });
  }
  return undefined;
}

const DEPRECATED_LINE = /(?<=^|\s)@deprecated\b[^@]*/g;

/**
 * The tooltip an instance field shows: its deprecation first, as a sentence,
 * then the doc without its setting tags or its `@deprecated` line. Empty when
 * there is nothing to say. The deprecation is passed in, so a schema that
 * states it as a field of its own reads the same as one left in the doc.
 */
export function fieldTooltip(documentation: string | undefined, deprecated: string | undefined, translate: Translator = ENGLISH_TRANSLATE): string {
  const words = withoutSettingTags(documentation ?? '')
    .replace(DEPRECATED_LINE, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (deprecated === undefined) {
    return words;
  }
  const notice =
    deprecated === '' ? translate('editor.propDocumentation.deprecated') : translate('editor.propDocumentation.deprecatedNote', { note: deprecated });
  const out = words === '' ? notice : `${notice}\n${words}`;
  assert(out.startsWith(notice), 'fieldTooltip: a deprecation leads the tooltip');
  return out;
}
