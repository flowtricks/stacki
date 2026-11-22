import type { ReactNode } from 'react';
import { assert } from '../../../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../lib/i18n/localeContext';
import { clipOptions } from '../BackgroundSection';
import { DISPLAY_VALUES, displayMenuLabel } from '../DisplayControl';
import { BLEND_MODES, cursorOptions, eventsOptions, outlineOptions } from '../EffectsKit';
import { FIT_OPTIONS } from '../ObjectFitFields';
import { POSITION_PRESETS } from '../PositionSection';
import { clearSegments, floatSegments, type Seg } from '../PositionSegments';
import type { SegOption } from '../SegmentedField';
import { BOX_OPTIONS, OVERFLOW_SEGS } from '../SizeSection';
import { TEXT_OVERFLOW_OPTIONS, WHITE_SPACE, WORD_BREAK, WRAP_OPTIONS } from '../TextWrapRows';
import { alignSegments, decorSegments, directionSegments, italicSegments, transformSegments } from '../TypographySection';
import type { SelectOption } from '../components/selectTypes';

// The keyword properties a code chip opens the Style panel's own choice for: one table, property to
// the panel's option list, read through an adapter per kind of list the panel keeps (icon segments,
// labelled segments, dropdown options, [value, label] pairs). Nothing here defines an option: every
// value, label and icon is the panel's, so a chip offers exactly what the panel's control offers.
//
// The table is what the scanner knows as keywords, and the values a chip's glyph is drawn from. The
// popup itself is the panel's own control (KeywordChipControl.tsx) for a property the panel edits
// with a segmented bar, and the panel dropdown's list, in this table's order, for the rest.

/** One keyword the panel offers for a property: the CSS value, its name, and its icon if it has one. */
export interface KeywordOption {
  readonly value: string;
  readonly text: string;
  readonly icon: ReactNode | undefined;
}

interface KeywordProperty {
  readonly options: (translate: Translator) => readonly KeywordOption[];
  /** The values drawn as the button group, in the panel's order; the rest are listed. */
  readonly segments: (options: readonly KeywordOption[]) => readonly string[];
}

/** The most options drawn as one button group in a 340px popover; a longer set is a list. */
export const KEYWORD_SEGMENTS_MAX = 5;

const allWhenShort = (options: readonly KeywordOption[]): readonly string[] =>
  options.length <= KEYWORD_SEGMENTS_MAX ? options.map((option) => option.value) : [];

// ─────────────────────────── Adapters ───────────────────────────

function fromSegs(segs: readonly Seg[]): readonly KeywordOption[] {
  return segs.map((seg) => ({ value: seg.value, text: seg.label, icon: seg.icon }));
}

function fromSegOptions(options: readonly SegOption[]): readonly KeywordOption[] {
  // A segment's label is its drawing (a line style) or a word; the menu label is always its name.
  return options.map((option) => ({ value: option.value, text: option.menuLabel, icon: typeof option.label === 'string' ? undefined : option.label }));
}

function fromSelect(options: readonly SelectOption<string>[]): readonly KeywordOption[] {
  // A heading row (a cursor group's title) names a group and is never a value.
  return options.filter((option) => option.heading !== true).map((option) => ({ value: option.value, text: option.label, icon: option.icon }));
}

function fromPairs(pairs: ReadonlyArray<readonly [string, string]>): readonly KeywordOption[] {
  return pairs.map(([value, text]) => ({ value, text, icon: undefined }));
}

function fromKeyed(
  options: ReadonlyArray<{ readonly value: string; readonly icon?: ReactNode; readonly labelKey: Parameters<Translator>[0] }>,
  translate: Translator,
): readonly KeywordOption[] {
  return options.map((option) => ({ value: option.value, text: translate(option.labelKey), icon: option.icon }));
}

// ─────────────────────────── The table ───────────────────────────

const overflow: KeywordProperty = { options: (translate) => fromKeyed(OVERFLOW_SEGS, translate), segments: allWhenShort };

