// A property's description, split into what the Properties panel shows as
// separate fields: the tooltip (the words a designer reads on hover) and the
// settings Stacki keeps as JSDoc tags on the same comment (propDocumentation.ts
// reads them: `@min`, `@max`, `@decimals`, `@onLabel`, `@offLabel`, and the
// kind tag `@format`). The new-prop form writes the same tags, so a prop made
// from the bind dot and one edited here read and write alike.
//
// Every function here takes the description as main read it and returns a
// new one; a field left alone leaves its text alone, so a save with nothing
// changed still compares equal to what was read (propertyMemberEdits.ts).
// Tags this module does not own (`@default`, `@deprecated`, …) are the
// author's words and stay in the tooltip, where the designer can see them.

import { assert } from '../../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { NUMBER_DECIMALS_MAX, SWITCH_LABELS, readPropDocumentation, type NumberSettings, type SwitchSettings } from '../../editor/propDocumentation';

/** The tags the panel edits as fields of their own. */
export const SETTING_TAG_NAMES = ['min', 'max', 'decimals', 'onLabel', 'offLabel', 'format'] as const;
export type SettingTagName = (typeof SETTING_TAG_NAMES)[number];

// The new-prop form's bound on a switch label (DECLARATION_LIMITS.labelCharsMax).
export const SWITCH_LABEL_CHARS_MAX = 40;
const LINES_MAX = 1024;
const TAG_LINE = new RegExp(`^\\s*@(${SETTING_TAG_NAMES.join('|')})\\b`);

/** The tooltip: the description without the setting tags' lines. */
export function tooltipOf(description: string): string {
  const lines = descriptionLines(description);
  return lines.filter((line) => !TAG_LINE.test(line)).join('\n');
}

/** The description with its tooltip replaced; the setting tags keep their text and follow it. */
export function withTooltip(description: string, tooltip: string): string {
  assert(tooltip.length <= PROPERTY_LIMITS.textCharsMax, 'withTooltip: the tooltip is bounded');
  const tags = descriptionLines(description).filter((line) => TAG_LINE.test(line));
  const out = tags.length === 0 ? tooltip : tooltip === '' ? tags.join('\n') : `${tooltip}\n${tags.join('\n')}`;
  assert(
    tooltipOf(out) ===
      tooltip
        .split('\n')
        .filter((line) => !TAG_LINE.test(line))
        .join('\n'),
    'withTooltip: the tooltip reads back',
  );
  return out;
}

/** The value a setting tag states, or undefined when the description has none. */
export function tagValue(description: string, name: SettingTagName): string | undefined {
  const line = descriptionLines(description).find((item) => tagName(item) === name);
  return line === undefined
    ? undefined
    : line
        .trim()
        .slice(name.length + 1)
        .trim();
}

/** The description with one setting tag set to `value`, or taken out for undefined. */
export function withTag(description: string, name: SettingTagName, value: string | undefined): string {
  const text = value?.replace(/\s+/g, ' ').trim();
  assert(text === undefined || text.length <= PROPERTY_LIMITS.textCharsMax, 'withTag: the value is bounded');
  const lines = descriptionLines(description);
  const at = lines.findIndex((line) => tagName(line) === name);
  const written = text === undefined || text === '' ? undefined : `@${name} ${text}`;
  let next: readonly string[];
  if (at >= 0) {
    next = written === undefined ? lines.filter((_, index) => index !== at) : lines.map((line, index) => (index === at ? written : line));
  } else {
    next = written === undefined ? lines : [...lines, written];
  }
  const out = next.join('\n').replace(/^\n+/, '');
  assert(tagValue(out, name) === (written === undefined ? undefined : text), 'withTag: the tag reads back');
  return out;
}

/** A number prop's settings as the description states them. */
export function numberSettingsOf(description: string): NumberSettings {
  return readPropDocumentation(description).number;
}

/** A switch prop's labels as the description states them. */
export function switchSettingsOf(description: string): SwitchSettings {
  return readPropDocumentation(description).switch;
}

/** Why a number setting as typed cannot be written, or undefined when it can. */
export function numberSettingProblem(settings: NumberSettings): string | undefined {
  if (settings.min !== undefined && settings.max !== undefined && settings.min > settings.max) {
    return 'The minimum is above the maximum.';
  }
  if (settings.decimals !== undefined) {
    if (!Number.isSafeInteger(settings.decimals)) {
      return 'Decimals is a whole number.';
    }
    if (settings.decimals < 0 || settings.decimals > NUMBER_DECIMALS_MAX) {
      return `Decimals is between 0 and ${NUMBER_DECIMALS_MAX}.`;
    }
  }
  return undefined;
}

/** A switch label as written: the default words (On, Off) are not written at all. */
export function switchLabelTag(value: string, side: 'onLabel' | 'offLabel'): string | undefined {
  const text = value.replace(/\s+/g, ' ').trim().slice(0, SWITCH_LABEL_CHARS_MAX);
  return text === '' || text === SWITCH_LABELS[side] ? undefined : text;
}

function tagName(line: string): SettingTagName | undefined {
  const match = TAG_LINE.exec(line);
  const name = match?.[1];
  return SETTING_TAG_NAMES.find((item) => item === name);
}

function descriptionLines(description: string): readonly string[] {
  assert(description.length <= PROPERTY_LIMITS.textCharsMax, 'descriptionLines: the description is bounded');
  const lines = description.split('\n');
  assert(lines.length <= LINES_MAX, 'descriptionLines: the line count is bounded');
  return lines;
}
