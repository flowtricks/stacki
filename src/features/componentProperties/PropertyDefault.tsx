// The Default value of a prop: a control for its kind, the `{}` code switch,
// and, for a prop of words or options, the branch that sets it by conditions
// on other props in the Value conditions editor the attribute fields use
// (ConditionalDefaultField.tsx). A default the component computes per option
// from a lookup table (`label ?? named[variant]`) is shown and edited the same
// way and written back into that table; one computed by other code shows its
// code, read-only (docs/props-conditional-values.md).
import { useState } from 'react';
import type { ComponentProperty } from '../../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import type { VariantDefault, VariantDefaultEntry } from '../../../shared/properties/variantRules';
import type { ConditionalValue } from '../../editor/conditionalValue';
import { quoteOf } from '../../editor/conditionalValue';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown from '../../ui/Dropdown';
import { BracesIcon, BranchIcon } from '../../ui/Icons';
import {
  ComputedDefault,
  ConditionalDefaultField,
  ConditionalDefaultStart,
  ExpressionBindingField,
  conditionalOfDefault,
  defaultOfConditional,
  tableConditional,
  tableEntries,
  useDefaultConditionContext,
  type EditPace,
  type TableDefault,
} from '../props/propBindings';

/** What the Default value needs to set a default by conditions: the component's props, its computed defaults, and where a table edit goes. */
export interface DefaultConditions {
  readonly properties: readonly ComponentProperty[];
  readonly computed: VariantDefault | undefined;
  readonly onTable: (table: TableDefault, entries: readonly VariantDefaultEntry[]) => void;
  readonly onProblem: (message: string) => void;
}

