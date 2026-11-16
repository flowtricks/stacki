import { readPropertyOrigins } from './propertyOrigins';
import { readPropertyContracts } from './propertyContracts';
import type { PropertyContracts } from './propertyContracts';
import type { PropertyOrigins } from './propertyOrigins';
import type { ModelSchemaField } from '../../shared/properties/propModelSchema';
import { schemaFieldsOf } from '../../shared/properties/propModelSchema';
import { readPropModel } from '../parse/propModel/readPropModel';
import { createPropertyTypeReader, optionAliasOf, optionAliasWarning } from './propertyTypes';
import { literalOptions } from '../../shared/properties/propertyOptions';
import { bindComponentDefault, renamePropertyLocal } from './propertyRename';
import type { PropertyRename } from './propertyRename';
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { indentUnitOf, withIndentUnit } from '../../shared/core/indent';
import type { ComponentProperties, ComponentProperty, PropertyChange, PropertyEditing } from '../../shared/properties/propertyEditing';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import { refusal } from '../../shared/properties/propertyErrors';
import { err, ok, type Result } from '../../shared/core/result';
import {
  applySourceEdits,
  defaultExpression,
  isAstroProps,
  propertyKey,
  propertyNameText,
  readPropertySyntax,
  replaceFrontmatter,
  syntaxError,
  syntaxNodes,
  validatePropertyCode,
} from './propertySyntax';
import type { PropertySyntax, SourceEdit } from './propertySyntax';
import { editVariantRules } from './variantRuleEdits';
import { readVariantSyntax, variantGroupsOf } from './variantRuleModel';
import { bindingEdits, memberComment, memberEdits, sameDeclaration, sameProperty } from './propertyMemberEdits';
import type { DeclaredFields } from './propertyMemberEdits';
import { declareInHost } from './propertyHosts';

interface Definitions {
  readonly document: PropertySyntax;
  readonly readType: (type: ts.TypeNode) => string;
  readonly members: readonly ts.PropertySignature[];
  readonly bindings: readonly ts.BindingElement[];
  readonly patterns: readonly ts.ObjectBindingPattern[];
  readonly container: ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined;
  readonly advanced: boolean;
  /** The edited prop's other declarations (variants, intersected types, the runtime type), written with the first. */
  readonly others: readonly ts.PropertySignature[];
}

export function readComponentProperties(source: string): ComponentProperties {
  const definitions = readDefinitions(source);
  const origins = readPropertyOrigins(definitions.document);
  const fields = readDefinitionFields(definitions);
  const contracts = readPropertyContracts(definitions.document);
  return {
    source,
    properties: [...fields.values()].map((property) => sourcedProperty(property, definitions, origins, contracts)),
    frontmatter: definitions.document.frontmatter,
    advanced: definitions.advanced,
    variantGroups: variantGroupsOf(readVariantSyntax(definitions.document)),
  };
}

