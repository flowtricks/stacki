import { useState } from 'react';
import { PROPERTY_LIMITS } from '../../shared/component-properties';
import { literalOptions } from '../propertyOptions';
import Dropdown from '../ui/Dropdown';
import type { DropdownOption } from '../ui/Dropdown';
import {
  BracesIcon,
  CalendarIcon,
  CloseIcon,
  CodeIcon,
  ComponentPropertiesIcon,
  ElementListDefaultIcon,
  ElementSlotIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  HelpCircleIcon,
  HistoryIcon,
  MoreIcon,
  PointerEventsNoneIcon,
  SparkleIcon,
  TagIcon,
  TextIcon,
} from '../ui/Icons';

const UNION_TYPE = '"Option 1" | "Option 2"';
// These are authored type expressions, not types used to bypass the app's own checking.
const TYPE_CHOICES: readonly DropdownOption<string>[] = [
  { value: 'string', label: 'string', hint: 'Text / link', icon: <TextIcon size={14} /> },
  { value: 'number', label: 'number', icon: <FieldNumberIcon size={14} /> },
  { value: 'boolean', label: 'boolean', hint: 'Switch', icon: <FieldSwitchIcon size={14} /> },
  {
    value: UNION_TYPE,
    label: 'Options (union)',
    hint: 'Literal choices',
    icon: <ComponentPropertiesIcon size={14} />,
  },
  {
    value: 'readonly string[]',
    label: 'Array',
    hint: 'readonly string[]',
    icon: <ElementListDefaultIcon size={14} />,
  },
  {
    value: 'readonly [string, number]',
    label: 'Tuple',
    hint: 'readonly [string, number]',
    icon: <ElementListDefaultIcon size={14} />,
  },
  {
    value: 'Record<string, unknown>',
    label: 'Record',
    hint: 'Object / attributes',
    icon: <BracesIcon size={14} />,
  },
  { value: 'object', label: 'object', icon: <BracesIcon size={14} /> },
  {
    value: '(value: string) => void',
    label: 'Function',
    hint: 'Callback',
    icon: <CodeIcon size={14} />,
  },
  { value: 'Date', label: 'Date', icon: <CalendarIcon size={14} /> },
  {
    value: 'Promise<string>',
    label: 'Promise',
    hint: 'Promise<string>',
    icon: <HistoryIcon size={14} />,
  },
  { value: 'bigint', label: 'bigint', icon: <FieldNumberIcon size={14} /> },
  { value: 'symbol', label: 'symbol', icon: <TagIcon size={14} /> },
  { value: 'null', label: 'null', icon: <CloseIcon size={14} /> },
  { value: 'undefined', label: 'undefined', icon: <MoreIcon size={14} /> },
  { value: 'unknown', label: 'unknown', icon: <HelpCircleIcon size={14} /> },
  { value: 'never', label: 'never', icon: <PointerEventsNoneIcon size={14} /> },
  { value: 'void', label: 'void', icon: <ElementSlotIcon size={14} /> },
  { value: 'any', label: 'any', hint: 'Unchecked value', icon: <SparkleIcon size={14} /> },
];

export function PropertyType({
  type,
  onChange,
}: {
  readonly type: string;
  readonly onChange: (type: string) => void;
}) {
  const supported =
    TYPE_CHOICES.some((option) => option.value === type) || literalOptions(type) !== undefined;
  const [mode, setMode] = useState<'dropdown' | 'expression'>(
    supported ? 'dropdown' : 'expression'
  );
  const expression = mode === 'expression';
  const action = expression ? 'Use the type dropdown' : 'Write a type expression';
  return (
    <div className="property-type" role="group" aria-label="Type expression">
      <div className="property-type-heading">
        <span>Type expression</span>
        <button
          type="button"
          className={`prop-expr-toggle${expression ? ' on' : ''}`}
          aria-label={action}
          title={action}
          aria-pressed={expression}
          onClick={() => setMode(expression ? 'dropdown' : 'expression')}
        >
          <BracesIcon size={12} />
        </button>
      </div>
      {expression ? (
        <input
          aria-label="Type expression"
          className="property-code"
          value={type}
          maxLength={PROPERTY_LIMITS.textCharsMax}
          spellCheck={false}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Dropdown
          value={type}
          options={propertyTypeChoices(type)}
          onChange={onChange}
          livePreview={false}
          searchable
          searchPlaceholder="Search types…"
        />
      )}
    </div>
  );
}

function propertyTypeChoices(type: string): readonly DropdownOption<string>[] {
  // Toggling modes must preserve custom expressions and existing union options.
  const choices = TYPE_CHOICES.map((option) =>
    option.value === UNION_TYPE && literalOptions(type) ? { ...option, value: type } : option
  );
  return choices.some((option) => option.value === type)
    ? choices
    : [
        {
          value: type,
          label: type || 'Choose a type',
          hint: 'Custom type',
          icon: <CodeIcon size={14} />,
        },
        ...choices,
      ];
}
