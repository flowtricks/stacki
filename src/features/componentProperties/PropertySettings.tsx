// A property's kind settings in the Properties panel: a Number's Min, Max and
// Decimals, and the tooltip. A Switch has none: Astro gives a boolean no side
// names, so the On and Off labels Stacki once wrote are legacy tags the tooltip
// offers to remove. They are the same
// JSDoc tags the bind dot's new-prop form writes (propDocumentation.ts), edited
// in place on the property's description (settingTags.ts). Each field
// keeps the text as typed, so a half-typed number (`-`) stays on screen while
// the description only ever holds a value that reads back.

import { useState } from 'react';
import AutoTextarea from '../../ui/AutoTextarea';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { NUMBER_DECIMALS_MAX, numberNote } from '../../editor/propDocumentation';
import { propertyKind } from './propertyKinds';
import {
  legacyTagsOf,
  numberSettingProblem,
  numberSettingsOf,
  tagValue,
  tooltipOf,
  withTag,
  withTooltip,
  withoutLegacyTags,
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
  return undefined;
}

/** The tooltip: the description's words, without the setting tags the fields above own. */
// Legacy `@onLabel`/`@offLabel` tags stay as written until the person edits
// these docs; then the field offers to take them out.
export function PropertyTooltip({ property, onChange }: SettingsProps) {
  const translate = useTranslate();
  const [editing, setEditing] = useState(false);
  const legacy = legacyTagsOf(property.description);
  return (
    <>
      <label>
        {translate('componentProps.settings.tooltip')}
        <AutoTextarea
          value={tooltipOf(property.description)}
          maxLength={PROPERTY_LIMITS.textCharsMax}
          placeholder={translate('componentProps.settings.tooltipPlaceholder')}
          onFocus={() => setEditing(true)}
          onChange={(event) => onChange(withTooltip(property.description, event.target.value))}
        />
      </label>
      {editing && legacy.length > 0 && (
        <p className="property-help property-legacy-tags">
          {translate('componentProps.settings.legacyTags', { count: legacy.length })}{' '}
          <button type="button" className="property-legacy-remove" onClick={() => onChange(withoutLegacyTags(property.description))}>
            {translate('componentProps.settings.legacyRemove', { count: legacy.length })}
          </button>
        </p>
      )}
    </>
  );
}

/** Why the default sits outside a number's settings, or nothing when it fits. */
export function PropertyDefaultNote({ property }: { readonly property: ComponentProperty }) {
  const translate = useTranslate();
  if (propertyKind(property) !== 'number' || property.defaultValue.trim() === '') {
    return undefined;
  }
  const value = Number(property.defaultValue);
  const note = Number.isFinite(value) ? numberNote(value, numberSettingsOf(property.description), translate) : undefined;
  return note === undefined ? undefined : <p className="property-help property-default-note">{translate('componentProps.settings.defaultNote', { note })}</p>;
}

type NumberTag = Extract<SettingTagName, 'min' | 'max' | 'decimals'>;
const NUMBER_TEXT = /^-?\d+(\.\d+)?$/;

function NumberSettingsFields({ property, onChange }: SettingsProps) {
  const translate = useTranslate();
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
  const problem = malformed ? translate('componentProps.settings.numberMalformed') : numberSettingProblem(typed, translate);
  const change = (name: NumberTag, text: string): void => {
    const next = { ...texts, [name]: text };
    setTexts(next);
    const settings = { min: numberText(next.min), max: numberText(next.max), decimals: numberText(next.decimals) };
    const value = numberText(text);
    // Only a setting that reads back is written; the field keeps what was typed meanwhile.
    if ((text.trim() === '' || value !== undefined) && numberSettingProblem(settings, translate) === undefined) {
      onChange(withTag(property.description, name, value === undefined ? undefined : String(value)));
    }
  };
  return (
    <div className="property-settings" role="group" aria-label={translate('componentProps.settings.numberGroup')}>
      <div className="property-settings-row">
        <NumberSettingField
          label={translate('componentProps.settings.min')}
          placeholder={translate('componentProps.settings.none')}
          text={texts.min}
          onChange={(text) => change('min', text)}
        />
        <NumberSettingField
          label={translate('componentProps.settings.max')}
          placeholder={translate('componentProps.settings.none')}
          text={texts.max}
          onChange={(text) => change('max', text)}
        />
        <NumberSettingField
          label={translate('componentProps.settings.decimals')}
          placeholder={translate('componentProps.settings.auto')}
          text={texts.decimals}
          title={translate('componentProps.settings.decimalsHint', { max: NUMBER_DECIMALS_MAX })}
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

function numberText(text: string): number | undefined {
  const trimmed = text.trim();
  return NUMBER_TEXT.test(trimmed) ? Number(trimmed) : undefined;
}