function readDefinitionFields(definitions: Definitions): ReadonlyMap<string, ComponentProperty> {
  const fields = new Map<string, ComponentProperty>();
  const names = new Set([
    ...definitions.members.map((member) => propertyKey(member.name)),
    ...definitions.bindings.map((binding) => propertyKey(binding.propertyName ?? binding.name)),
  ]);
  // The list starts from the prop model, the reader every panel shares, so a
  // prop the instance panel offers is one this panel lists. A simple
  // component's own members and bindings are what it edits; a prop the code
  // only reads (`Astro.props.label`, with no type and no destructure) is
  // listed too, so it can be given a type or a default here.
  const model = readPropModel(definitions.document.source);
  for (const field of schemaFieldsOf(model)) {
    const prop = model.props.find((entry) => entry.name === field.name);
    assert(prop !== undefined, 'Every schema field has its prop');
    if (!definitions.advanced && !names.has(field.name) && prop.declared) {
      continue;
    }
    fields.set(field.name, {
      name: field.name,
      type: schemaPropertyType(field),
      required: !field.optional,
      readonly: false,
      defaultValue: '',
      description: field.doc ?? '',
    });
  }
  for (const member of definitions.members) {
    const name = propertyKey(member.name);
    if (!name) {
      continue;
    }
    fields.set(name, {
      name,
      type: member.type ? definitions.readType(member.type) : 'unknown',
      required: member.questionToken === undefined,
      readonly: member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
      defaultValue: '',
      description: readDescription(member, definitions.document.frontmatter),
    });
  }
  for (const binding of definitions.bindings) {
    const name = propertyKey(binding.propertyName ?? binding.name);
    if (!name) {
      continue;
    }
    const previous = fields.get(name);
    fields.set(name, {
      name,
      type: previous?.type ?? 'unknown',
      required: previous?.required ?? false,
      readonly: previous?.readonly ?? false,
      description: previous?.description ?? '',
      defaultValue: binding.initializer?.getText() ?? '',
    });
  }
  const merged = propsObjectDeclaration(definitions.document.syntax)?.initializer;
  if (merged !== undefined && ts.isObjectLiteralExpression(merged)) {
    for (const item of merged.properties) {
      const key = ts.isPropertyAssignment(item) ? propertyKey(item.name) : undefined;
      const field = key === undefined ? undefined : fields.get(key);
      if (key !== undefined && field !== undefined && ts.isPropertyAssignment(item) && field.defaultValue === '') {
        fields.set(key, { ...field, defaultValue: item.initializer.getText() });
      }
    }
  }
  assert(fields.size <= PROPERTY_LIMITS.fieldsMax, 'Component field count is bounded');
  assert(new Set(fields.keys()).size === fields.size, 'Component property names are unique');
  return fields;
}

function schemaPropertyType(field: ModelSchemaField): string {
  if (field.type === 'enum' && field.options?.length) {
    return field.options.map((value) => (field.numeric ? value : JSON.stringify(value))).join(' | ');
  }
  return ['enum', 'other', 'code', 'attrs', 'slot', 'style'].includes(field.type) ? 'unknown' : field.type || 'unknown';
}

