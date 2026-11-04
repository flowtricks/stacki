// The prop model (propModel.ts) projected onto the field schema the instance
// Settings panel, the palette and Studio have always read (PropField in
// propSchema.ts). It is the only way a schema field is made, so a field can
// only say what the model says. The shape of each field — which keys exist,
// and which are present but undefined — is the one the retired regex reader
// produced, so every consumer reads it as before; new facts arrive as new
// optional keys (`deprecated`, `usage`), never as renamed ones.

import { assert } from '../core/assert';
import type { CodeKind, PropDefault, PropShapeField, PropUnion } from './propSchema';
import type { ComponentPropModel, PropControl, PropModel, PropUsage } from './propModel';

/** The schema's own word for each kind of value a field takes. */
export type SchemaFieldType = 'enum' | 'attrs' | 'code' | 'string' | 'number' | 'boolean' | 'other';

/** One schema field, as made from the model. */
export interface ModelSchemaField {
  readonly name: string;
  readonly type: SchemaFieldType;
  readonly optional: boolean;
  readonly default: PropDefault | undefined;
  readonly defaultExpr?: boolean;
  readonly hint?: string;
  readonly options?: readonly string[] | undefined;
  readonly numeric?: boolean | undefined;
  readonly expressionOptions?: readonly string[];
  readonly codeKind?: CodeKind;
  readonly typeText?: string;
  readonly doc?: string | undefined;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly minExclusive?: boolean;
  readonly maxExclusive?: boolean;
  readonly shape?: readonly PropShapeField[];
  readonly shapeIsList?: boolean;
  readonly unions?: readonly PropUnion[] | undefined;
  // The `@deprecated` text ('' for the bare tag); absent when the prop is not deprecated.
  readonly deprecated?: string;
  // Present only when the component never reads the prop (the "Not used" tag, plan §7.4).
  readonly usage?: PropUsage;
}

/** The schema fields of a component's model, in the model's order. */
export function schemaFieldsOf(model: ComponentPropModel): ModelSchemaField[] {
  const fields = model.props.map((prop) => schemaFieldOf(prop, model.unions));
  assert(fields.length === model.props.length, 'schemaFieldsOf: one field per prop');
  assert(new Set(fields.map((field) => field.name)).size === fields.length, 'schemaFieldsOf: field names stay unique');
  return fields;
}

