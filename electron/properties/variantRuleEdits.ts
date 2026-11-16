// Writes one variant rule edit (shared/properties/variantRules.ts) into a
// component's source as the smallest text change that says it: a `?` added or
// taken away, a type replaced by `never` or given back, one union member
// copied, removed or moved, one string literal renamed. Everything else in the
// file keeps its bytes, comments and formatting (docs/props-variant-rules.md).
//
// The union is not the only text that names an option or a prop, so each edit
// keeps the rest in step in the same write: the runtime type the component
// asserts `Astro.props` as (`variant?: "main" | "link"`), the destructure
// (`variant = "main"`, a new prop's local), and the comparisons that test the
// controller's local against an option (`variant === "main"`). Where an option
// is used in a way the writer cannot follow (an object key, a property name),
// renaming or removing it is refused rather than leaving that code wrong.
// Instances in other files are the plan's (variantRulePlan.ts).
import ts from 'typescript';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { refusal } from '../../shared/properties/propertyErrors';
import { VARIANT_LIMITS, variantOptionValue } from '../../shared/properties/variantRules';
import type { VariantRuleEdit, VariantRuleState } from '../../shared/properties/variantRules';
import { applySourceEdits, propertyKey, readPropertySyntax, replaceFrontmatter, syntaxError, syntaxNodes, validatePropertyCode } from './propertySyntax';
import type { SourceEdit } from './propertySyntax';
import { memberComment } from './propertyMemberEdits';
import { readVariantSyntax, ruleOf, stringLiteralOf, variantGroupsOf } from './variantRuleModel';
import type { VariantGroupSyntax, VariantSyntax } from './variantRuleModel';

/** Frontmatter edits are offsets into the frontmatter; template edits, into the whole source. */
interface PlannedEdits {
  readonly frontmatter: readonly SourceEdit[];
  readonly template: readonly SourceEdit[];
}

const NO_EDITS: PlannedEdits = { frontmatter: [], template: [] };

/** The source with `edit` applied, the same source when it changes nothing, or why it cannot be applied. */
export function editVariantRules(source: string, edit: VariantRuleEdit): Result<string> {
  const document = readPropertySyntax(source);
  const syntax = readVariantSyntax(document);
  const group = syntax.groups.find((candidate) => candidate.controller === edit.controller);
  if (group === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingGroup', { name: edit.controller }));
  }
  if (group.reason !== undefined) {
    return err(refusal('restricted', 'componentProps.variants.readOnly', { name: edit.controller }));
  }
  const planned = planEdit(syntax, group, edit);
  if (!planned.ok) {
    return planned;
  }
  if (planned.value.frontmatter.length === 0 && planned.value.template.length === 0) {
    return ok(source);
  }
  const frontmatter = applySourceEdits(document.frontmatter, planned.value.frontmatter);
  const error = syntaxError(frontmatter);
  if (error !== undefined) {
    return err({ code: 'syntax', message: error });
  }
  const written = replaceFrontmatter(document, frontmatter);
  // The template follows the frontmatter, so its offsets move by what the frontmatter grew.
  const shift = frontmatter.length - document.frontmatter.length;
  assert(
    planned.value.template.every((item) => item.start >= document.end),
    'Template edits lie after the frontmatter',
  );
  const output = applySourceEdits(
    written,
    planned.value.template.map((item) => ({ ...item, start: item.start + shift, end: item.end + shift })),
  );
  assert(output !== source, 'A planned edit changes the source');
  verifyEdit(output, edit);
  return ok(output);
}

