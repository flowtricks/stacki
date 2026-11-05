// The Kind picker: a designer chooses what a prop holds (Text, Number,
// Switch, Choice, Link, Image, List, Group…) and the panel writes the native
// type for it (propertyKinds.ts). TypeScript's own words sit under Advanced,
// and the "Code type" disclosure shows the exact type expression, editable,
// for anything the kinds do not describe.

import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
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
import { CODE_TYPE_CHOICES, KIND_CHOICES, carriedDefault, propertyKind, withKind, type PropertyKind } from './propertyKinds';
import { withTag } from './settingTags';
import { CodeTypeField } from '../props/propBindings';

/** What a kind pick changes on the property. */
export type KindChange = Pick<ComponentProperty, 'type' | 'description' | 'defaultValue'>;

interface PropertyTypeProps {
  readonly property: ComponentProperty;
  readonly frontmatter: string;
  readonly onChange: (change: KindChange) => void;
}

const CODE_PREFIX = 'code:';

export function PropertyType({ property, frontmatter, onChange }: PropertyTypeProps) {
  const kind = propertyKind(property);
  const codeChoice = CODE_TYPE_CHOICES.some((choice) => choice.type === property.type);
  // A type no kind or listed code type names opens with its expression shown.
  const [codeOpen, setCodeOpen] = useState(kind === 'code' && !codeChoice);
  const [note, setNote] = useState('');
  const pick = (value: string): void => {
    setNote('');
    if (value.startsWith(CODE_PREFIX)) {
      const type = value.slice(CODE_PREFIX.length);
      onChange({ type, description: withTag(property.description, 'format', undefined), defaultValue: property.defaultValue });
      return;
    }
    const chosen = KIND_CHOICES.find((choice) => choice.kind === value);
    if (chosen === undefined) {
      return;
    }
    if (chosen.kind === 'code') {
      setCodeOpen(true);
      return;
    }
    if (chosen.kind === 'attributes') {
      setNote('An Attributes property is made from an element: open the bind dot on its Attributes.');
      return;
    }
    const next = withKind(property, chosen.kind, frontmatter);
    const defaultValue = carriedDefault(property.defaultValue, chosen.kind, next.type);
    if (defaultValue === '' && property.defaultValue.trim() !== '') {
      setNote(`The default was cleared: it is not a ${chosen.label}.`);
    }
    onChange({ ...next, defaultValue });
  };
  return (
    <div className="property-type" role="group" aria-label="Kind">
      <div className="property-type-heading">
        <span>Kind</span>
      </div>
      <Dropdown
        ariaLabel="Kind"
        value={kindValue(kind, property.type, { codeChoice })}
        options={kindOptions(property.type, kind, { codeChoice })}
        onChange={pick}
        livePreview={false}
        searchable
        searchPlaceholder="Search kinds…"
      />
      {note && <p className="property-help">{note}</p>}
      {/* The same Code type the Settings panel's Property settings has (PropertySections.tsx). */}
      <CodeTypeField
        type={property.type}
        placeholder=""
        open={codeOpen}
        onToggle={() => setCodeOpen(!codeOpen)}
        onChange={(type) => onChange({ type, description: property.description, defaultValue: property.defaultValue })}
      />
    </div>
  );
}

function kindValue(kind: PropertyKind, type: string, listed: { readonly codeChoice: boolean }): string {
  return kind === 'code' && listed.codeChoice ? `${CODE_PREFIX}${type}` : kind;
}

function kindOptions(type: string, kind: PropertyKind, listed: { readonly codeChoice: boolean }): readonly DropdownOption<string>[] {
  const kinds = KIND_CHOICES.map((choice): DropdownOption<string> => ({
    value: choice.kind,
    label: choice.label,
    // The current kind shows what it is written as; the others what they write.
    hint: choice.kind === kind && choice.kind !== 'text' ? shortType(type) : choice.hint,
    group: choice.section,
    icon: KIND_ICONS[choice.kind],
    ...(choice.kind === 'attributes' ? { dim: true } : {}),
  }));
  const custom: readonly DropdownOption<string>[] =
    kind === 'code' && !listed.codeChoice
      ? [{ value: 'code', label: 'Code type', hint: shortType(type) || 'No type', group: 'Advanced', icon: <CodeIcon size={14} /> }]
      : [];
  const codeTypes = CODE_TYPE_CHOICES.map((choice): DropdownOption<string> => ({
    value: `${CODE_PREFIX}${choice.type}`,
    label: choice.label,
    hint: choice.type === choice.label ? 'TypeScript' : choice.type,
    group: 'Advanced',
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
