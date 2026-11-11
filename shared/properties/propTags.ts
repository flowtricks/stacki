// The JSDoc tag vocabulary of a prop's doc comment, read in one place so every
// reader of a prop (the main-process prop model, the instance Settings panel,
// the Properties panel and the bind-dot "New property" form) understands the
// same tags the same way. Before this module the schema reader understood
// `@step`/`@int` and the form wrote `@decimals`, so a Number prop made in the
// form lost its whole-number rule on the instance (docs/plans/prop-controls.md §1.1).
//
//   @min 0             the least a number prop takes
//   @max 10            the most (a max below the min contradicts it and is dropped)
//   @step 0.5          the step a number field moves by
//   @decimals 0        how many decimals it keeps (0 is a whole number)
//   @int / @integer    a whole number
//   @format color      what a text prop holds (a colour, a link)
//   @group Layout      the section a prop is listed under
//   @deprecated text   the author's notice that the prop is on its way out
//
// `@onLabel` and `@offLabel` (a switch's side names) were once written here.
// Astro has no such thing for a boolean, so nothing reads their values now; they
// are still recognized as setting tags only so an old doc's tooltip stays clean.
//
// The text before the first tag is the tooltip. The doc arrives as source text
// someone wrote, so every value is checked before it is returned; a tag whose
// value is not valid is treated as absent. Pure: the same text, the same tags.

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';

/** Every tag a prop's doc can state; undefined is "not stated". */
export interface PropTags {
  readonly tooltip: string;
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly step: number | undefined;
  readonly decimals: number | undefined;
  readonly integer: boolean;
  readonly format: string | undefined;
  readonly group: string | undefined;
  // The `@deprecated` text ('' for the bare tag), or undefined when the prop is not deprecated.
  readonly deprecated: string | undefined;
}

// Bounds of the tag values. They live here, next to the code that enforces
// them (AGENTS.md §5); they may move to shared/core/limits.ts with approval.
export const PROP_TAG_LIMITS = {
  // A doc comment is prose about one prop; four attributes' worth is past any.
  docCharsMax: LIMITS.attrCharsMax * 4,
  decimalsMax: 10,
  groupCharsMax: 80,
} as const;

const NUMBER_TAG_SOURCE = String.raw`(-?\d+(?:\.\d+)?)(?![\d.]*\d)`;

/** The tags a doc comment states; tags that are not valid are absent. */
export function readPropTags(documentation: string | undefined): PropTags {
  const text = documentation ?? '';
  assert(text.length <= PROP_TAG_LIMITS.docCharsMax, 'readPropTags: doc text is bounded');
  const tagAt = text.search(/(^|\s)@\w/);
  const tooltip = (tagAt < 0 ? text : text.slice(0, tagAt)).replace(/\s+/g, ' ').trim();
  const min = numberTag(text, 'min');
  const maxStated = numberTag(text, 'max');
  // A max below the min contradicts it; the min, written first, stands.
  const max = min !== undefined && maxStated !== undefined && maxStated < min ? undefined : maxStated;
  const decimalsStated = numberTag(text, 'decimals');
  const decimals =
    decimalsStated !== undefined && Number.isSafeInteger(decimalsStated) && decimalsStated >= 0 && decimalsStated <= PROP_TAG_LIMITS.decimalsMax
      ? decimalsStated
      : undefined;
  const stepStated = numberTag(text, 'step');
  const tags: PropTags = {
    tooltip,
    min,
    max,
    step: stepStated !== undefined && stepStated > 0 ? stepStated : undefined,
    decimals,
    integer: /@(?:int|integer)\b/i.test(text),
    format: formatTag(text),
    group: labelTag(text, 'group', PROP_TAG_LIMITS.groupCharsMax),
    deprecated: deprecationOf(text),
  };
  assert(tags.min === undefined || tags.max === undefined || tags.min <= tags.max, 'readPropTags: the range is ordered');
  assert(tags.tooltip.length <= text.length, 'readPropTags: the tooltip is part of the doc');
  return tags;
}

/**
 * The step a number field moves by, from the tags: an explicit `@step`, else
 * the precision `@decimals` states (2 is 0.01), else 1 for `@int`.
 */
export function tagStep(tags: Pick<PropTags, 'step' | 'decimals' | 'integer'>): number | undefined {
  if (tags.step !== undefined) {
    return tags.step;
  }
  if (tags.decimals !== undefined) {
    const step = Number((10 ** -tags.decimals).toFixed(tags.decimals));
    assert(step > 0, 'tagStep: a precision gives a positive step');
    return step;
  }
  return tags.integer ? 1 : undefined;
}

const DEPRECATED_TAG = /(?:^|\s)@deprecated\b([^@]*)/;

/** A doc's `@deprecated` text, spaces collapsed ('' for the bare tag); undefined when it has no such tag. */
export function deprecationOf(documentation: string | undefined): string | undefined {
  const text = documentation ?? '';
  assert(text.length <= PROP_TAG_LIMITS.docCharsMax, 'deprecationOf: doc text is bounded');
  const match = DEPRECATED_TAG.exec(text) ?? undefined;
  if (match === undefined) {
    return undefined;
  }
  const reason = (match[1] ?? '').replace(/\s+/g, ' ').trim();
  assert(reason.length <= text.length, 'deprecationOf: the reason is part of the doc');
  return reason;
}

const SETTING_TAG = /(?<=^|\s)@(min|max|step|decimals|int|integer|onLabel|offLabel|format|group)\b[^\n@]*/g;

/** The doc as a reader sees it: the setting tags taken out, every other word kept. */
export function withoutSettingTags(documentation: string): string {
  assert(documentation.length <= PROP_TAG_LIMITS.docCharsMax, 'withoutSettingTags: doc text is bounded');
  const out = documentation.replace(SETTING_TAG, '').replace(/\s+/g, ' ').trim();
  assert(out.length <= documentation.length, 'withoutSettingTags: only removes text');
  return out;
}

// `@min 2` reads 2; `@min 1.` at the end of a sentence still reads 1. Case is
// ignored for the number tags, as the schema reader always did.
function numberTag(text: string, name: string): number | undefined {
  const match = new RegExp(`@${name}[ \\t]+${NUMBER_TAG_SOURCE}`, 'i').exec(text) ?? undefined;
  const value = match?.[1];
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function labelTag(text: string, name: string, charsMax: number): string | undefined {
  const match = new RegExp(`@${name}[ \\t]+([^\\n@*]+)`).exec(text) ?? undefined;
  const label = match?.[1]?.trim();
  return label === undefined || label === '' || label.length > charsMax ? undefined : label;
}

function formatTag(text: string): string | undefined {
  const match = /@format[ \t]+([A-Za-z][\w-]*)/.exec(text) ?? undefined;
  return match?.[1]?.toLowerCase();
}
