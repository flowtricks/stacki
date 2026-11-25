// Union rules are pure so switching variants can be checked without mounting a panel.
// Branch consequences never restrict the discriminator that can remove them.
import type { Attr } from '../../../shared/page/pageNode';
import type { ComputedDefault, PropField, PropUnion, UnionBranch } from '../../../shared/properties/propSchema';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { evaluateConditionalValue, readValueExpression, type Evaluated, type EvaluatedEntry } from '../../editor/conditionalValue';
import { plainTextOf } from './propLiteral';

export type FieldDefinition = Omit<PropField, 'optional'> & { readonly optional?: boolean };
export type PropValues = Readonly<Record<string, Attr | undefined>>;
interface RuleContext {
  readonly schema: readonly FieldDefinition[];
  readonly props: PropValues;
  readonly unions: readonly PropUnion[];
}
interface FittingUnion {
  readonly union: PropUnion;
  readonly branches: readonly UnionBranch[];
}
interface CascadeInput {
  readonly fieldName: string;
  readonly value: Attr | undefined;
  readonly stash: PropValues;
}

export function createPropRules(schema: readonly FieldDefinition[], props: PropValues) {
  assert(schema.length <= LIMITS.propSchemaFieldsMax, 'Prop rules: schema limit exceeded');
  assert(Object.keys(props).length <= LIMITS.attrsPerNodeMax, 'Prop rules: prop limit exceeded');
  const context: RuleContext = {
    schema,
    props,
    unions: schema.find((field) => field.unions)?.unions || [],
  };
  assert(context.unions.length <= LIMITS.propOptionsMax, 'Prop rules: union limit exceeded');
  const fitting = branchesFitting(context, undefined);
  return {
    appliesNow: (field: FieldDefinition) =>
      fitting.every(({ union, branches }) => !union.names.includes(field.name) || !branches.every((branch) => branch.forbids.includes(field.name))),
    branchDefault: (name: string) => branchDefault(context, fitting, name),
    narrowOptions: (field: FieldDefinition) => narrowOptions(context, field),
    cascade: (input: CascadeInput) => cascade(context, input),
  };
}

function effective(context: RuleContext, name: string): string | undefined {
  const value = context.props[name];
  if (value) {
    return value.type === 'bare' ? 'true' : value.value;
  }
  const fallback = context.schema.find((field) => field.name === name)?.default;
  return fallback === undefined ? undefined : String(fallback);
}

function pinsMatch(context: RuleContext, branch: UnionBranch, ignore: string | undefined): boolean {
  for (const [name, wanted] of Object.entries(branch.pins)) {
    if (name === ignore) {
      continue;
    }
    const value = effective(context, name);
    if (value !== undefined) {
      if (!wanted.includes(value)) {
        return false;
      }
    }
  }
  return true;
}

function branchesFitting(context: RuleContext, ignore: string | undefined): readonly FittingUnion[] {
  return context.unions.map((union) => {
    assert(union.branches.length <= LIMITS.propOptionsMax, 'Prop rules: branch limit exceeded');
    assert(union.names.length <= LIMITS.propSchemaFieldsMax, 'Prop rules: name limit exceeded');
    const fits = union.branches.filter((branch) => {
      for (const name of branch.forbids) {
        if (name === ignore) {
          continue;
        }
        if (context.props[name] !== undefined) {
          return false;
        }
      }
      return pinsMatch(context, branch, ignore);
    });
    // Invalid existing markup must leave its repair controls reachable.
    return { union, branches: fits.length ? fits : union.branches };
  });
}

// The default an unset prop has for this instance. A default the component
// computes from other props (`label ?? named[variant]`) is the code that runs,
// so it is weighed for this instance's values and wins over what the union's
// doc comments promise; when only running the code could tell, there is no
// answer rather than a wrong one. Otherwise each fitting branch's doc decides.
function branchDefault(context: RuleContext, fitting: readonly FittingUnion[], name: string): string | number | undefined {
  const computed = context.schema.find((field) => field.name === name)?.computedDefault;
  if (computed !== undefined) {
    const value = evaluateComputed(context, computed, 0);
    if (value.kind !== 'value') {
      return undefined;
    }
    return typeof value.value === 'boolean' ? String(value.value) : value.value;
  }
  return unionDefault(fitting, context, name);
}

