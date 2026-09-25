import { readPropertyOrigins } from './propertyOrigins';
import { readPropertyContracts } from './propertyContracts';
import type { PropertyContracts } from './propertyContracts';
import type { PropertyOrigins } from './propertyOrigins';
import type { SchemaField } from './astroParser.types';
import { createPropertyTypeReader } from './propertyTypes';
import { bindComponentDefault } from './propertyRename';
import ts from 'typescript';
import { assert } from '../shared/assert';
import type {
  ComponentProperties,
  ComponentProperty,
  PropertyChange,
  PropertyEditing,
} from '../shared/component-properties';
import { PROPERTY_LIMITS } from '../shared/component-properties';
import { err, ok, type Result } from '../shared/result';
import { parsePropSchema } from './astroParser';
import {
  applySourceEdits,
  defaultExpression,
  isAstroProps,
  propertyKey,
  readPropertySyntax,
  replaceFrontmatter,
  syntaxError,
  syntaxNodes,
  validatePropertyCode,
} from './propertySyntax';
import type { PropertySyntax, SourceEdit } from './propertySyntax';

interface Definitions {
  readonly document: PropertySyntax;
  readonly readType: (type: ts.TypeNode) => string;
  readonly members: readonly ts.PropertySignature[];
  readonly bindings: readonly ts.BindingElement[];
  readonly patterns: readonly ts.ObjectBindingPattern[];
  readonly container: ts.InterfaceDeclaration | ts.TypeLiteralNode | undefined;
  readonly advanced: boolean;
}

export function readComponentProperties(source: string): ComponentProperties {
  const definitions = readDefinitions(source);
  const origins = readPropertyOrigins(definitions.document);
  const fields = readDefinitionFields(definitions);
  const contracts = readPropertyContracts(definitions.document);
  return {
    source,
    properties: [...fields.values()].map((property) =>
      sourcedProperty(property, definitions, origins, contracts)
    ),
    frontmatter: definitions.document.frontmatter,
    advanced: definitions.advanced,
  };
}

