import { useState } from 'react';
import type { ComponentProperty } from '../../shared/component-properties';
import { PROPERTY_LIMITS } from '../../shared/component-properties';
import { literalOptions } from '../propertyOptions';
import Dropdown from '../ui/Dropdown';
import { BracesIcon } from '../ui/Icons';
import { ExpressionBindingField } from './propBindings';

interface DefaultProps {
  readonly property: ComponentProperty;
  readonly frontmatter: string;
  readonly onChange: (value: string) => void;
}
export function PropertyDefault({ property, frontmatter, onChange }: DefaultProps) {
  const simple =
    ['string', 'number', 'boolean'].includes(property.type) ||
    literalOptions(property.type) !== undefined;
  const [mode, setMode] = useState<'value' | 'expression'>(
    simple && isLiteralDefault(property) ? 'value' : 'expression'
  );
  const expression = mode === 'expression';
  const action = expression ? 'Use the default value control' : 'Write a default expression';
  return (
    <div className="property-default" role="group" aria-label="Default value">
      <div className="property-default-title">
        <span>Default value</span>
        {simple && (
          <button
            type="button"
            className={`prop-expr-toggle${expression ? ' on' : ''}`}
            title={action}
            aria-label={action}
            aria-pressed={expression}
            onClick={() => setMode((current) => (current === 'value' ? 'expression' : 'value'))}
          >
            <BracesIcon size={12} />
          </button>
        )}
      </div>
      {mode === 'value' && simple ? (
        <DefaultControl property={property} frontmatter={frontmatter} onChange={onChange} />
      ) : (
        <ExpressionBindingField
          value={property.defaultValue}
          bindCtx={{ frontmatter }}
          placeholder={'"Hello", 42, true, [], {…}'}
          onChange={(value) => {
            if (value.length <= PROPERTY_LIMITS.textCharsMax) {
              onChange(value);
            }
          }}
        />
      )}
    </div>
  );
}
function DefaultControl({ property, onChange }: DefaultProps) {
  const options = literalOptions(property.type);
  if (options || property.type === 'boolean') {
    const choices = [...new Set(options ?? ['true', 'false'])];
    return (
      <Dropdown
        value={defaultChoice(choices, property.defaultValue)}
        options={[
          { value: '', label: 'No default' },
          ...choices.map((choice) => ({
            value: choice,
            label: propertyDefaultText(choice) ?? choice,
          })),
        ]}
        onChange={onChange}
        livePreview={false}
        searchable
        searchPlaceholder="Search defaults…"
      />
    );
  }
  if (property.type === 'number') {
    return (
      <input
        aria-label="Default number"
        type="number"
        step="any"
        value={Number.isFinite(Number(property.defaultValue)) ? property.defaultValue : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  return (
    <input
      aria-label="Default text"
      value={propertyDefaultText(property.defaultValue) ?? ''}
      maxLength={PROPERTY_LIMITS.textCharsMax - 2}
      onChange={(event) => onChange(JSON.stringify(event.target.value))}
    />
  );
}
export function propertyDefaultText(expression: string): string | undefined {
  if (!expression) {
    return '';
  }
  // Unescaped single quotes are common in Astro defaults; complex escapes use the code control.
  if (/^'[^'\\]*'$/.test(expression)) {
    return expression.slice(1, -1);
  }
  try {
    const value: unknown = JSON.parse(expression);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
function defaultChoice(choices: readonly string[], expression: string): string {
  return (
    choices.find(
      (choice) =>
        choice === expression ||
        (propertyDefaultText(choice) !== undefined &&
          propertyDefaultText(choice) === propertyDefaultText(expression))
    ) ?? ''
  );
}
function isLiteralDefault(property: ComponentProperty): boolean {
  if (!property.defaultValue) {
    return true;
  }
  const options = literalOptions(property.type);
  if (options) {
    return defaultChoice(options, property.defaultValue) !== '';
  }
  switch (property.type) {
    case 'string':
      return propertyDefaultText(property.defaultValue) !== undefined;
    case 'number':
      return Number.isFinite(Number(property.defaultValue));
    case 'boolean':
      return ['true', 'false'].includes(property.defaultValue);
    default:
      return false;
  }
}