// The one place that branches on the edit: each helper below plans text and
// returns it, or refuses.
function planEdit(syntax: VariantSyntax, group: VariantGroupSyntax, edit: VariantRuleEdit): Result<PlannedEdits> {
  switch (edit.kind) {
    case 'setRule':
      return planSetRule(syntax, group, edit.option, edit.prop, edit.state);
    case 'addOption':
      return planAddOption(syntax, group, edit.value);
    case 'renameOption':
      return planRenameOption(syntax, group, edit.from, edit.to);
    case 'removeOption':
      return planRemoveOption(syntax, group, edit.value);
    case 'moveOption':
      return planMoveOption(syntax, group, edit.value, edit.index);
    case 'setFallback':
      return planSetFallback(syntax, group, edit.value);
    case 'addProp':
      return planAddProp(syntax, group, edit.prop, edit.type);
    case 'removeProp':
      return planRemoveProp(syntax, group, edit.prop);
    case 'attachProp':
      return planAttachProp(syntax, group, edit.prop, edit.options);
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

function planSetRule(syntax: VariantSyntax, group: VariantGroupSyntax, option: string, prop: string, state: VariantRuleState): Result<PlannedEdits> {
  const member = group.members.find((candidate) => candidate.value === option);
  if (member === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value: option }));
  }
  if (!group.props.includes(prop)) {
    return err(refusal('missing', 'componentProps.variants.missingProp', { name: prop }));
  }
  const current = ruleOf(member, prop);
  if (current.state === state) {
    return ok(NO_EDITS);
  }
  const frontmatter = syntax.document.frontmatter;
  const field = member.fields.get(prop);
  if (state === 'forbidden') {
    assert(field !== undefined, 'planSetRule: an allowed prop is declared');
    return ok({ frontmatter: [...optionalEdits(field, 'optional'), typeEdit(field, 'never')], template: [] });
  }
  const type = propTypeOf(syntax, group, prop);
  if (!type.ok) {
    return type;
  }
  if (field === undefined) {
    return ok({ frontmatter: [insertField(frontmatter, member.literal, declarationText(prop, state, type.value))], template: [] });
  }
  // A prop already allowed keeps its own type; one that was `never` takes the prop's.
  const retyped = current.state === 'forbidden' ? [typeEdit(field, type.value)] : [];
  return ok({ frontmatter: [...optionalEdits(field, state), ...retyped], template: [] });
}

function planAddOption(syntax: VariantSyntax, group: VariantGroupSyntax, value: string): Result<PlannedEdits> {
  const valid = newOptionValue(group, value);
  if (!valid.ok) {
    return valid;
  }
  if (group.members.length >= VARIANT_LIMITS.optionsMax) {
    return err(refusal('limit', 'componentProps.variants.optionsLimit', { max: VARIANT_LIMITS.optionsMax }));
  }
  const frontmatter = syntax.document.frontmatter;
  const template = group.members.at(-1);
  const before = group.members.at(-2);
  assert(template !== undefined, 'planAddOption: a group has a last option');
  assert(before !== undefined, 'planAddOption: a group has at least two options');
  // The new option copies the last one, rules and comments included, as the
  // designer's starting point; it is never the fallback.
  const start = template.node.getStart();
  const inner: SourceEdit[] = [
    { start: template.literalNode.getStart() - start, end: template.literalNode.end - start, text: literalText(template.literalNode, value) },
  ];
  const question = template.discriminant.questionToken;
  if (question !== undefined) {
    inner.push({ start: question.getStart() - start, end: question.end - start, text: '' });
  }
  const copy = applySourceEdits(frontmatter.slice(start, template.node.end), inner);
  const separator = frontmatter.slice(before.node.end, template.node.getStart());
  const values = [...group.members.map((member) => member.value), value];
  return ok({
    frontmatter: [{ start: template.node.end, end: template.node.end, text: `${separator}${copy}` }, ...runtimeOptionEdits(syntax, group, values)],
    template: [],
  });
}