function readDefinitionFields(definitions: Definitions): ReadonlyMap<string, ComponentProperty> {
  const fields = new Map<string, ComponentProperty>();
  const names = new Set([
    ...definitions.members.map((member) => propertyKey(member.name)),
    ...definitions.bindings.map((binding) => propertyKey(binding.propertyName ?? binding.name)),
  ]);
  for (const field of parsePropSchema(definitions.document.source)) {
    if (!definitions.advanced && !names.has(field.name)) {
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
      readonly:
        member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword) ??
        false,
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
  assert(fields.size <= PROPERTY_LIMITS.fieldsMax, 'Component field count is bounded');
  assert(new Set(fields.keys()).size === fields.size, 'Component property names are unique');
  return fields;
}

function schemaPropertyType(field: SchemaField): string {
  if (field.type === 'enum' && field.options?.length) {
    return field.options
      .map((value) => (field.numeric ? value : JSON.stringify(value)))
      .join(' | ');
  }
  return ['enum', 'other', 'code', 'attrs', 'slot', 'style'].includes(field.type)
    ? 'unknown'
    : field.type || 'unknown';
}

function sourcedProperty(
  property: ComponentProperty,
  definitions: Definitions,
  origins: PropertyOrigins,
  contracts: PropertyContracts
): ComponentProperty {
  const binding = definitions.bindings.find(
    (item) => propertyKey(item.propertyName ?? item.name) === property.name
  );
  const types = (origins.members.get(property.name) ?? [])
    .flatMap((member) => (member.type ? [definitions.readType(member.type)] : []))
    .filter((type) => type !== 'never');
  const member = contracts.editable.get(property.name);
  return {
    ...property,
    ...(member
      ? {
          required: member.questionToken === undefined,
          readonly:
            member.modifiers?.some((item) => item.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false,
          description: readDescription(member, definitions.document.frontmatter),
        }
      : {}),
    type: definitions.advanced && types.length ? [...new Set(types)].join(' | ') : property.type,
    origin: origins.origin(property.name, binding),
    editing: definitions.advanced
      ? contractEditing(definitions, contracts, property.name)
      : {
          kind: 'editable',
        },
    conditions: contracts.conditions(property.name),
  };
}

function contractEditing(
  definitions: Definitions,
  contracts: PropertyContracts,
  name: string
): PropertyEditing {
  if (
    definitions.patterns.length > 1 ||
    definitions.bindings.some((binding) => !ts.isIdentifier(binding.name))
  ) {
    return {
      kind: 'restricted',
      reason: 'This prop uses complex destructuring. Edit it in source.',
    };
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return { kind: 'restricted', reason: 'This prop uses a quoted name. Edit it in source.' };
  }
  const editing = contracts.editing(name);
  if (editing.kind === 'override' && !definitions.container) {
    return {
      kind: 'restricted',
      reason: 'This inherited prop has no unambiguous local declaration to update.',
    };
  }
  return editing;
}

export function editPropertyDefinition(source: string, change: PropertyChange): Result<string> {
  const definitions = readDefinitions(source);
  if (change.kind === 'source') {
    const error = syntaxError(change.frontmatter);
    if (error) {
      return err({ code: 'syntax', message: error });
    }
    return ok(replaceFrontmatter(definitions.document, change.frontmatter.replace(/\s*$/, '\n')));
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

function editCommonDefinition(
  definitions: Definitions,
  change: Exclude<PropertyChange, { readonly kind: 'source' }>
): Result<string> {
  if (change.kind === 'order' || (change.kind === 'save' && !change.originalName)) {
    return err({
      code: 'advanced',
      message: 'Add or reorder declarations in this combined type in source.',
    });
  }
  const name = change.kind === 'save' ? change.originalName : change.name;
  // Renderer permissions are descriptive only; every write rechecks the current source.
  const contracts = readPropertyContracts(definitions.document);
  const access = contractEditing(definitions, contracts, name);
  if (access.kind === 'restricted') {
    return err({ code: 'restricted', message: access.reason });
  }
  if (access.kind === 'override') {
    if (change.kind === 'remove') {
      return err({ code: 'inherited', message: 'Inherited HTML attributes cannot be deleted.' });
    }
    if (change.kind === 'save' && change.property.name !== name) {
      return err({ code: 'inherited', message: 'Inherited HTML attributes cannot be renamed.' });
    }
    return change.kind === 'options'
      ? saveDefinitionOptions(definitions, name, change.type)
      : saveDefinition(definitions, name, change.property);
  }
  const member = contracts.editable.get(name);
  assert(member !== undefined, 'An editable common property has a declaration');
  assert(propertyKey(member.name) === name, 'The edit targets the requested declaration');
  const common = { ...definitions, members: [member] };
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
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) &&
      statement.name.text === 'Props'
  );
  const declaration = declarations[0];
  const container = definitionContainer(declaration);
  const members = container?.members.filter(ts.isPropertySignature) ?? [];
  const patterns = syntaxNodes(document.syntax)
    .filter(ts.isVariableDeclaration)
    .filter((node) => isAstroProps(node.initializer))
    .map((node) => node.name)
    .filter(ts.isObjectBindingPattern);
  const bindings = patterns
    .flatMap((pattern) => pattern.elements)
    .filter((binding) => !binding.dotDotDotToken);
  const typedProps = syntaxNodes(document.syntax).some(
    (node) =>
      ts.isAsExpression(node) && isAstroProps(node.expression) && node.type.getText() !== 'Props'
  );
  const imported = document.syntax.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) && statement.importClause?.getText().match(/\bProps\b/)
  );
  const advanced =
    declarations.length > 1 ||
    imported ||
    typedProps ||
    (declaration !== undefined &&
      ts.isTypeAliasDeclaration(declaration) &&
      declaration.typeParameters !== undefined) ||
    (declaration !== undefined &&
      ts.isTypeAliasDeclaration(declaration) &&
      !ts.isTypeLiteralNode(declaration.type)) ||
    (container !== undefined && container.members.length !== members.length) ||
    (container !== undefined &&
      ts.isInterfaceDeclaration(container) &&
      container.typeParameters !== undefined) ||
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
  };
}