function sourcedProperty(property: ComponentProperty, definitions: Definitions, origins: PropertyOrigins, contracts: PropertyContracts): ComponentProperty {
  const binding = definitions.bindings.find((item) => propertyKey(item.propertyName ?? item.name) === property.name);
  const conditions = contracts.conditions(property.name);
  // The declarations that trace the prop; one only the contracts reach (a cast to an imported type) speaks when the trace finds none.
  const traced = origins.members.get(property.name) ?? [];
  const types = (traced.length > 0 ? traced : (contracts.declared.get(property.name) ?? []))
    .flatMap((member) => (member.type ? [definitions.readType(member.type)] : []))
    .filter((type) => type !== 'never');
  const member = contracts.primary.get(property.name);
  return {
    ...property,
    ...(member
      ? {
          required: member.questionToken === undefined,
          readonly: member.modifiers?.some((item) => item.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
          description: readDescription(member, definitions.document.frontmatter),
        }
      : {}),
    type: definitions.advanced && types.length ? [...new Set(types)].join(' | ') : property.type,
    origin: origins.origin(property.name, binding),
    editing: withAliasWarning(
      definitions.advanced ? contracts.editing(property.name) : { kind: 'editable' },
      member ?? definitions.members.find((item) => propertyKey(item.name) === property.name),
      definitions.document.syntax,
    ),
    conditions: conditions.map((condition) => condition.message),
    conditionRefs: conditions.map((condition) => condition.messageRef),
  };
}

// An editable prop whose options live in an alias other declarations share says so.
function withAliasWarning(editing: PropertyEditing, member: ts.PropertySignature | undefined, syntax: ts.SourceFile): PropertyEditing {
  if (editing.kind !== 'editable' || member === undefined) {
    return editing;
  }
  const alias = optionAliasOf(syntax, member);
  const warning = alias === undefined ? undefined : optionAliasWarning(alias);
  return warning === undefined ? editing : { kind: 'editable', warning: warning.message, warningRef: warning.messageRef };
}

export function editPropertyDefinition(source: string, change: PropertyChange): Result<string> {
  const rename = localRename(source, change);
  if (rename === undefined) {
    return editDefinition(source, change);
  }
  // The edit is tried first so that what the definition refuses (a prop of that
  // name, an inherited attribute) keeps its own reason. A syntax error is left to
  // the plan, which reads the whole file and says what to do about it.
  const edited = editDefinition(source, change);
  if (!edited.ok) {
    if (edited.error.code !== 'syntax') {
      return edited;
    }
  }
  const local = renamePropertyLocal(source, rename);
  return local.ok ? editDefinition(local.value, change) : local;
}

// The local to rename with its prop: one spelled as the prop is, and no other.
// `{ features: list }` chose its own name, so only that key changes.
function localRename(source: string, change: PropertyChange): PropertyRename | undefined {
  if (change.kind !== 'save') {
    return undefined;
  }
  const from = change.originalName;
  if (from === '' || from === change.property.name) {
    return undefined;
  }
  const binding = readDefinitions(source).bindings.find((item) => propertyKey(item.propertyName ?? item.name) === from);
  if (binding === undefined) {
    return undefined;
  }
  return ts.isIdentifier(binding.name) && binding.name.text === from ? { from, to: change.property.name } : undefined;
}

function editDefinition(source: string, change: PropertyChange): Result<string> {
  const definitions = readDefinitions(source);
  if (change.kind === 'source') {
    const error = syntaxError(change.frontmatter);
    if (error) {
      return err({ code: 'syntax', message: error });
    }
    return ok(replaceFrontmatter(definitions.document, change.frontmatter.replace(/\s*$/, '\n')));
  }
  if (change.kind === 'variantRules') {
    return editVariantRules(source, change.edit);
  }
  if (definitions.advanced) {
    return editCommonDefinition(definitions, change);
  }
  if (change.kind === 'order') {
    return reorderDefinitions(definitions, change.names);
  }
  if (change.kind === 'options') {
    return saveDefinitionOptions(definitions, change.name, change.type);
  }
  if (change.kind === 'remove') {
    return removeDefinition(definitions, change.name);
  }
  return saveDefinition(definitions, change.originalName, change.property);
}

// A component with combined or typed props: every prop is editable. The prop's
// declarations are all written together (the public type's variants, separate
// intersected types, the runtime type), the destructure entry beside them; a
// prop no local type declares is declared in the type the file has.
function editCommonDefinition(definitions: Definitions, change: Exclude<PropertyChange, { readonly kind: 'source' | 'variantRules' }>): Result<string> {
  if (change.kind === 'order') {
    return reorderDefinitions(definitions, change.names);
  }
  const name = change.kind === 'save' ? change.originalName : change.name;
  const contracts = readPropertyContracts(definitions.document);
  const declared = contracts.declared.get(name) ?? [];
  const [primary, ...others] = declared;
  const common = { ...definitions, members: primary === undefined ? [] : [primary], others };
  if (change.kind === 'remove') {
    return removeDefinition(common, name);
  }
  if (change.kind === 'options') {
    return saveDefinitionOptions(common, name, change.type);
  }
  return saveDefinition(common, name, change.property);
}

function readDefinitions(source: string): Definitions {
  const document = readPropertySyntax(source);
  const declarations = document.syntax.statements.filter(
    (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === 'Props',
  );
  const declaration = declarations[0];
  // With no Props declaration, a destructure annotated inline
  // (`const { title }: { title: string } = Astro.props`) is the props' type.
  const container = definitionContainer(declaration) ?? (declarations.length === 0 ? annotationContainer(document.syntax) : undefined);
  const members = container?.members.filter(ts.isPropertySignature) ?? [];
  // `const props = Astro.props; const { title } = props;` destructures the props through a name.
  const aliases = plainAliases(document.syntax);
  const patterns = syntaxNodes(document.syntax)
    .filter(ts.isVariableDeclaration)
    .filter(
      (node) => isAstroProps(node.initializer) || (node.initializer !== undefined && ts.isIdentifier(node.initializer) && aliases.has(node.initializer.text)),
    )
    .map((node) => node.name)
    .filter(ts.isObjectBindingPattern);
  const bindings = patterns.flatMap((pattern) => pattern.elements).filter((binding) => !binding.dotDotDotToken);
  const typedProps = syntaxNodes(document.syntax).some((node) => ts.isAsExpression(node) && isAstroProps(node.expression) && node.type.getText() !== 'Props');
  const imported = document.syntax.statements.some((statement) => ts.isImportDeclaration(statement) && statement.importClause?.getText().match(/\bProps\b/));
  const annotatedType = syntaxNodes(document.syntax)
    .filter(ts.isVariableDeclaration)
    .find((node) => isAstroProps(node.initializer) && ts.isObjectBindingPattern(node.name) && node.type !== undefined)?.type;
  const advanced =
    declarations.length > 1 ||
    (annotatedType !== undefined && declarations.length === 0 && !ts.isTypeLiteralNode(annotatedType)) ||
    imported ||
    typedProps ||
    (declaration !== undefined && ts.isTypeAliasDeclaration(declaration) && declaration.typeParameters !== undefined) ||
    (declaration !== undefined && ts.isTypeAliasDeclaration(declaration) && !ts.isTypeLiteralNode(declaration.type)) ||
    (container !== undefined && container.members.length !== members.length) ||
    (container !== undefined && ts.isInterfaceDeclaration(container) && container.typeParameters !== undefined) ||
    members.some((member) => !/^[A-Za-z_$][\w$]*$/.test(propertyKey(member.name) ?? '')) ||
    bindings.some((binding) => !ts.isIdentifier(binding.name)) ||
    patterns.length > 1;
  return {
    document,
    readType: createPropertyTypeReader(document.syntax),
    members,
    patterns,
    bindings,
    container,
    advanced,
    others: [],
  };
}

// Names that hold the whole props object: `const props = Astro.props;`.
function plainAliases(syntax: ts.SourceFile): ReadonlySet<string> {
  return new Set(
    syntaxNodes(syntax)
      .filter(ts.isVariableDeclaration)
      .filter((node) => ts.isIdentifier(node.name) && isAstroProps(node.initializer))
      .map((node) => node.name.getText()),
  );
}

// `const props = Astro.props` (or the same with defaults merged in: `{ title: "Hi", ...Astro.props }`), where a prop read as `props.title` has its default.
function propsObjectDeclaration(syntax: ts.SourceFile): ts.VariableDeclaration | undefined {
  return syntaxNodes(syntax)
    .filter(ts.isVariableDeclaration)
    .find((node) => {
      if (!ts.isIdentifier(node.name) || node.initializer === undefined) {
        return false;
      }
      if (isAstroProps(node.initializer)) {
        return true;
      }
      return (
        ts.isObjectLiteralExpression(node.initializer) &&
        node.initializer.properties.some((item) => ts.isSpreadAssignment(item) && isAstroProps(item.expression))
      );
    });
}

// The edit that gives a prop read through the props object its default: a
// `{ name: value, ...Astro.props }` merge, which the object's reads see.
function mergedDefaultEdit(declaration: ts.VariableDeclaration, name: string, expression: string): SourceEdit | undefined {
  const initializer = declaration.initializer;
  assert(initializer !== undefined, 'A props object has an initializer');
  const key = propertyNameText(name);
  const value = defaultExpression(expression);
  if (!ts.isObjectLiteralExpression(initializer)) {
    const whole = initializer.getText();
    const spread = ts.isPropertyAccessExpression(initializer) ? whole : `(${whole})`;
    return { start: initializer.getStart(), end: initializer.end, text: `{ ${key}: ${value}, ...${spread} }` };
  }
  const existing = initializer.properties.find((item) => ts.isPropertyAssignment(item) && propertyKey(item.name) === name);
  if (existing !== undefined && ts.isPropertyAssignment(existing)) {
    return { start: existing.initializer.getStart(), end: existing.initializer.end, text: value };
  }
  const spread = initializer.properties.find((item) => ts.isSpreadAssignment(item) && isAstroProps(item.expression));
  return spread === undefined ? undefined : { start: spread.getStart(), end: spread.getStart(), text: `${key}: ${value}, ` };
}

function annotationContainer(syntax: ts.SourceFile): ts.TypeLiteralNode | undefined {
  const annotated = syntaxNodes(syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer) && ts.isObjectBindingPattern(node.name));
  const type = annotated.length === 1 ? annotated[0]?.type : undefined;
  return type !== undefined && ts.isTypeLiteralNode(type) ? type : undefined;
}

function definitionContainer(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined,
): ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined {
  if (!declaration || ts.isInterfaceDeclaration(declaration)) {
    return declaration;
  }
  if (ts.isTypeLiteralNode(declaration.type)) {
    return declaration.type;
  }
  if (!ts.isIntersectionTypeNode(declaration.type)) {
    return undefined;
  }
  const literals = declaration.type.types.filter(ts.isTypeLiteralNode);
  return literals.length === 1 ? literals[0] : undefined;
}

function readDescription(member: ts.PropertySignature, source: string): string {
  return memberComment(source, member)?.description ?? '';
}

function renderDefinition(property: ComponentProperty): string {
  const documentation = property.description.trim();
  const description = documentation ? `\t/** ${documentation.replace(/\*\//g, '* /').replace(/\n/g, '\n\t * ')} */\n` : '';
  return `\n${description}\t${property.readonly ? 'readonly ' : ''}${propertyNameText(property.name)}` + `${property.required ? '' : '?'}: ${property.type};`;
}

// One member on one line, for the `& { … }` a type that is not a literal gets.
function inlineDefinition(property: ComponentProperty): string {
  const documentation = property.description
    .trim()
    .replace(/\*\//g, '* /')
    .replace(/\s*\n\s*/g, ' ');
  const comment = documentation ? `/** ${documentation} */ ` : '';
  return `${comment}${property.readonly ? 'readonly ' : ''}${propertyNameText(property.name)}${property.required ? '' : '?'}: ${property.type}`;
}
function saveDefinition(definitions: Definitions, originalName: string, property: ComponentProperty): Result<string> {
  const valid = validatePropertyCode(property.type, property.defaultValue);
  if (!valid.ok) {
    return valid;
  }
  const snapshot = readComponentProperties(definitions.document.source);
  const previous = originalName ? snapshot.properties.find((field) => field.name === originalName) : undefined;
  if (originalName && previous === undefined) {
    return err(refusal('missing', 'props.edit.missing'));
  }
  if (originalName !== property.name && snapshot.properties.some((field) => field.name === property.name)) {
    return err(refusal('duplicate', 'props.edit.duplicate', { name: property.name }));
  }
  if (!originalName && snapshot.properties.length >= PROPERTY_LIMITS.fieldsMax) {
    return err(refusal('limit', 'props.edit.limit'));
  }
  // A save that changes nothing writes nothing: the file is the author's.
  if (previous !== undefined && sameProperty(previous, property)) {
    return ok(definitions.document.source);
  }
  const declaration = declarationEdits(definitions, originalName, previous, property);
  if (!declaration.ok) {
    return declaration;
  }
  const merged = mergedDefault(definitions, originalName, previous, property);
  const binding = merged === undefined ? saveDefinitionBinding(definitions, originalName, previous, property) : ok(merged);
  if (!binding.ok) {
    return binding;
  }
  const frontmatter = applySourceEdits(definitions.document.frontmatter, [...declaration.value, ...binding.value]);
  const error = syntaxError(frontmatter);
  if (error) {
    return err({ code: 'syntax', message: error });
  }
  const output = replaceFrontmatter(definitions.document, frontmatter);
  assert(output !== definitions.document.source || previous === undefined || !sameProperty(previous, property), 'A changed save writes its change');
  const defaultChanged = property.defaultValue.trim() !== (previous?.defaultValue.trim() ?? '');
  // A new prop is read nowhere yet, and a default merged into the props object needs no rewrite of its reads.
  const bound = definitions.bindings.some((item) => propertyKey(item.propertyName ?? item.name) === originalName);
  if (property.defaultValue.trim() && defaultChanged && originalName !== '' && merged === undefined) {
    const existing = definitions.bindings.find((item) => propertyKey(item.propertyName ?? item.name) === originalName);
    // A destructure that unpacks the prop further (`author: { name }`) has no single local to alias.
    if (existing !== undefined && !ts.isIdentifier(existing.name)) {
      return ok(output);
    }
    const local = existing?.name.getText() ?? bindingFor(definitions, property.name);
    const aliased = bindComponentDefault(output, originalName, local);
    // The alias only shields template reads from shadowing. A prop already destructured has its default
    // in the destructure either way, so a component that cannot take the alias keeps the written default.
    return aliased.ok || !bound ? aliased : ok(output);
  }
  return ok(output);
}

// The default of a prop with no destructure entry, in a component that reads its props through one object.
function mergedDefault(
  definitions: Definitions,
  originalName: string,
  previous: ComponentProperty | undefined,
  property: ComponentProperty,
): readonly SourceEdit[] | undefined {
  const fallback = property.defaultValue.trim();
  const declaration = propsObjectDeclaration(definitions.document.syntax);
  const bound = definitions.bindings.some((item) => propertyKey(item.propertyName ?? item.name) === originalName);
  if (declaration === undefined || bound || fallback === '' || fallback === (previous?.defaultValue.trim() ?? '')) {
    return undefined;
  }
  const edit = mergedDefaultEdit(declaration, originalName || property.name, fallback);
  return edit === undefined ? undefined : [edit];
}

// The type side of a save: the member's own text edited in place (and every
// other declaration of the prop beside it), a member appended to the type the
// file already has, or (for a component with no types at all) a new
// `interface Props`.
function declarationEdits(
  definitions: Definitions,
  originalName: string,
  previous: ComponentProperty | undefined,
  property: ComponentProperty,
): Result<readonly SourceEdit[]> {
  const member = definitions.members.find((item) => propertyKey(item.name) === originalName);
  if (member) {
    assert(previous !== undefined, 'A declared member was read before its save');
    // Options kept in a same-file alias are written there, so the alias stays the one place they live.
    const alias = optionAliasOf(definitions.document.syntax, member);
    const target = alias !== undefined && literalOptions(property.type) !== undefined ? alias.declaration.type : member.type;
    const frontmatter = definitions.document.frontmatter;
    const others = definitions.others.flatMap((other) => memberEdits(frontmatter, other, ...otherDeclaration(definitions, other, previous, property)));
    return ok([...memberEdits(frontmatter, member, previous, property, target), ...others]);
  }
  if (previous !== undefined && sameDeclaration(previous, property)) {
    return ok([]);
  }
  if (definitions.container) {
    return ok([
      {
        start: definitions.container.end - 1,
        end: definitions.container.end - 1,
        text: withIndentUnit(renderDefinition(property), indentUnitOf(definitions.document.frontmatter)) + '\n',
      },
    ]);
  }
  if (previous === undefined && LOOSE_TYPES.has(property.type.trim()) && !property.description.trim() && !property.required && !property.readonly) {
    // A new prop that states nothing a type would carry needs only its destructure entry.
    return ok([]);
  }
  const hosted = declareInHost(definitions.document.syntax, {
    block: withIndentUnit(renderDefinition(property), indentUnitOf(definitions.document.frontmatter)) + '\n',
    inline: inlineDefinition(property),
  });
  if (hosted !== undefined) {
    return hosted;
  }
  const snapshot = readComponentProperties(definitions.document.source);
  // The new interface lists the props in the order the panel shows them, the saved one in its place.
  const fields =
    previous === undefined ? [...snapshot.properties, property] : snapshot.properties.map((field) => (field.name === originalName ? property : field));
  return ok([{ start: 0, end: 0, text: newPropsInterface(definitions, fields.map(renderDefinition).join('')) }]);
}

// What a save changes in a prop's other declarations: its own name, type and
// required mark with only the parts the save changed. A `never` declaration
// (the prop is not allowed in that variant) keeps its type and mark, and the
// tooltip stays on the declaration that carries it.
function otherDeclaration(
  definitions: Definitions,
  member: ts.PropertySignature,
  previous: ComponentProperty,
  property: ComponentProperty,
): [DeclaredFields, DeclaredFields] {
  const own: DeclaredFields = {
    name: previous.name,
    type: member.type ? definitions.readType(member.type) : 'unknown',
    required: member.questionToken === undefined,
    readonly: member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
    description: readDescription(member, definitions.document.frontmatter),
  };
  if (own.type === 'never') {
    return [own, { ...own, name: property.name }];
  }
  return [
    own,
    {
      name: property.name,
      type: property.type === previous.type ? own.type : property.type,
      required: property.required === previous.required ? own.required : property.required,
      readonly: property.readonly === previous.readonly ? own.readonly : property.readonly,
      description: own.description,
    },
  ];
}

// `interface Props { … }` for a component that has no type for its props. One
// that forwards other attributes (`...rest`) also accepts them, so adding the
// type does not make the attributes it passes on a type error.
function newPropsInterface(definitions: Definitions, members: string): string {
  const forwards = definitions.patterns.some((pattern) => pattern.elements.some((element) => element.dotDotDotToken !== undefined));
  const indent = indentUnitOf(definitions.document.frontmatter);
  const attributes = forwards ? withIndentUnit('\n\t[attribute: string]: unknown;', indent) : '';
  return withIndentUnit(`interface Props {${members}`, indent) + `${attributes}\n}\n`;
}

const LOOSE_TYPES = new Set(['', 'unknown']);

function saveDefinitionOptions(definitions: Definitions, name: string, type: string): Result<string> {
  const property = readComponentProperties(definitions.document.source).properties.find((field) => field.name === name);
  if (!property) {
    return err(refusal('missing', 'props.edit.missing'));
  }
  assert(property.name === name, 'Option reorder targets the requested property');
  assert(type.length <= PROPERTY_LIMITS.textCharsMax, 'Option type is bounded');
  return saveDefinition(definitions, name, { ...property, type });
}

function saveDefinitionBinding(
  definitions: Definitions,
  originalName: string,
  previous: ComponentProperty | undefined,
  property: ComponentProperty,
): Result<readonly SourceEdit[]> {
  const binding = definitions.bindings.find((item) => propertyKey(item.propertyName ?? item.name) === originalName);
  if (binding) {
    assert(previous !== undefined, 'A destructured prop was read before its save');
    // The binding's local is not this edit's to change: a local spelled as the prop
    // was renamed across the file before this (editPropertyDefinition), and an alias stays.
    return ok(bindingEdits(binding, previous, property));
  }
  const fallback = property.defaultValue.trim() ? ` = ${defaultExpression(property.defaultValue.trim())}` : '';
  if (!fallback && originalName) {
    return ok([]);
  }
  // A name that is not an identifier (`aria-label`) is read through a camel-case local.
  const local = bindingFor(definitions, property.name);
  const entry = local === property.name && propertyNameText(property.name) === property.name ? property.name : `${propertyNameText(property.name)}: ${local}`;
  const pattern = definitions.patterns[0];
  if (pattern) {
    const first = pattern.elements[0];
    const position = first?.getStart() ?? pattern.end - 1;
    return ok([{ start: position, end: position, text: `${entry}${fallback}${first ? ', ' : ''}` }]);
  }
  // Before the first statement of code, so every read of the prop comes after its default.
  const position = firstCodeStart(definitions.document.syntax);
  return ok([
    {
      start: position,
      end: position,
      text:
        position === definitions.document.frontmatter.length
          ? `\nconst { ${entry}${fallback} } = Astro.props;\n`
          : `const { ${entry}${fallback} } = Astro.props;\n`,
    },
  ]);
}

// Words a local variable cannot be named, so a prop of that name is read through `propClass`.
const RESERVED_WORDS: ReadonlySet<string> = new Set(
  'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with'.split(
    ' ',
  ),
);

// The local a new destructure entry reads a prop through: its name, or `propTitle` (then `propTitle2`) when the file already uses that name for something else.
// A member moved to another position keeps its terminator, and gains one when it was the last member of a line (`{ a?: string; b?: string }`).
// Where the first statement that is not an import or a type begins, or the end of the frontmatter.
function firstCodeStart(syntax: ts.SourceFile): number {
  const code = syntax.statements.find(
    (statement) => !ts.isImportDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement),
  );
  return code === undefined ? syntax.end : code.getStart();
}

function terminated(chunk: string): string {
  return /[;,]\s*$/.test(chunk) ? chunk : `${chunk.trimEnd()};`;
}

function bindingFor(definitions: Definitions, name: string): string {
  const taken = new Set(
    syntaxNodes(definitions.document.syntax)
      .filter(ts.isIdentifier)
      .filter((node) => !ts.isPropertySignature(node.parent))
      .map((node) => node.text),
  );
  const base = bindingLocal(name);
  for (let attempt = 1; attempt <= PROPERTY_LIMITS.fieldsMax; attempt++) {
    const candidate = attempt === 1 ? base : `prop${base.charAt(0).toUpperCase()}${base.slice(1)}${attempt === 2 ? '' : String(attempt)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  assert(false, 'A free local name is found within the field bound');
  return base;
}

function bindingLocal(name: string): string {
  const camel = name.replace(/[^A-Za-z0-9_$]+(.)?/g, (_match: string, next: string | undefined) => (next === undefined ? '' : next.toUpperCase()));
  return /^[A-Za-z_$]/.test(camel) && !RESERVED_WORDS.has(camel) ? camel : `prop${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

function reorderDefinitions(definitions: Definitions, names: readonly string[]): Result<string> {
  const fields = readComponentProperties(definitions.document.source).properties;
  if (new Set(names).size !== names.length || names.length !== fields.length || names.some((name) => !fields.some((field) => field.name === name))) {
    return err(refusal('order', 'props.edit.reorder'));
  }
  const indent = indentUnitOf(definitions.document.frontmatter);
  const chunks = new Map(fields.map((field) => [field.name, withIndentUnit(renderDefinition(field), indent)]));
  const listed = new Set<string>();
  for (const member of definitions.members) {
    const name = propertyKey(member.name);
    assert(name !== undefined, 'Editable property has a name');
    chunks.set(name, terminated(definitions.document.frontmatter.slice(member.getFullStart(), member.end)));
    listed.add(name);
  }
  const container = definitions.container;
  // A component with combined types moves only the members its own props type lists: the rest live in other types.
  const order = definitions.advanced ? names.filter((name) => listed.has(name)) : names;
  const foreign = container?.members.some((member) => !ts.isPropertySignature(member)) ?? false;
  if (definitions.advanced && (container === undefined || order.length < 2 || foreign)) {
    return ok(definitions.document.source);
  }
  const text = order
    .map((name) => {
      const chunk = chunks.get(name);
      assert(chunk !== undefined, 'Every reordered property has source');
      return chunk;
    })
    .join('');
  if (!container) {
    return ok(replaceFrontmatter(definitions.document, `${newPropsInterface(definitions, text)}${definitions.document.frontmatter}`));
  }
  const first = definitions.members[0];
  const last = definitions.members.at(-1);
  return ok(
    replaceFrontmatter(
      definitions.document,
      applySourceEdits(definitions.document.frontmatter, [
        {
          start: first?.getFullStart() ?? container.end - 1,
          end: last?.end ?? container.end - 1,
          text,
        },
      ]),
    ),
  );
}

// Whether the file reads the prop as `Astro.props.name` or through a name that holds the props object.
function readThroughProps(definitions: Definitions, name: string): boolean {
  const holders = ['Astro.props', ...plainAliases(definitions.document.syntax)];
  return syntaxNodes(definitions.document.syntax).some(
    (node) => ts.isPropertyAccessExpression(node) && node.name.text === name && holders.includes(node.expression.getText().replace(/\s/g, '')),
  );
}

function removeDefinition(definitions: Definitions, name: string): Result<string> {
  const member = definitions.members.find((item) => propertyKey(item.name) === name);
  const binding = definitions.bindings.find((item) => propertyKey(item.propertyName ?? item.name) === name);
  if (!member && !binding) {
    // A prop the file only reads (`Astro.props.name`) has no declaration to take out: it can go once nothing reads it.
    const reads = readThroughProps(definitions, name);
    return reads ? err(refusal('in-use', 'props.edit.inUse')) : ok(definitions.document.source);
  }
  const edits: SourceEdit[] = [member, ...definitions.others].flatMap((declared) =>
    declared ? [{ start: declared.getFullStart(), end: declared.end, text: '' }] : [],
  );
  if (binding) {
    const pattern = definitions.patterns.find((item) => item.elements.includes(binding));
    assert(pattern !== undefined, 'A prop binding belongs to an Astro.props pattern');
    const index = pattern.elements.indexOf(binding);
    const next = pattern.elements[index + 1];
    const previous = pattern.elements[index - 1];
    edits.push({
      start: next ? binding.getStart() : (previous?.end ?? binding.getStart()),
      end: next?.getStart() ?? binding.end,
      text: '',
    });
  }
  const frontmatter = applySourceEdits(definitions.document.frontmatter, edits);
  const output = replaceFrontmatter(definitions.document, frontmatter);
  const local = binding?.name.getText() ?? name;
  // Conservative mention detection is deliberate: removing a live lexical binding
  // breaks rendering, while a false positive can still be resolved in source.
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(output)) {
    return err(refusal('in-use', 'props.edit.inUse'));
  }
  return ok(output);
}