function planRenameOption(syntax: VariantSyntax, group: VariantGroupSyntax, from: string, to: string): Result<PlannedEdits> {
  const member = group.members.find((candidate) => candidate.value === from);
  if (member === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value: from }));
  }
  const valid = newOptionValue(group, to);
  if (!valid.ok) {
    return valid;
  }
  const mentions = optionMentions(syntax, group, from);
  if (mentions.fixed > 0) {
    return err(refusal('in-use', 'componentProps.variants.optionInCode', { value: from }));
  }
  const values = group.members.map((candidate) => (candidate === member ? to : candidate.value));
  return ok({
    frontmatter: [
      { start: member.literalNode.getStart(), end: member.literalNode.end, text: literalText(member.literalNode, to) },
      ...runtimeOptionEdits(syntax, group, values),
      ...mentions.frontmatter.map((literal) => ({ start: literal.start, end: literal.end, text: `${literal.quote}${to}${literal.quote}` })),
    ],
    template: mentions.template.map((literal) => ({ start: literal.start, end: literal.end, text: `${literal.quote}${to}${literal.quote}` })),
  });
}

function planRemoveOption(syntax: VariantSyntax, group: VariantGroupSyntax, value: string): Result<PlannedEdits> {
  const index = group.members.findIndex((candidate) => candidate.value === value);
  const member = group.members[index];
  if (member === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value }));
  }
  // Fewer than two options is no choice at all: the controller would stop being one.
  if (group.members.length <= 2) {
    return err(refusal('limit', 'componentProps.variants.lastOptions'));
  }
  if (member.discriminant.questionToken !== undefined) {
    return err(refusal('fallback', 'componentProps.variants.removeFallback', { value }));
  }
  const mentions = optionMentions(syntax, group, value);
  if (mentions.fixed + mentions.frontmatter.length + mentions.template.length > 0) {
    return err(refusal('in-use', 'componentProps.variants.optionInCode', { value }));
  }
  const next = group.members[index + 1];
  const previous = group.members[index - 1];
  // The first member takes the separator after it; any other, the one before.
  const range =
    previous === undefined
      ? { start: member.node.getStart(), end: next?.node.getStart() ?? member.node.end }
      : { start: previous.node.end, end: member.node.end };
  const values = group.members.filter((candidate) => candidate !== member).map((candidate) => candidate.value);
  return ok({ frontmatter: [{ ...range, text: '' }, ...runtimeOptionEdits(syntax, group, values)], template: [] });
}

function planMoveOption(syntax: VariantSyntax, group: VariantGroupSyntax, value: string, index: number): Result<PlannedEdits> {
  const from = group.members.findIndex((candidate) => candidate.value === value);
  const member = group.members[from];
  if (member === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value }));
  }
  if (index < group.members.length) {
    const order = group.members.filter((candidate) => candidate !== member);
    order.splice(index, 0, member);
    assert(order.length === group.members.length, 'planMoveOption: a move keeps every option');
    const frontmatter = syntax.document.frontmatter;
    // Each slot takes the text of the member that moves into it; separators stay where they are.
    const slots = group.members.flatMap((slot, position): readonly SourceEdit[] => {
      const moved = order[position];
      assert(moved !== undefined, 'planMoveOption: every slot is filled');
      return moved === slot ? [] : [{ start: slot.node.getStart(), end: slot.node.end, text: frontmatter.slice(moved.node.getStart(), moved.node.end) }];
    });
    return ok({
      frontmatter: [
        ...slots,
        ...runtimeOptionEdits(
          syntax,
          group,
          order.map((candidate) => candidate.value),
        ),
      ],
      template: [],
    });
  }
  return err(refusal('order', 'componentProps.variants.badIndex'));
}

function planSetFallback(syntax: VariantSyntax, group: VariantGroupSyntax, value: string): Result<PlannedEdits> {
  const member = group.members.find((candidate) => candidate.value === value);
  if (member === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value }));
  }
  const edits = group.members.flatMap((candidate) => optionalEdits(candidate.discriminant, candidate === member ? 'optional' : 'required'));
  // The destructure's default is the fallback at runtime: it follows.
  const binding = bindingOf(syntax, group.controller);
  const initial = binding?.initializer;
  if (initial !== undefined && ts.isStringLiteral(initial) && group.members.some((candidate) => candidate.value === initial.text)) {
    if (initial.text !== value) {
      edits.push({ start: initial.getStart(), end: initial.end, text: literalText(initial, value) });
    }
  }
  return ok({ frontmatter: edits, template: [] });
}