function definitionContainer(
  declaration: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | undefined
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
  const leading = source.slice(member.getFullStart(), member.getStart());
  const match = /\/\*\*([\s\S]*?)\*\//.exec(leading);
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, ''))
    .join('\n')
    .trim();
}
function renderDefinition(property: ComponentProperty): string {
  const doc = property.description.trim();
  const description = doc
    ? `  /** ${doc.replace(/\*\//g, '* /').replace(/\n/g, '\n   * ')} */\n`
    : '';
  return (
    `\n${description}  ${property.readonly ? 'readonly ' : ''}${property.name}` +
    `${property.required ? '' : '?'}: ${property.type};`
  );
}
function saveDefinition(
  definitions: Definitions,
  originalName: string,
  property: ComponentProperty
): Result<string> {
  const valid = validatePropertyCode(property.type, property.defaultValue);
  if (!valid.ok) {
    return valid;
  }
  const snapshot = readComponentProperties(definitions.document.source);
  if (originalName && !snapshot.properties.some((field) => field.name === originalName)) {
    return err({ code: 'missing', message: 'This property no longer exists. Reload the panel.' });
  }
  if (
    originalName !== property.name &&
    snapshot.properties.some((field) => field.name === property.name)
  ) {
    return err({ code: 'duplicate', message: `A property named ${property.name} already exists.` });
  }
  if (!originalName && snapshot.properties.length >= PROPERTY_LIMITS.fieldsMax) {
    return err({ code: 'limit', message: 'The component property limit has been reached.' });
  }
  const member = definitions.members.find((item) => propertyKey(item.name) === originalName);
  const edits: SourceEdit[] = [];
  if (member) {
    edits.push({
      start: member.getFullStart(),
      end: member.end,
      text: renderSavedDefinition(definitions, member, property),
    });
  } else if (definitions.container) {
    edits.push({
      start: definitions.container.end - 1,
      end: definitions.container.end - 1,
      text: renderDefinition(property) + '\n',
    });
  } else {
    const fields = snapshot.properties.filter((field) => field.name !== originalName);
    edits.push({
      start: 0,
      end: 0,
      text: `interface Props {${[...fields, property].map(renderDefinition).join('')}\n}\n`,
    });
  }
  const binding = saveDefinitionBinding(definitions, originalName, property);
  if (!binding.ok) {
    return binding;
  }
  edits.push(...binding.value);
  const frontmatter = applySourceEdits(definitions.document.frontmatter, edits);
  const error = syntaxError(frontmatter);
  if (error) {
    return err({ code: 'syntax', message: error });
  }
  const output = replaceFrontmatter(definitions.document, frontmatter);
  if (property.defaultValue.trim()) {
    const local =
      definitions.bindings
        .find((item) => propertyKey(item.propertyName ?? item.name) === originalName)
        ?.name.getText() ?? property.name;
    return bindComponentDefault(output, originalName || property.name, local);
  }
  return ok(output);
}

function saveDefinitionOptions(
  definitions: Definitions,
  name: string,
  type: string
): Result<string> {
  const property = readComponentProperties(definitions.document.source).properties.find(
    (field) => field.name === name
  );
  if (!property) {
    return err({ code: 'missing', message: 'This property no longer exists. Reload the panel.' });
  }
  assert(property.name === name, 'Option reorder targets the requested property');
  assert(type.length <= PROPERTY_LIMITS.textCharsMax, 'Option type is bounded');
  return saveDefinition(definitions, name, { ...property, type });
}

function renderSavedDefinition(
  definitions: Definitions,
  member: ts.PropertySignature,
  property: ComponentProperty
): string {
  const type = member.type;
  // Required, tooltip, default, and name edits must retain the authored alias.
  // An option edit affects this property alone, not other consumers of that alias.
  if (type && property.type === definitions.readType(type)) {
    return renderDefinition({ ...property, type: type.getText() });
  }
  return renderDefinition(property);
}