// Props whose computed defaults read one another's: deeper than this is a cycle, and has no answer.
const COMPUTED_DEPTH_MAX = 8;

function evaluateComputed(context: RuleContext, computed: ComputedDefault, depth: number): Evaluated {
  assert(depth >= 0, 'evaluateComputed: the depth counts defaults followed');
  assert(Object.keys(computed.locals).length <= LIMITS.propSchemaFieldsMax, 'evaluateComputed: the locals are bounded');
  if (depth > COMPUTED_DEPTH_MAX) {
    return { kind: 'unknown' };
  }
  const model = readValueExpression(computed.code);
  if (model === undefined) {
    return { kind: 'unknown' };
  }
  return evaluateConditionalValue(model, {
    name: (local) => {
      const prop = computed.locals[local];
      return prop === undefined ? { kind: 'unknown' } : heldValue(context, prop, depth);
    },
    entry: (table, option) => tableEntry(computed, table, option),
  });
}

// What one prop holds on this instance: the value it sets, else its own default.
function heldValue(context: RuleContext, prop: string, depth: number): Evaluated {
  const value = context.props[prop];
  if (value !== undefined) {
    return valueOfAttr(value);
  }
  const field = context.schema.find((candidate) => candidate.name === prop);
  if (field === undefined) {
    return { kind: 'unknown' };
  }
  if (field.computedDefault !== undefined) {
    return evaluateComputed(context, field.computedDefault, depth + 1);
  }
  if (field.default === undefined) {
    return { kind: 'absent' };
  }
  // An expression default the main process could not follow is code only the site can run.
  return field.defaultExpr === true ? { kind: 'unknown' } : { kind: 'value', value: field.default };
}

