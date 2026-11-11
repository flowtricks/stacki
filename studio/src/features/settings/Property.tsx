import Popup from '../../../vendor/stacki/src/ui/Popup';
import Dropdown, { type DropdownOption } from '../../../vendor/stacki/src/ui/Dropdown';
import { useState } from 'react';
import JSON5 from 'json5';
import { ValueFields } from '../../shared/ui/ValueFields';
import type { PropField } from '../../../vendor/stacki/shared/properties/propSchema';

interface PropertyProps {
  readonly field: PropField;
  readonly value?: string | undefined;
  readonly expression: boolean;
  readonly applies: boolean;
  readonly options?: readonly string[] | undefined;
  readonly fallback?: string | number | boolean | undefined;
  readonly classes: string[];
  readonly change: (value: string | undefined, expression: boolean) => void;
}
export function Property({ field, value, expression, applies, options, fallback, classes, change }: PropertyProps) {
  const [mode, setMode] = useState(expression && !field.shape && !['boolean', 'number'].includes(field.type));
  let literal: unknown;
  let literalError = '';
  if (field.shape) {
    try {
      literal = JSON5.parse(value ?? (field.shapeIsList ? '[]' : '{}'));
    } catch {
      literalError = 'This value uses an expression. Switch to {} to edit its source.';
    }
  }
  const template = Object.fromEntries((field.shape ?? []).map((item) => [item.name, item.type === 'number' ? 0 : item.type === 'boolean' ? false : '']));
  const [suggest, setSuggest] = useState(false);
  const shown = value === undefined ? '' : mode ? value : decode(value);
  const last = shown.split(/\s+/).at(-1) ?? '';
  return (
    <div className={`studio-field ${!applies ? 'inapplicable' : ''}`} title={field.doc}>
      <PropertyLabel field={field} mode={mode} setMode={setMode} change={change} />
      <PropertyControl
        field={field}
        mode={mode}
        literalError={literalError}
        value={value}
        template={template}
        literal={literal}
        shown={shown}
        options={options}
        fallback={fallback}
        setSuggest={setSuggest}
        change={change}
      />
      {field.name === 'class' && suggest && !mode && (
        <ClassSuggestions onClose={() => setSuggest(false)} classes={classes} shown={shown} last={last} change={change} />
      )}
      {!applies && <small>Not used by this variant</small>}
    </div>
  );
}

function PropertyLabel({ field, mode, setMode, change }: Pick<PropertyProps, 'field' | 'change'> & { mode: boolean; setMode: (value: boolean) => void }) {
  return (
    <span className="field-label">
      {field.name}
      <span className="field-tools">
        <button type="button" title="Reset to default" aria-label={`Reset ${field.name}`} onClick={() => change(undefined, mode)}>
          ↺
        </button>
        <button
          type="button"
          title="JavaScript expression"
          aria-label={`Expression ${field.name}`}
          className={mode ? 'active' : ''}
          onClick={() => setMode(!mode)}
        >
          {'{}'}
        </button>
      </span>
    </span>
  );
}
interface ControlProps extends PropertyProps {
  readonly mode: boolean;
  readonly literalError: string;
  readonly literal: unknown;
  readonly template: Record<string, unknown>;
  readonly shown: string;
  readonly setSuggest: (value: boolean) => void;
}
function PropertyControl({
  field,
  mode,
  literalError,
  value,
  template,
  literal,
  shown,
  options,
  fallback,
  setSuggest,
  change,
}: Omit<ControlProps, 'expression' | 'applies' | 'classes'>) {
  return !mode && field.shape ? (
    literalError ? (
      <small>{literalError}</small>
    ) : (
      <ValueFields
        label={field.name}
        value={value === undefined && !field.shapeIsList ? template : literal}
        template={template}
        change={(value) => change(JSON.stringify(value), true)}
      />
    )
  ) : !mode && field.type === 'boolean' ? (
    <Dropdown
      ariaLabel={field.name}
      value={value ?? ''}
      options={[defaultOption(fallback), { value: 'true', label: 'True' }, { value: 'false', label: 'False' }]}
      livePreview={false}
      onChange={(next) => change(next || undefined, true)}
    />
  ) : !mode && options?.length ? (
    <Dropdown
      ariaLabel={field.name}
      value={shown}
      options={[defaultOption(fallback), ...options.map((option) => ({ value: option, label: option }))]}
      livePreview={false}
      onChange={(next) => change(next || undefined, !!field.numeric)}
    />
  ) : (
    <input
      aria-label={field.name}
      type={!mode && field.type === 'number' ? 'number' : 'text'}
      min={field.min}
      max={field.max}
      step={field.step ?? 'any'}
      value={shown}
      placeholder={fallback === undefined ? (field.hint ?? 'Not set') : String(fallback)}
      onFocus={() => setSuggest(true)}
      onBlur={() => setTimeout(() => setSuggest(false), 150)}
      onChange={(event) => change(event.target.value, mode || field.type === 'number')}
    />
  );
}
function ClassSuggestions({
  onClose,
  classes,
  shown,
  last,
  change,
}: Pick<PropertyProps, 'classes' | 'change'> & {
  shown: string;
  last: string;
  readonly onClose: () => void;
}) {
  return (
    <Popup mode="popover" portal={false} className="class-suggestions" onClose={onClose}>
      {classes
        .filter((name) => name.includes(last) && !shown.split(/\s+/).includes(name))
        .slice(0, 12)
        .map((name) => (
          <button
            type="button"
            key={name}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              change(shown.slice(0, shown.length - last.length) + name + ' ', false);
            }}
          >
            {name}
          </button>
        ))}
    </Popup>
  );
}
function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#123;/g, '{')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// The empty value leaves the property unset, so the component's own default applies.
function defaultOption(fallback: PropertyProps['fallback']): DropdownOption {
  return { value: '', label: `Default${fallback !== undefined ? ` (${fallback})` : ''}`, dim: true };
}