interface DefaultProps {
  readonly property: ComponentProperty;
  readonly frontmatter: string;
  readonly onChange: (value: string, pace: EditPace) => void;
  /** Absent where conditions are not offered (a new prop, a list). */
  readonly conditions?: DefaultConditions | undefined;
}
export function PropertyDefault({ property, frontmatter, onChange, conditions }: DefaultProps) {
  const translate = useTranslate();
  const simple = ['string', 'number', 'boolean'].includes(property.type) || literalOptions(property.type) !== undefined;
  const [mode, setMode] = useState<'value' | 'expression'>(simple && isLiteralDefault(property) ? 'value' : 'expression');
  const [starting, setStarting] = useState(false);
  const context = useDefaultConditionContext(frontmatter, conditions?.properties ?? NO_PROPERTIES);
  const quote = quoteOf(frontmatter) ?? '"';
  const computed = conditions?.computed;
  const table = computed?.kind === 'table' ? computed : undefined;
  const tableModel = table === undefined ? undefined : tableConditional(table);
  const chain = table === undefined ? conditionalOfDefault(property.defaultValue) : undefined;
  // Conditions give words: a prop of text or of options can be set by them, a number or a switch cannot.
  const wordy = property.type.trim() === 'string' || literalOptions(property.type.trim()) !== undefined;
  const writeDefault = (model: ConditionalValue): void => onChange(defaultOfConditional(model, { quote }), 'at-once');
  const writeTable = (model: ConditionalValue): void => {
    if (conditions === undefined || table === undefined) {
      return;
    }
    const entries = tableEntries(model, table, { quote });
    if (entries.ok) {
      conditions.onTable(table, entries.value);
    } else {
      conditions.onProblem(translate('componentProps.defaults.perOption', { controller: table.controller }));
    }
  };
  if (conditions !== undefined && table !== undefined) {
    return (
      <div className="property-default" role="group" aria-label={translate('componentProps.default.value')}>
        <div className="property-default-title">
          <span>{translate('componentProps.default.value')}</span>
        </div>
        {tableModel === undefined ? (
          <ComputedDefault code={tableCode(table)} />
        ) : (
          <ConditionalDefaultField model={tableModel} context={context} quote={quote} onApply={writeTable} />
        )}
      </div>
    );
  }
  const expression = mode === 'expression';
  const action = expression ? translate('componentProps.default.useControl') : translate('componentProps.default.writeExpression');
  const branchLabel = translate('componentProps.defaults.conditional');
  return (
    <div className="property-default" role="group" aria-label={translate('componentProps.default.value')}>
      <div className="property-default-title">
        <span>{translate('componentProps.default.value')}</span>
        {conditions !== undefined && wordy && chain === undefined && (
          <button
            type="button"
            className={`prop-expr-toggle${starting ? ' on' : ''}`}
            title={branchLabel}
            aria-label={branchLabel}
            aria-pressed={starting}
            onClick={() => setStarting(true)}
          >
            <BranchIcon size={12} />
          </button>
        )}
        {simple && chain === undefined && (
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
      {starting && chain === undefined && conditions !== undefined && (
        <ConditionalDefaultStart
          defaultResult={defaultAttrOf(property.defaultValue)}
          context={context}
          onApply={writeDefault}
          onClose={() => setStarting(false)}
        />
      )}
      {chain !== undefined && conditions !== undefined ? (
        <ConditionalDefaultField model={chain} context={context} quote={quote} onApply={writeDefault} />
      ) : mode === 'value' && simple ? (
        <DefaultControl property={property} frontmatter={frontmatter} onChange={onChange} />
      ) : (
        <ExpressionBindingField
          value={property.defaultValue}
          bindContext={{ frontmatter }}
          placeholder={'"Hello", 42, true, [], {…}'}
          onChange={(value) => {
            if (value.length <= PROPERTY_LIMITS.textCharsMax) {
              onChange(value, 'typing');
            }
          }}
        />
      )}
      {computed?.kind === 'computed' && <ComputedDefault code={`${property.name} ?? ${computed.code}`} />}
    </div>
  );
}

const NO_PROPERTIES: readonly ComponentProperty[] = [];

// A plain default as the attribute a branch's Else starts from: words, or code.
function defaultAttrOf(
  defaultValue: string,
): { readonly type: 'string'; readonly value: string } | { readonly type: 'expr'; readonly value: string } | undefined {
  const code = defaultValue.trim();
  if (code === '') {
    return undefined;
  }
  const words = propertyDefaultText(code);
  return words === undefined ? { type: 'expr', value: code } : { type: 'string', value: words };
}

// A table that holds code the conditions cannot show, as its lines.
function tableCode(table: TableDefault): string {
  return table.entries.map((entry) => `${entry.option}: ${entry.code}`).join('\n');
}

function DefaultControl({ property, onChange }: DefaultProps) {
  const translate = useTranslate();
  const options = literalOptions(property.type);
  if (options || property.type === 'boolean') {
    const choices = [...new Set(options ?? ['true', 'false'])];
    return (
      <Dropdown
        value={defaultChoice(choices, property.defaultValue)}
        options={[
          { value: '', label: translate('componentProps.default.none') },
          ...choices.map((choice) => ({
            value: choice,
            label: propertyDefaultText(choice) ?? choice,
          })),
        ]}
        onChange={(value) => onChange(value, 'at-once')}
        livePreview={false}
        searchable
        searchPlaceholder={translate('componentProps.default.search')}
      />
    );
  }
  if (property.type === 'number') {
    return (
      <input
        aria-label={translate('componentProps.default.number')}
        type="number"
        step="any"
        value={Number.isFinite(Number(property.defaultValue)) ? property.defaultValue : ''}
        onChange={(event) => onChange(event.target.value, 'typing')}
      />
    );
  }
  return (
    <input
      aria-label={translate('componentProps.default.text')}
      value={propertyDefaultText(property.defaultValue) ?? ''}
      maxLength={PROPERTY_LIMITS.textCharsMax - 2}
      onChange={(event) => onChange(JSON.stringify(event.target.value), 'typing')}
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
      (choice) => choice === expression || (propertyDefaultText(choice) !== undefined && propertyDefaultText(choice) === propertyDefaultText(expression)),
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