function saveDefinitionBinding(
  definitions: Definitions,
  originalName: string,
  property: ComponentProperty
): Result<readonly SourceEdit[]> {
  const binding = definitions.bindings.find(
    (item) => propertyKey(item.propertyName ?? item.name) === originalName
  );
  const fallback = property.defaultValue.trim()
    ? ` = ${defaultExpression(property.defaultValue.trim())}`
    : '';
  if (binding) {
    // Keep the lexical binding: aliases prevent accidental edits to shadowed locals in templates.
    const local = binding.name.getText();
    const name = local === property.name ? property.name : `${property.name}: ${local}`;
    return ok([{ start: binding.getStart(), end: binding.end, text: name + fallback }]);
  }
  if (!fallback && originalName) {
    return ok([]);
  }
  const locals = syntaxNodes(definitions.document.syntax).filter(ts.isIdentifier);
  if (locals.some((node) => node.text === property.name && !ts.isPropertySignature(node.parent))) {
    return err({
      code: 'binding',
      message:
        `The name ${property.name} is already in scope. ` +
        'Add an aliased default in TypeScript source.',
    });
  }
  const pattern = definitions.patterns[0];
  if (pattern) {
    const first = pattern.elements[0];
    const position = first?.getStart() ?? pattern.end - 1;
    return ok([
      { start: position, end: position, text: `${property.name}${fallback}${first ? ', ' : ''}` },
    ]);
  }
  const position = definitions.document.frontmatter.length;
  return ok([
    {
      start: position,
      end: position,
      text: `\nconst { ${property.name}${fallback} } = Astro.props;\n`,
    },
  ]);
}

function reorderDefinitions(definitions: Definitions, names: readonly string[]): Result<string> {
  const fields = readComponentProperties(definitions.document.source).properties;
  if (
    new Set(names).size !== names.length ||
    names.length !== fields.length ||
    names.some((name) => !fields.some((field) => field.name === name))
  ) {
    return err({
      code: 'order',
      message: 'Reorder must include every declared property exactly once.',
    });
  }
  const chunks = new Map(fields.map((field) => [field.name, renderDefinition(field)]));
  for (const member of definitions.members) {
    const name = propertyKey(member.name);
    assert(name !== undefined, 'Editable property has a name');
    chunks.set(name, definitions.document.frontmatter.slice(member.getFullStart(), member.end));
  }
  const text = names
    .map((name) => {
      const chunk = chunks.get(name);
      assert(chunk !== undefined, 'Every reordered property has source');
      return chunk;
    })
    .join('');
  const container = definitions.container;
  if (!container) {
    return ok(
      replaceFrontmatter(
        definitions.document,
        `interface Props {${text}\n}\n${definitions.document.frontmatter}`
      )
    );
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
      ])
    )
  );
}

function removeDefinition(definitions: Definitions, name: string): Result<string> {
  const member = definitions.members.find((item) => propertyKey(item.name) === name);
  const binding = definitions.bindings.find(
    (item) => propertyKey(item.propertyName ?? item.name) === name
  );
  if (!member && !binding) {
    return err({ code: 'missing', message: 'Property not found.' });
  }
  const edits: SourceEdit[] = member
    ? [{ start: member.getFullStart(), end: member.end, text: '' }]
    : [];
  if (binding) {
    const pattern = definitions.patterns.find((item) => item.elements.includes(binding));
    assert(pattern !== undefined, 'A prop binding belongs to an Astro.props pattern');
    const index = pattern.elements.indexOf(binding);
    const next = pattern.elements[index + 1];
    const previous = pattern.elements[index - 1];
    edits.push({
      start: next ? binding.getStart() : previous?.end ?? binding.getStart(),
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
    return err({
      code: 'in-use',
      message: 'This property is still referenced. Remove its component usages before deleting it.',
    });
  }
  return ok(output);
}