/** The schema type and code kind a control is shown as. */
export function schemaTypeOf(control: PropControl): { readonly type: SchemaFieldType; readonly codeKind: CodeKind | undefined } {
  switch (control.kind) {
    case 'text':
      return { type: 'string', codeKind: undefined };
    case 'number':
      return { type: 'number', codeKind: undefined };
    case 'switch':
      return { type: 'boolean', codeKind: undefined };
    case 'choice':
      return { type: 'enum', codeKind: undefined };
    case 'attributes':
      return { type: 'attrs', codeKind: undefined };
    case 'list':
      return { type: 'code', codeKind: undefined };
    case 'group':
      return { type: 'code', codeKind: 'object' };
    case 'callback':
      return { type: 'other', codeKind: 'function' };
    case 'code':
      switch (control.reason) {
        case 'opaque':
          return { type: 'other', codeKind: 'opaque' };
        case 'tuple':
          return { type: 'code', codeKind: undefined };
        case 'nestingDepth':
          return { type: 'code', codeKind: 'object' };
        case 'untyped':
        case 'unrecognized':
          return { type: 'other', codeKind: undefined };
        default: {
          const exhaustive: never = control.reason;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = control;
      return exhaustive;
    }
  }
}

// The longest type text a schema carries for the code row; longer text is cut.
const TYPE_TEXT_CHARS_MAX = 512;

/** A type's text as the panel shows it beside a value set in code: one line, bounded. */
export function shownTypeText(typeText: string): string {
  const flat = typeText.replace(/\s+/g, ' ').trim();
  const shown = flat.length <= TYPE_TEXT_CHARS_MAX ? flat : `${flat.slice(0, TYPE_TEXT_CHARS_MAX - 1)}…`;
  assert(shown.length <= TYPE_TEXT_CHARS_MAX, 'shownTypeText: bounded');
  return shown;
}

function schemaFieldOf(prop: PropModel, unions: readonly PropUnion[]): ModelSchemaField {
  const { type, codeKind } = schemaTypeOf(prop.control);
  const base = prop.declared ? declaredField(prop, type, codeKind, unions) : undeclaredField(prop, type, codeKind);
  const fallback = prop.fallback;
  const withFallback: ModelSchemaField = (() => {
    switch (fallback.kind) {
      case 'none':
        return base;
      case 'literal':
        // A destructure default makes the prop one a page may leave out.
        return fallback.source === 'destructure' ? { ...base, optional: true, default: fallback.value } : { ...base, default: fallback.value };
      case 'expression':
        return { ...base, optional: true, default: fallback.code, defaultExpr: true };
      case 'hint':
        return { ...base, hint: fallback.hint };
      default: {
        const exhaustive: never = fallback;
        return exhaustive;
      }
    }
  })();
  const deprecated = prop.deprecated === undefined ? withFallback : { ...withFallback, deprecated: prop.deprecated };
  const field = prop.usage === 'unread' ? { ...deprecated, usage: prop.usage } : deprecated;
  assert(field.name === prop.name, 'schemaFieldOf: the field is the prop');
  return field;
}

function declaredField(prop: PropModel, type: SchemaFieldType, codeKind: CodeKind | undefined, unions: readonly PropUnion[]): ModelSchemaField {
  const control = prop.control;
  const choice = control.kind === 'choice' ? control : undefined;
  const written =
    choice === undefined || choice.numeric ? [] : choice.options.filter((option) => option.written === 'expression').map((option) => option.value);
  const shape = shapeOf(control);
  // A value only code can give carries its type, so the panel can say what it
  // takes — when the type says so; a kind read from a default has no type to show.
  const typed = prop.recognition.source === 'type' && codeKind !== undefined;
  return {
    name: prop.name,
    type,
    options: choice?.options.map((option) => option.value),
    numeric: choice?.numeric === true ? true : undefined,
    ...(written.length > 0 ? { expressionOptions: written } : {}),
    ...(codeKind === undefined ? {} : typed ? { codeKind, typeText: shownTypeText(prop.typeText) } : { codeKind }),
    optional: prop.presence === 'optional',
    ...(shape === undefined ? {} : { shape: shape.fields, shapeIsList: shape.list }),
    default: undefined,
    doc: prop.documentation === '' ? undefined : prop.documentation,
    ...(control.kind === 'number' ? numberKeys(control) : {}),
    // The union shapes this component declares, so the panel can show only the
    // branch that matches what's set. The same table on every field: it
    // describes the type, not the prop.
    unions: unions.length > 0 ? unions : undefined,
  };
}

function undeclaredField(prop: PropModel, type: SchemaFieldType, codeKind: CodeKind | undefined): ModelSchemaField {
  assert(prop.presence === 'optional', 'undeclaredField: nothing declares an undeclared prop required');
  const field: ModelSchemaField = { name: prop.name, type, optional: true, default: undefined };
  return codeKind === undefined ? field : { ...field, codeKind };
}

function numberKeys(control: Extract<PropControl, { kind: 'number' }>): Pick<ModelSchemaField, 'min' | 'max' | 'step' | 'minExclusive' | 'maxExclusive'> {
  return {
    ...(control.min === undefined ? {} : { min: control.min }),
    ...(control.max === undefined ? {} : { max: control.max }),
    ...(control.step === undefined ? {} : { step: control.step }),
    ...(control.minExclusive ? { minExclusive: true } : {}),
    ...(control.maxExclusive ? { maxExclusive: true } : {}),
  };
}

// What one of these is made of, when the type says: the fields of an object,
// or of each item of a list of objects (`list` tells `ServiceTime[]`, which a
// loop over it hands one of, from a plain object).
function shapeOf(control: PropControl): { readonly fields: readonly PropShapeField[]; readonly list: boolean } | undefined {
  const group = control.kind === 'group' ? control : control.kind === 'list' && control.item.kind === 'group' ? control.item : undefined;
  if (group === undefined || group.fields.length === 0) {
    return undefined;
  }
  return { fields: group.fields.map((field) => ({ name: field.name, type: schemaTypeOf(field.control).type })), list: control.kind === 'list' };
}