function planAddProp(syntax: VariantSyntax, group: VariantGroupSyntax, prop: string, type: string): Result<PlannedEdits> {
  const valid = validatePropertyCode(type, '');
  if (!valid.ok) {
    return valid;
  }
  const frontmatter = syntax.document.frontmatter;
  const declared = syntaxNodes(syntax.document.syntax).some((node) => ts.isPropertySignature(node) && propertyKey(node.name) === prop);
  if (declared || prop === group.controller) {
    return err(refusal('duplicate', 'props.edit.duplicate', { name: prop }));
  }
  if (syntaxNodes(syntax.document.syntax).some((node) => ts.isIdentifier(node) && node.text === prop)) {
    return err(refusal('binding', 'props.edit.nameInScope', { name: prop }));
  }
  if (group.props.length >= VARIANT_LIMITS.propsMax) {
    return err(refusal('limit', 'props.edit.limit'));
  }
  const pattern = syntax.pattern;
  if (pattern === undefined) {
    return err(refusal('binding', 'componentProps.variants.noDestructure'));
  }
  const declaration = declarationText(prop, 'optional', type);
  const edits = group.members.map((member) => insertField(frontmatter, member.literal, declaration));
  if (syntax.runtime !== undefined) {
    if (syntax.runtime.literal === undefined) {
      return err(refusal('runtime', 'componentProps.variants.noRuntimeType'));
    }
    edits.push(insertField(frontmatter, syntax.runtime.literal, declaration));
  }
  edits.push(bindingInsert(frontmatter, pattern, prop));
  return ok({ frontmatter: edits, template: [] });
}

// A prop every option shared, given this group's rules: its declaration
// leaves the shared object type, with its comment, and each option declares
// it again: as it was where it is allowed, `never` where it is not. The runtime
// type and the destructure already have it.
function planAttachProp(syntax: VariantSyntax, group: VariantGroupSyntax, prop: string, options: readonly string[]): Result<PlannedEdits> {
  const field = syntax.common.get(prop);
  if (field === undefined || group.props.includes(prop) || prop === group.controller) {
    return err(refusal('missing', 'componentProps.variants.cannotAttach', { name: prop }));
  }
  const missing = options.find((value) => !group.members.some((member) => member.value === value));
  if (missing !== undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value: missing }));
  }
  const type = field.type;
  assert(type !== undefined, 'planAttachProp: a shared prop has a type');
  if (type.kind === ts.SyntaxKind.NeverKeyword) {
    return err(refusal('type', 'componentProps.variants.noType', { name: prop }));
  }
  const frontmatter = syntax.document.frontmatter;
  const comment = memberComment(frontmatter, field);
  const documentation = comment?.kind === 'jsdoc' ? frontmatter.slice(comment.start, comment.end) : '';
  const state = field.questionToken === undefined ? 'required' : 'optional';
  const allowed = declarationText(prop, state, type.getText());
  const edits: SourceEdit[] = [{ start: field.getFullStart(), end: field.end, text: '' }];
  for (const member of group.members) {
    const declaration = options.includes(member.value) ? allowed : `${prop}?: never`;
    const documented =
      options.includes(member.value) && documentation !== '' ? documentedDeclaration(frontmatter, member.literal, documentation, declaration) : declaration;
    edits.push(insertField(frontmatter, member.literal, documented));
  }
  return ok({ frontmatter: edits, template: [] });
}