// An attribute as the component receives it: words, a switch that is on, or a literal in braces.
function valueOfAttr(value: Attr): Evaluated {
  switch (value.type) {
    case 'string':
      return { kind: 'value', value: value.value };
    case 'bare':
      return { kind: 'value', value: true };
    case 'spread':
      return { kind: 'unknown' };
    case 'expr': {
      const code = value.value.trim();
      if (code === 'undefined') {
        return { kind: 'absent' };
      }
      if (code === 'true' || code === 'false') {
        return { kind: 'value', value: code === 'true' };
      }
      if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(code)) {
        return { kind: 'value', value: Number(code) };
      }
      // `{"play"}` is the words; any other code in braces only the site can run.
      const text = plainTextOf(code);
      return text === undefined ? { kind: 'unknown' } : { kind: 'value', value: text };
    }
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

function tableEntry(computed: ComputedDefault, table: string, option: string): EvaluatedEntry {
  const entries = computed.tables[table];
  if (entries === undefined) {
    return { kind: 'unknown' };
  }
  // An own property only: `named["constructor"]` is not an entry the table declares.
  const code = Object.prototype.hasOwnProperty.call(entries, option) ? entries[option] : undefined;
  if (code === undefined) {
    return { kind: 'absent' };
  }
  const model = readValueExpression(code);
  return model === undefined ? { kind: 'unknown' } : { kind: 'model', model };
}

function unionDefault(fitting: readonly FittingUnion[], context: RuleContext, name: string): string | number | undefined {
  let found: string | number | undefined;
  for (const { union, branches } of fitting) {
    if (!union.names.includes(name)) {
      continue;
    }
    for (const branch of branches) {
      const rule = branch.rules[name];
      const value = rule ? (effective(context, rule.prop) === rule.is ? rule.then : rule.otherwise) : branch.defaults[name];
      if (value === undefined) {
        continue;
      }
      if (found !== undefined) {
        if (found !== value) {
          return undefined;
        }
      }
      found = value;
    }
  }
  return found;
}

function choosesBranch(union: PropUnion, name: string): boolean {
  const seen = new Set<string>();
  let pinning = 0;
  for (const branch of union.branches) {
    const pinned = branch.pins[name];
    if (!pinned) {
      continue;
    }
    pinning++;
    for (const value of pinned) {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
    }
  }
  return pinning > 1;
}

function narrowOptions(context: RuleContext, field: FieldDefinition): FieldDefinition {
  if (!field.options?.length) {
    return field;
  }
  const allowed = new Set<string>();
  let hasPins = false;
  for (const { union, branches } of branchesFitting(context, field.name)) {
    if (!union.names.includes(field.name)) {
      continue;
    }
    if (choosesBranch(union, field.name)) {
      continue;
    }
    for (const branch of branches) {
      const pinned = branch.pins[field.name];
      if (!pinned) {
        return field;
      }
      hasPins = true;
      for (const value of pinned) {
        allowed.add(value);
      }
    }
  }
  if (!hasPins) {
    return field;
  }
  const value = context.props[field.name];
  const keep = value && value.type !== 'expr' ? (value.type === 'bare' ? '' : value.value) : undefined;
  const options = field.options.filter((option) => allowed.has(option) || option === keep);
  if (options.length > 0) {
    if (options.length < field.options.length) {
      return { ...field, options };
    }
  }
  return field;
}

function cascadeSets(context: RuleContext, fieldName: string) {
  const forbidden = new Set<string>();
  const involved = new Set<string>();
  for (const union of context.unions) {
    if (!union.names.includes(fieldName)) {
      continue;
    }
    for (const name of union.names) {
      involved.add(name);
    }
    const pinsField = union.branches.some((branch) => Object.prototype.hasOwnProperty.call(branch.pins, fieldName));
    const fits = union.branches.filter((branch) => {
      if (!pinsField) {
        for (const name of branch.forbids) {
          if (context.props[name] !== undefined) {
            return false;
          }
        }
      }
      return pinsMatch(context, branch, undefined);
    });
    const live = fits.length ? fits : union.branches;
    for (const name of union.names) {
      if (name === fieldName) {
        continue;
      }
      if (live.every((branch) => branch.forbids.includes(name))) {
        forbidden.add(name);
      }
    }
  }
  return { forbidden, involved };
}

function cascade(context: RuleContext, { fieldName, value, stash: held }: CascadeInput): { readonly patch: PropValues; readonly stash: PropValues } {
  assert(Object.keys(held).length <= LIMITS.propSchemaFieldsMax, 'Prop rules: stash limit exceeded');
  assert(fieldName.length <= LIMITS.attrCharsMax, 'Prop rules: field name limit exceeded');
  const props = { ...context.props, [fieldName]: value };
  const { forbidden, involved } = cascadeSets({ ...context, props }, fieldName);
  // Local copies centralize mutation; callers cannot mutate a previous rules snapshot.
  const stash: Record<string, Attr | undefined> = { ...held };
  const patch: Record<string, Attr | undefined> = { [fieldName]: value };
  delete stash[fieldName];
  for (const name of forbidden) {
    const previous = context.props[name];
    if (previous === undefined) {
      continue;
    }
    stash[name] = previous;
    patch[name] = undefined;
  }
  for (const [name, previous] of Object.entries(stash)) {
    if (!involved.has(name)) {
      continue;
    }
    if (forbidden.has(name)) {
      continue;
    }
    if (context.props[name] !== undefined) {
      continue;
    }
    patch[name] = previous;
    delete stash[name];
  }
  assert(Object.keys(stash).length <= LIMITS.propSchemaFieldsMax, 'Prop rules: stash limit exceeded');
  assert(Object.keys(patch).length <= LIMITS.propSchemaFieldsMax, 'Prop rules: patch limit exceeded');
  return { patch, stash };
}
