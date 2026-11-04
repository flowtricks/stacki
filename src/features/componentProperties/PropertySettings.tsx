// A property's kind settings in the Properties panel: a Number's Min, Max and
// Decimals, a Switch's On and Off labels, and the tooltip. They are the same
// JSDoc tags the bind dot's new-prop form writes (propDocumentation.ts), edited
// in place on the property's description (settingTags.ts). Each field
// keeps the text as typed, so a half-typed number (`-`) stays on screen while
// the description only ever holds a value that reads back.

import { useState } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { NUMBER_DECIMALS_MAX, SWITCH_LABELS, numberNote } from '../../editor/propDocumentation';
import { propertyKind } from './propertyKinds';
import {
  SWITCH_LABEL_CHARS_MAX,
  numberSettingProblem,
  numberSettingsOf,
  switchLabelTag,
  tagValue,
  tooltipOf,
  withTag,
  withTooltip,
  type SettingTagName,
} from './settingTags';

interface SettingsProps {
  readonly property: ComponentProperty;
  readonly onChange: (description: string) => void;
}

/** The fields the property's kind has settings for, or nothing. */
export function PropertyKindSettings({ property, onChange }: SettingsProps) {
  const kind = propertyKind(property);
  if (kind === 'number') {
    return <NumberSettingsFields key="number" property={property} onChange={onChange} />;
  }
  if (kind === 'switch') {
    return <SwitchSettingsFields key="switch" property={property} onChange={onChange} />;
  }
  return undefined;
}

/** The tooltip: the description's words, without the setting tags the fields above own. */
export function PropertyTooltip({ property, onChange }: SettingsProps) {
  return (
    <label>
      Tooltip
      <textarea
        value={tooltipOf(property.description)}
        rows={5}
        maxLength={PROPERTY_LIMITS.textCharsMax}
        placeholder="Describe how to use this property…"
        onChange={(event) => onChange(withTooltip(property.description, event.target.value))}
      />
    </label>
  );
}

/** Why the default sits outside a number's settings, or nothing when it fits. */
export function PropertyDefaultNote({ property }: { readonly property: ComponentProperty }) {
  if (propertyKind(property) !== 'number' || property.defaultValue.trim() === '') {
    return undefined;
  }
  const value = Number(property.defaultValue);
  const note = Number.isFinite(value) ? numberNote(value, numberSettingsOf(property.description)) : undefined;
  return note === undefined ? undefined : <p className="property-help property-default-note">The default: {note}</p>;
}

type NumberTag = Extract<SettingTagName, 'min' | 'max' | 'decimals'>;
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

function NumberSettingsFields({ property, onChange }: SettingsProps) {
  const [texts, setTexts] = useState<Readonly<Record<NumberTag, string>>>(() => ({
    min: tagValue(property.description, 'min') ?? '',
    max: tagValue(property.description, 'max') ?? '',
    decimals: tagValue(property.description, 'decimals') ?? '',
  }));
  const typed = {
    min: numberText(texts.min),
    max: numberText(texts.max),
    decimals: numberText(texts.decimals),
  };
  const malformed = (['min', 'max', 'decimals'] as const).some((name) => texts[name].trim() !== '' && typed[name] === undefined);
  const problem = malformed ? 'Enter a number, or leave it empty for none.' : numberSettingProblem(typed);
  const change = (name: NumberTag, text: string): void => {
    const next = { ...texts, [name]: text };
    setTexts(next);
    const settings = { min: numberText(next.min), max: numberText(next.max), decimals: numberText(next.decimals) };
    const value = numberText(text);
    // Only a setting that reads back is written; the field keeps what was typed meanwhile.
    if ((text.trim() === '' || value !== undefined) && numberSettingProblem(settings) === undefined) {
      onChange(withTag(property.description, name, value === undefined ? undefined : String(value)));
    }
  };
  return (
    <div className="property-settings" role="group" aria-label="Number settings">
      <div className="property-settings-row">
        <NumberSettingField label="Min" placeholder="None" text={texts.min} onChange={(text) => change('min', text)} />
        <NumberSettingField label="Max" placeholder="None" text={texts.max} onChange={(text) => change('max', text)} />
        <NumberSettingField
          label="Decimals"
          placeholder="Auto"
          text={texts.decimals}
          title={`How many decimals the number keeps: 0 is a whole number, at most ${NUMBER_DECIMALS_MAX}.`}
          onChange={(text) => change('decimals', text)}
        />
      </div>
      {problem !== undefined && <p className="property-help property-settings-problem">{problem}</p>}
    </div>
  );
}

function NumberSettingField(props: {
  readonly label: string;
  readonly placeholder: string;
  readonly text: string;
  readonly title?: string;
  readonly onChange: (text: string) => void;
}) {
  return (
    <label title={props.title}>
      {props.label}
      <input
        aria-label={props.label}
        inputMode="decimal"
        placeholder={props.placeholder}
        value={props.text}
        maxLength={32}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </label>
  );
}

function SwitchSettingsFields({ property, onChange }: SettingsProps) {
  const [texts, setTexts] = useState(() => ({
    onLabel: tagValue(property.description, 'onLabel') ?? '',
    offLabel: tagValue(property.description, 'offLabel') ?? '',
  }));
  const change = (side: 'onLabel' | 'offLabel', text: string): void => {
    setTexts({ ...texts, [side]: text });
    onChange(withTag(property.description, side, switchLabelTag(text, side)));
  };
  return (
    <div className="property-settings" role="group" aria-label="Switch settings">
      <div className="property-settings-row">
        <label>
          On label
          <input
            aria-label="On label"
            placeholder={SWITCH_LABELS.onLabel}
            value={texts.onLabel}
            maxLength={SWITCH_LABEL_CHARS_MAX}
            onChange={(event) => change('onLabel', event.target.value)}
          />
        </label>
        <label>
          Off label
          <input
            aria-label="Off label"
            placeholder={SWITCH_LABELS.offLabel}
            value={texts.offLabel}
            maxLength={SWITCH_LABEL_CHARS_MAX}
            onChange={(event) => change('offLabel', event.target.value)}
          />
        </label>
      </div>
    </div>
  );
}

function numberText(text: string): number | undefined {
  const trimmed = text.trim();
  return NUMBER_TEXT.test(trimmed) ? Number(trimmed) : undefined;
}
