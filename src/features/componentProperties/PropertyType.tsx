// The Kind picker: a designer chooses what a prop holds (Text, Number,
// Switch, Choice, Link, Image, List, Group…) and the panel writes the native
// type for it (propertyKinds.ts). TypeScript's own words sit under Advanced,
// and the `{}` toggle shows the exact type expression, editable, for anything
// the kinds do not describe. A prop with options has the toggle beside its
// Options instead (PropertyOptions.tsx), where it swaps the list for the code;
// the host owns the one switch both read (PropertyEditor.tsx).

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { isKnownMessageKey, type Translator } from '../../lib/i18n/localeContext';
import Dropdown from '../../ui/Dropdown';
import type { DropdownOption } from '../../ui/Dropdown';
import {
  BracesIcon,
  CalendarIcon,
  CheckIcon,
  CodeIcon,
  ComponentPropertiesIcon,
  DropletIcon,
  ElementDivIcon,
  ElementImageIcon,
  ElementLinkIcon,
  ElementListDefaultIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  FilterIcon,
  SortIcon,
  TextIcon,
} from '../../ui/Icons';
import { CODE_TYPE_CHOICES, KIND_CHOICES, KIND_SECTION_LABELS, carriedDefault, propertyKind, withKind, type PropertyKind } from './propertyKinds';
import { withTag } from './settingTags';
import { CodeTypeEditor, CodeTypeToggle, type EditPace } from '../props/propBindings';

/** What a kind pick changes on the property. */
export type KindChange = Pick<ComponentProperty, 'type' | 'description' | 'defaultValue'>;

interface PropertyTypeProps {
  readonly property: ComponentProperty;
  readonly frontmatter: string;
  /** Whether the code type is being edited, and how to switch it. */
  readonly code: CodeMode;
  /** The Options section holds the `{}` toggle and the code field, so Kind does not. */
  readonly optionsHoldCode: boolean;
  readonly onChange: (change: KindChange, pace: EditPace) => void;
}

/** The code type switch the Kind and the Options share. */
export interface CodeMode {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}

/** Whether a property opens on its code type: one no kind or listed code type names. */
export function opensOnCode(property: Pick<ComponentProperty, 'type' | 'description'>): boolean {
  const codeChoice = CODE_TYPE_CHOICES.some((choice) => choice.type === property.type);
  return propertyKind(property) === 'code' && !codeChoice;
}

const CODE_PREFIX = 'code:';

export function PropertyType({ property, frontmatter, code, optionsHoldCode, onChange }: PropertyTypeProps) {
  const translate = useTranslate();
  const kind = propertyKind(property);
  const codeChoice = CODE_TYPE_CHOICES.some((choice) => choice.type === property.type);
  const optionsOwnToggle = optionsHoldCode;
  const [note, setNote] = useState('');
  const pick = (value: string): void => {
    setNote('');
    if (value.startsWith(CODE_PREFIX)) {
      const type = value.slice(CODE_PREFIX.length);
      onChange({ type, description: withTag(property.description, 'format', undefined), defaultValue: property.defaultValue }, 'at-once');
      return;
    }
    const chosen = KIND_CHOICES.find((choice) => choice.kind === value);
    if (chosen === undefined) {
      return;
    }
    if (chosen.kind === 'code') {
      code.setOpen(true);
      return;
    }
    if (chosen.kind === 'attributes') {
      setNote(translate('componentProps.type.attributesNote'));
      return;
    }
    const next = withKind(property, chosen.kind, frontmatter);
    const defaultValue = carriedDefault(property.defaultValue, chosen.kind, next.type);
    if (defaultValue === '' && property.defaultValue.trim() !== '') {
      setNote(translate('componentProps.type.defaultCleared', { kind: translate(chosen.label) }));
    }
    onChange({ ...next, defaultValue }, 'at-once');
  };
  return (
    <div className="property-type" role="group" aria-label={translate('componentProps.type.kind')}>
      <div className="property-type-heading">
        <span>{translate('componentProps.type.kind')}</span>
        {!optionsOwnToggle && <CodeTypeToggle open={code.open} onToggle={() => code.setOpen(!code.open)} />}
      </div>
      <Dropdown
        ariaLabel={translate('componentProps.type.kind')}
        value={kindValue(kind, property.type, { codeChoice })}
        options={kindOptions(property.type, kind, { codeChoice }, translate)}
        onChange={pick}
        livePreview={false}
        searchable
        searchPlaceholder={translate('componentProps.type.search')}
      />
      {note && <p className="property-help">{note}</p>}
      {/* The same code field the Settings panel's Property settings has (PropertySections.tsx). */}
      {!optionsOwnToggle && code.open && (
        <CodeTypeEditor
          type={property.type}
          placeholder=""
          onChange={(type) => onChange({ type, description: property.description, defaultValue: property.defaultValue }, 'typing')}
        />
      )}
    </div>
  );
}