/** Every keyword property a chip offers, and where the panel keeps its options. */
export const KEYWORD_PROPERTIES = {
  display: {
    options: () => DISPLAY_VALUES.map((value) => ({ value, text: displayMenuLabel(value), icon: undefined })),
    // The panel's bar: Block, Flex, Grid, then None in its fourth slot; the inline set is its menu.
    segments: () => ['block', 'flex', 'grid', 'none'],
  },
  overflow,
  'overflow-x': overflow,
  'overflow-y': overflow,
  'box-sizing': { options: (translate) => fromKeyed(BOX_OPTIONS, translate), segments: allWhenShort },
  'object-fit': { options: () => fromSelect(FIT_OPTIONS), segments: allWhenShort },
  position: { options: () => POSITION_PRESETS.map((preset) => ({ value: preset.value, text: preset.label, icon: preset.icon })), segments: allWhenShort },
  float: { options: (translate) => fromSegs(floatSegments(translate)), segments: allWhenShort },
  clear: { options: (translate) => fromSegs(clearSegments(translate)), segments: allWhenShort },
  'text-align': { options: (translate) => fromSegs(alignSegments(translate)), segments: allWhenShort },
  'text-decoration': { options: (translate) => fromSegs(decorSegments(translate)), segments: allWhenShort },
  'font-style': { options: (translate) => fromSegs(italicSegments(translate)), segments: allWhenShort },
  'text-transform': { options: (translate) => fromSegs(transformSegments(translate)), segments: allWhenShort },
  direction: { options: (translate) => fromSegs(directionSegments(translate)), segments: allWhenShort },
  'word-break': { options: () => fromPairs(WORD_BREAK.options), segments: allWhenShort },
  'white-space': { options: () => fromPairs(WHITE_SPACE.options), segments: allWhenShort },
  'text-overflow': {
    options: () => TEXT_OVERFLOW_OPTIONS.map((option) => ({ value: option.value, text: option.label, icon: undefined })),
    segments: allWhenShort,
  },
  'overflow-wrap': { options: () => fromPairs(WRAP_OPTIONS), segments: allWhenShort },
  'background-clip': {
    options: (translate) => clipOptions(translate).map((option) => ({ value: option.value, text: option.label, icon: undefined })),
    segments: allWhenShort,
  },
  'mix-blend-mode': { options: () => fromSelect(BLEND_MODES), segments: allWhenShort },
  'outline-style': { options: (translate) => fromSegOptions(outlineOptions(translate)), segments: allWhenShort },
  cursor: { options: (translate) => fromSelect(cursorOptions(translate)), segments: allWhenShort },
  'pointer-events': { options: (translate) => fromSegOptions(eventsOptions(translate)), segments: allWhenShort },
} as const satisfies Record<string, KeywordProperty>;

export type KeywordPropertyName = keyof typeof KEYWORD_PROPERTIES;

const KEYWORD_NAMES: ReadonlySet<string> = new Set(Object.keys(KEYWORD_PROPERTIES));

/** Whether `property` is one a keyword chip offers. */
export function isKeywordProperty(property: string): property is KeywordPropertyName {
  return KEYWORD_NAMES.has(property);
}

// The values of each property, read once from the panel's lists: they never depend on the language,
// so the English names are as good as any for knowing which keywords there are.
const KEYWORD_VALUES = new Map<string, ReadonlySet<string>>();
function valuesOf(property: KeywordPropertyName): ReadonlySet<string> {
  const known = KEYWORD_VALUES.get(property);
  if (known !== undefined) {
    return known;
  }
  const values = new Set(KEYWORD_PROPERTIES[property].options(ENGLISH_TRANSLATE).map((option) => option.value.toLowerCase()));
  assert(values.size > 0, 'valuesOf: a keyword property has options');
  KEYWORD_VALUES.set(property, values);
  return values;
}

/** Whether `value` is one of the keywords the panel offers for `property` (case aside). */
export function isKeywordOf(property: KeywordPropertyName, value: string): boolean {
  return valuesOf(property).has(value.trim().toLowerCase());
}

/** The panel's options for `property`, split into its button group and the list under it. */
export function keywordChoices(
  property: KeywordPropertyName,
  translate: Translator,
): { readonly segments: readonly KeywordOption[]; readonly list: readonly KeywordOption[] } {
  const entry: KeywordProperty = KEYWORD_PROPERTIES[property];
  const options = entry.options(translate);
  const segmentValues = new Set(entry.segments(options));
  const segments = options.filter((option) => segmentValues.has(option.value));
  const list = options.filter((option) => !segmentValues.has(option.value));
  assert(segments.length + list.length === options.length, 'keywordChoices: every option is drawn once');
  assert(segments.length <= KEYWORD_SEGMENTS_MAX, 'keywordChoices: the button group fits the popover');
  return { segments, list };
}

/** The panel's option for `value` of `property`, for the chip's icon; undefined for no keyword it has. */
export function keywordOption(property: KeywordPropertyName, value: string, translate: Translator): KeywordOption | undefined {
  const lower = value.trim().toLowerCase();
  return KEYWORD_PROPERTIES[property].options(translate).find((option) => option.value.toLowerCase() === lower);
}