// The comment goes above the declaration on its own line in a multi-line
// object type, and before it on the same line in a one-line one.
function documentedDeclaration(frontmatter: string, literal: ts.TypeLiteralNode, documentation: string, declaration: string): string {
  const last = literal.members.at(-1);
  const multiline = frontmatter.slice(literal.getStart(), literal.end).includes('\n');
  if (multiline && last !== undefined) {
    return `${documentation}\n${lineIndent(frontmatter, last.getStart())}${declaration}`;
  }
  return `${documentation} ${declaration}`;
}

function planRemoveProp(syntax: VariantSyntax, group: VariantGroupSyntax, prop: string): Result<PlannedEdits> {
  if (!group.props.includes(prop)) {
    return err(refusal('missing', 'componentProps.variants.missingProp', { name: prop }));
  }
  const fields = group.members.flatMap((member) => {
    const field = member.fields.get(prop);
    return field === undefined ? [] : [field];
  });
  const edits: SourceEdit[] = fields.map((field) => ({ start: field.getFullStart(), end: field.end, text: '' }));
  // A prop another group also rules is still the component's: only this group lets go of it.
  const elsewhere = syntax.groups.some((other) => other !== group && (other.props.includes(prop) || other.controller === prop));
  if (elsewhere) {
    return ok({ frontmatter: edits, template: [] });
  }
  const runtime = syntax.runtime?.members.get(prop);
  if (runtime !== undefined) {
    edits.push({ start: runtime.getFullStart(), end: runtime.end, text: '' });
  }
  const binding = bindingOf(syntax, prop);
  const pattern = syntax.pattern;
  if (binding !== undefined && pattern !== undefined) {
    edits.push(bindingRemoval(pattern, binding));
    const local = binding.name.getText();
    const remaining = applySourceEdits(syntax.document.frontmatter, edits) + syntax.document.source.slice(syntax.document.end);
    // Conservative on purpose, as a prop's removal is (propertyDefinitions.ts): a false hit can be resolved in source.
    const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^\\w$])${escaped}([^\\w$]|$)`).test(remaining)) {
      return err(refusal('in-use', 'props.edit.inUse'));
    }
  }
  return ok({ frontmatter: edits, template: [] });
}

// --- Text helpers: each takes values and returns text or an edit. ---

function newOptionValue(group: VariantGroupSyntax, value: string): Result<string> {
  if (variantOptionValue(value) !== value) {
    return err(refusal('option', 'componentProps.variants.badValue'));
  }
  if (group.members.some((member) => member.value === value)) {
    return err(refusal('duplicate', 'componentProps.variants.duplicateOption', { value }));
  }
  return ok(value);
}

/** The prop's type to write where an option allows it again: the first option's that allows it, else the runtime type's. */
function propTypeOf(syntax: VariantSyntax, group: VariantGroupSyntax, prop: string): Result<string> {
  for (const member of group.members) {
    const rule = ruleOf(member, prop);
    if (rule.state !== 'forbidden') {
      return ok(rule.type);
    }
  }
  const runtime = syntax.runtime?.members.get(prop)?.type;
  if (runtime !== undefined && runtime.kind !== ts.SyntaxKind.NeverKeyword) {
    return ok(runtime.getText());
  }
  return err(refusal('type', 'componentProps.variants.noType', { name: prop }));
}

function declarationText(prop: string, state: Exclude<VariantRuleState, 'forbidden'>, type: string): string {
  return `${prop}${state === 'optional' ? '?' : ''}: ${type}`;
}

function optionalEdits(field: ts.PropertySignature, state: Exclude<VariantRuleState, 'forbidden'>): readonly SourceEdit[] {
  const question = field.questionToken;
  if (state === 'optional') {
    return question === undefined ? [{ start: field.name.end, end: field.name.end, text: '?' }] : [];
  }
  return question === undefined ? [] : [{ start: question.getStart(), end: question.end, text: '' }];
}

function typeEdit(field: ts.PropertySignature, text: string): SourceEdit {
  const type = field.type;
  assert(type !== undefined, 'typeEdit: a modelled declaration has a type');
  return { start: type.getStart(), end: type.end, text };
}

// A declaration appended to an object type, written as its last member is:
// on its own line with the same indent, or on the same line, with the same
// separator (`;` or `,`).
function insertField(frontmatter: string, literal: ts.TypeLiteralNode, declaration: string): SourceEdit {
  const last = literal.members.at(-1);
  if (last === undefined) {
    const open = literal.getStart() + 1;
    return { start: open, end: open, text: ` ${declaration} ` };
  }
  const lastText = frontmatter.slice(last.getStart(), last.end);
  const separator = lastText.endsWith(',') ? ',' : ';';
  const separated = lastText.endsWith(';') || lastText.endsWith(',');
  const multiline = frontmatter.slice(literal.getStart(), literal.end).includes('\n');
  const lead = multiline ? `\n${lineIndent(frontmatter, last.getStart())}` : ' ';
  const close = multiline || separated ? separator : '';
  return { start: last.end, end: last.end, text: `${separated ? '' : separator}${lead}${declaration}${close}` };
}

function lineIndent(text: string, position: number): string {
  const lineStart = text.lastIndexOf('\n', position - 1) + 1;
  const indent = /^[ \t]*/.exec(text.slice(lineStart, position));
  return indent?.[0] ?? '';
}

function literalText(literal: ts.StringLiteral, value: string): string {
  const quote = literal.getText().startsWith("'") ? "'" : '"';
  return `${quote}${value}${quote}`;
}

// The runtime type's controller (`variant?: "main" | "link"`) rewritten to
// the options in their new order, when it lists exactly today's options; a
// runtime type written another way (`Kind["variant"]`, `string`) already follows.
function runtimeOptionEdits(syntax: VariantSyntax, group: VariantGroupSyntax, values: readonly string[]): readonly SourceEdit[] {
  const type = syntax.runtime?.members.get(group.controller)?.type;
  if (type === undefined) {
    return [];
  }
  const parts = ts.isUnionTypeNode(type) ? [...type.types] : [type];
  const literals = parts.map((part) => stringLiteralOf(part));
  const known = literals.filter((literal): literal is ts.StringLiteral => literal !== undefined);
  if (known.length !== parts.length) {
    return [];
  }
  const current = new Set(group.members.map((member) => member.value));
  if (known.length !== current.size || !known.every((literal) => current.has(literal.text))) {
    return [];
  }
  const first = parts[0];
  const last = parts.at(-1);
  const firstLiteral = known[0];
  assert(first !== undefined, 'runtimeOptionEdits: a literal union has a first part');
  assert(last !== undefined, 'runtimeOptionEdits: a literal union has a last part');
  assert(firstLiteral !== undefined, 'runtimeOptionEdits: a literal union has a first literal');
  const second = parts[1];
  const separator = second === undefined ? ' | ' : syntax.document.frontmatter.slice(first.end, second.getStart());
  const text = values.map((value) => literalText(firstLiteral, value)).join(separator);
  return syntax.document.frontmatter.slice(first.getStart(), last.end) === text ? [] : [{ start: first.getStart(), end: last.end, text }];
}

function bindingOf(syntax: VariantSyntax, prop: string): ts.BindingElement | undefined {
  return syntax.pattern?.elements.find((element) => element.dotDotDotToken === undefined && propertyKey(element.propertyName ?? element.name) === prop);
}

// A new local in the destructure, before `...rest` or after the last one,
// separated as its neighbours are.
function bindingInsert(frontmatter: string, pattern: ts.ObjectBindingPattern, prop: string): SourceEdit {
  const elements = pattern.elements;
  const restIndex = elements.findIndex((element) => element.dotDotDotToken !== undefined);
  const rest = elements[restIndex];
  const last = elements.at(-1);
  if (last === undefined) {
    const open = pattern.getStart() + 1;
    return { start: open, end: open, text: ` ${prop} ` };
  }
  if (rest !== undefined) {
    const previous = elements[restIndex - 1];
    const gap = previous === undefined ? ', ' : frontmatter.slice(previous.end, rest.getStart()).replace(/^\s*,/, ',');
    return { start: rest.getStart(), end: rest.getStart(), text: `${prop}${gap}` };
  }
  const before = elements.at(-2);
  const gap = before === undefined ? ', ' : frontmatter.slice(before.end, last.getStart());
  return { start: last.end, end: last.end, text: `${gap}${prop}` };
}

function bindingRemoval(pattern: ts.ObjectBindingPattern, binding: ts.BindingElement): SourceEdit {
  const index = pattern.elements.indexOf(binding);
  assert(index >= 0, 'bindingRemoval: the binding is in the pattern');
  const next = pattern.elements[index + 1];
  const previous = pattern.elements[index - 1];
  return {
    start: next ? binding.getStart() : (previous?.end ?? binding.getStart()),
    end: next?.getStart() ?? binding.end,
    text: '',
  };
}

interface LiteralMention {
  readonly start: number;
  readonly end: number;
  readonly quote: string;
}

interface OptionMentions {
  /** Literals the writer can rename with the option: comparisons with the controller's local, its cases and its default. */
  readonly frontmatter: readonly LiteralMention[];
  readonly template: readonly LiteralMention[];
  /** Uses it cannot follow: object keys and property names spelled as the option. */
  readonly fixed: number;
}

// Where code outside the types names an option. Type declarations are left
// out: the union and the runtime type are edited on purpose.
function optionMentions(syntax: VariantSyntax, group: VariantGroupSyntax, value: string): OptionMentions {
  const local = bindingOf(syntax, group.controller)?.name;
  const name = local !== undefined && ts.isIdentifier(local) ? local.text : undefined;
  const frontmatter: LiteralMention[] = [];
  let fixed = 0;
  const code = syntax.document.syntax.statements.filter((statement) => !ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement));
  for (const node of code.flatMap((statement) => syntaxNodes(statement))) {
    if (ts.isStringLiteral(node) && node.text === value && name !== undefined && comparesWith(node, name)) {
      frontmatter.push({ start: node.getStart(), end: node.end, quote: node.getText().slice(0, 1) });
    } else if (isKeyNamed(node, value)) {
      fixed += 1;
    }
  }
  const template = name === undefined ? { mentions: [], fixed: 0 } : templateMentions(syntax, name, value);
  return { frontmatter, template: template.mentions, fixed: fixed + template.fixed };
}

// `local === "x"`, `"x" !== local`, `case "x":` under `switch (local)`, and
// the destructure's `local = "x"`.
function comparesWith(literal: ts.StringLiteral, local: string): boolean {
  const parent = literal.parent;
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    const comparison =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken;
    const other = parent.left === literal ? parent.right : parent.left;
    return comparison && ts.isIdentifier(other) && other.text === local;
  }
  if (ts.isCaseClause(parent)) {
    const switched = parent.parent.parent;
    return ts.isSwitchStatement(switched) && ts.isIdentifier(switched.expression) && switched.expression.text === local;
  }
  if (ts.isBindingElement(parent)) {
    return parent.initializer === literal && ts.isIdentifier(parent.name) && parent.name.text === local;
  }
  return false;
}

function isKeyNamed(node: ts.Node, value: string): boolean {
  if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isMethodDeclaration(node)) {
    return (
      propertyKey(
        ts.isShorthandPropertyAssignment(node)
          ? node.name
          : node.name.kind === ts.SyntaxKind.Identifier || ts.isStringLiteral(node.name)
            ? node.name
            : undefined,
      ) === value
    );
  }
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text === value;
  }
  if (ts.isElementAccessExpression(node)) {
    return ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === value;
  }
  return false;
}

// The template's comparisons with the controller's local (`{variant === "play" && …}`),
// found in its text with `<style>` and `<script>` blanked; and its property
// names spelled as the option (`marks.close`), which the writer cannot follow.
function templateMentions(syntax: VariantSyntax, local: string, value: string): { readonly mentions: readonly LiteralMention[]; readonly fixed: number } {
  const offset = syntax.document.end;
  const text = syntax.document.source.slice(offset).replace(/<(style|script)\b[\s\S]*?<\/\1\s*>/gi, (block) => ' '.repeat(block.length));
  const name = local.replace(/[$]/g, '\\$&');
  const option = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const comparison = '(?:===|!==|==|!=)';
  const forward = new RegExp(`(?<![\\w$.])${name}\\s*${comparison}\\s*(["'])${option}\\1`, 'g');
  const backward = new RegExp(`(["'])${option}\\1\\s*${comparison}\\s*${name}(?![\\w$])`, 'g');
  const mentions: LiteralMention[] = [];
  for (const pattern of [forward, backward]) {
    for (const match of text.matchAll(pattern)) {
      const quote = match[1];
      assert(quote !== undefined, 'templateMentions: a comparison has a quote');
      const literal = match[0].indexOf(`${quote}${value}${quote}`);
      assert(literal >= 0, 'templateMentions: the match holds the literal');
      const start = offset + match.index + literal;
      mentions.push({ start, end: start + value.length + 2, quote });
    }
  }
  const fixed = [...text.matchAll(new RegExp(`(?<![\\w$])[\\w$]+\\??\\.${option}(?![\\w$])`, 'g'))].length;
  assert(mentions.length <= text.length, 'templateMentions: mentions are bounded by the text');
  return { mentions, fixed };
}

// --- Postconditions: the source read back says what the edit asked. ---

function verifyEdit(output: string, edit: VariantRuleEdit): void {
  const group = variantGroupsOf(readVariantSyntax(readPropertySyntax(output))).find((candidate) => candidate.controller === edit.controller);
  assert(group !== undefined, 'verifyEdit: the group survives its edit');
  const values = group.options.map((option) => option.value);
  switch (edit.kind) {
    case 'setRule': {
      const index = group.props.indexOf(edit.prop);
      const rule = group.options.find((option) => option.value === edit.option)?.rules[index];
      assert(rule?.state === edit.state, 'verifyEdit: the rule reads back as set');
      return;
    }
    case 'addOption':
      assert(values.at(-1) === edit.value, 'verifyEdit: the new option is last');
      return;
    case 'renameOption':
      assert(values.includes(edit.to), 'verifyEdit: the renamed option is there');
      assert(!values.includes(edit.from), 'verifyEdit: the old name is gone');
      return;
    case 'removeOption':
      assert(!values.includes(edit.value), 'verifyEdit: the removed option is gone');
      return;
    case 'moveOption':
      assert(values.indexOf(edit.value) === edit.index, 'verifyEdit: the option moved to its index');
      return;
    case 'setFallback':
      assert(
        group.options
          .filter((option) => option.fallback)
          .map((option) => option.value)
          .join() === edit.value,
        'verifyEdit: one fallback, the one set',
      );
      return;
    case 'addProp':
      assert(group.props.includes(edit.prop), 'verifyEdit: the new prop is ruled');
      return;
    case 'removeProp':
      assert(!group.props.includes(edit.prop), 'verifyEdit: the removed prop is gone');
      return;
    case 'attachProp': {
      const index = group.props.indexOf(edit.prop);
      assert(index >= 0, 'verifyEdit: the attached prop is ruled');
      for (const option of group.options) {
        const allowed = option.rules[index]?.state !== 'forbidden';
        assert(allowed === edit.options.includes(option.value), 'verifyEdit: the prop is allowed exactly where asked');
      }
      return;
    }
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}