function kindValue(kind: PropertyKind, type: string, listed: { readonly codeChoice: boolean }): string {
  return kind === 'code' && listed.codeChoice ? `${CODE_PREFIX}${type}` : kind;
}

function kindOptions(type: string, kind: PropertyKind, listed: { readonly codeChoice: boolean }, translate: Translator): readonly DropdownOption<string>[] {
  const advanced = translate(KIND_SECTION_LABELS.advanced);
  const kinds = KIND_CHOICES.map((choice): DropdownOption<string> => ({
    value: choice.kind,
    label: translate(choice.label),
    // The current kind shows what it is written as; the others what they write.
    hint: choice.kind === kind && choice.kind !== 'text' ? shortType(type) : isKnownMessageKey(choice.hint) ? translate(choice.hint) : choice.hint,
    group: translate(KIND_SECTION_LABELS[choice.section]),
    icon: KIND_ICONS[choice.kind],
    ...(choice.kind === 'attributes' ? { dim: true } : {}),
  }));
  const custom: readonly DropdownOption<string>[] =
    kind === 'code' && !listed.codeChoice
      ? [
          {
            value: 'code',
            label: translate('componentProps.type.codeType'),
            hint: shortType(type) || translate('componentProps.type.noType'),
            group: advanced,
            icon: <CodeIcon size={14} />,
          },
        ]
      : [];
  const codeTypes = CODE_TYPE_CHOICES.map((choice): DropdownOption<string> => ({
    value: `${CODE_PREFIX}${choice.type}`,
    label: choice.label,
    hint: choice.type === choice.label ? translate('componentProps.type.typescript') : choice.type,
    group: advanced,
    icon: <CodeIcon size={14} />,
  }));
  // The custom entry replaces "Code type…" so the dropdown shows the current type once.
  return [...kinds.filter((option) => custom.length === 0 || option.value !== 'code'), ...custom, ...codeTypes];
}

function shortType(type: string): string {
  const text = type.replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

const KIND_ICONS: Readonly<Record<PropertyKind, ReactNode>> = {
  text: <TextIcon size={14} />,
  number: <FieldNumberIcon size={14} />,
  switch: <FieldSwitchIcon size={14} />,
  choice: <ComponentPropertiesIcon size={14} />,
  link: <ElementLinkIcon size={14} />,
  image: <ElementImageIcon size={14} />,
  color: <DropletIcon size={14} />,
  date: <CalendarIcon size={14} />,
  list: <ElementListDefaultIcon size={14} />,
  group: <ElementDivIcon size={14} />,
  record: <BracesIcon size={14} />,
  attributes: <BracesIcon size={14} />,
  filter: <FilterIcon size={14} />,
  sort: <SortIcon size={14} />,
  curated: <CheckIcon size={14} />,
  code: <CodeIcon size={14} />,
};

/** The icon a property row shows for its kind. */
export function kindIcon(property: Pick<ComponentProperty, 'type' | 'description'>): ReactNode {
  return KIND_ICONS[propertyKind(property)];
}
