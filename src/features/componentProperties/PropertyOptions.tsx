import { useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { PROPERTY_LIMITS } from '../../../shared/properties/propertyEditing';
import type { PropertyOptionRename } from '../../../shared/properties/propertyEditing';
import { arrayItems, arrayText, moveItem } from '../props/arrayValue';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import ListField from '../props/ListField';
import type { ListFieldChange } from '../props/ListField';
import { CodeTypeEditor, CodeTypeToggle } from '../props/propBindings';
import type { CodeMode } from './PropertyType';

export type PropertyOptionChange =
  | {
      readonly kind: 'draft';
      readonly type: string;
      readonly rename: PropertyOptionRename | undefined;
    }
  | { readonly kind: 'reorder'; readonly type: string };
interface PropertyOptionsProps {
  readonly type: string;
  readonly disabled: boolean;
  /** The `{}` switch: on, the options' union is edited as code in the list's place. */
  readonly code: CodeMode;
  readonly onChange: (change: PropertyOptionChange) => void;
  /** A code edit of the union, which no option rename can follow. */
  readonly onTypeChange: (type: string) => void;
}

export function PropertyOptions({ type, disabled, code, onChange, onTypeChange }: PropertyOptionsProps) {
  // Retain the original scalar kind through intermediate edits such as '-' in a number.
  const scalarKind = useRef<'text' | 'literal'>();
  const options = literalOptions(type);
  if (code.open) {
    // While the code is edited the union may stop being options; the field stays where it was opened.
    return (
      <div className="property-options props-field">
        <div className="property-options-heading">
          <span>Options</span>
          <CodeTypeToggle open={code.open} onToggle={() => code.setOpen(!code.open)} />
        </div>
        <CodeTypeEditor type={type} placeholder="" onChange={onTypeChange} />
      </div>
    );
  }
  if (!options) {
    return undefined;
  }
  const value = arrayText(options.map((option) => ({ text: optionLabel(option), quote: '"' })));
  const change = (text: string, commit: 'immediate' | 'draft', listChange: ListFieldChange) => {
    if (disabled) {
      return;
    }
    if (listChange.kind === 'edit') {
      const original = options[listChange.index];
      assert(original !== undefined, 'Edited option exists');
      scalarKind.current ??= /^["']/.test(original) ? 'text' : 'literal';
    }
    const kind = scalarKind.current ?? 'text';
    const next = changePropertyOptionList(options, text, listChange, kind);
    if (commit === 'immediate') {
      scalarKind.current = undefined;
    }
    const nextType = next.options.join(' | ');
    onChange(listChange.kind === 'move' ? { kind: 'reorder', type: nextType } : { kind: 'draft', type: nextType, rename: next.rename });
  };
  return (
    <div className="property-options props-field">
      <div className="property-options-heading">
        <span>Options</span>
        <CodeTypeToggle open={code.open} onToggle={() => code.setOpen(!code.open)} />
      </div>
      <ListField
        value={value}
        onChange={(text, immediate, listChange) => change(text, immediate ? 'immediate' : 'draft', listChange)}
        disabled={disabled}
        itemsMin={1}
        itemsMax={PROPERTY_LIMITS.fieldsMax}
        valueCharsMax={PROPERTY_LIMITS.sourceCharsMax}
      />
    </div>
  );
}

function optionLabel(option: string): string {
  const item = arrayItems(`[${option}]`)?.[0];
  return item && !item.fields ? item.text : option;
}

function changePropertyOptionList(
  options: readonly string[],
  value: string,
  change: ListFieldChange,
  scalarKind: 'text' | 'literal',
): {
  readonly options: readonly string[];
  readonly rename?: PropertyOptionRename;
} {
  assert(options.length <= PROPERTY_LIMITS.fieldsMax, 'Option count is bounded');
  switch (change.kind) {
    case 'move':
      return { options: moveItem(options, change.index, change.gap) };
    case 'remove':
      return { options: options.filter((_, index) => index !== change.index) };
    case 'add': {
      const item = arrayItems(value)?.at(-1);
      assert(item !== undefined, 'Added option has a value');
      assert(item.fields === undefined, 'Options are scalar values');
      return { options: [...options, JSON.stringify(item.text)] };
    }
    case 'edit': {
      const original = options[change.index];
      const item = arrayItems(value)?.[change.index];
      assert(original !== undefined, 'Edited option has a source');
      assert(item !== undefined, 'Edited option has a value');
      assert(item.fields === undefined, 'Options are scalar values');
      const replacement = optionExpression(original, item.text, scalarKind);
      return {
        options: options.map((option, index) => (index === change.index ? replacement : option)),
        rename: { from: original, to: replacement },
      };
    }
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function optionExpression(original: string, text: string, scalarKind: 'text' | 'literal'): string {
  if (optionLabel(original) === text) {
    return original;
  }
  if (scalarKind === 'literal' && /^(?:-?\d+(?:\.\d+)?|true|false)$/.test(text.trim())) {
    return text.trim();
  }
  return JSON.stringify(text);
}
