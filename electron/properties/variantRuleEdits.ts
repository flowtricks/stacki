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
import type { VariantRuleEdit, VariantRuleState, VisibilityRule } from '../../shared/properties/variantRules';
import { applySourceEdits, propertyKey, readPropertySyntax, replaceFrontmatter, syntaxError, syntaxNodes, validatePropertyCode } from './propertySyntax';
import type { SourceEdit } from './propertySyntax';
import { memberComment } from './propertyMemberEdits';
import { literalValueOf, propsInterfaceAsAlias, readVariantSyntax, ruleOf, stringLiteralOf, variantGroupsOf } from './variantRuleModel';
import type { ControllerLiteral, VariantCandidateSyntax, VariantGroupSyntax, VariantSyntax } from './variantRuleModel';
import { indentUnitOf } from '../../shared/core/indent';
import { editVariantDefaultTable } from './variantDefaults';
import { memberEdits } from './propertyMemberEdits';
import type { DeclaredFields } from './propertyMemberEdits';

/** Frontmatter edits are offsets into the frontmatter; template edits, into the whole source. */
interface PlannedEdits {
  readonly frontmatter: readonly SourceEdit[];
  readonly template: readonly SourceEdit[];
}

const NO_EDITS: PlannedEdits = { frontmatter: [], template: [] };

/** The source with `edit` applied, the same source when it changes nothing, or why it cannot be applied. */
export function editVariantRules(source: string, edit: VariantRuleEdit): Result<string> {
  return editVariantRulesAt(source, edit, 0);
}

// An edit may first rewrite the shape it works on (an interface to a type, a
// shared member split) or be made of others (a controller switch), and applies
// itself again to the result: `depth` counts those steps, which never nest past a few.
function editVariantRulesAt(source: string, edit: VariantRuleEdit, depth: number): Result<string> {
  assert(depth <= VARIANT_LIMITS.editDepthMax, 'editVariantRules: an edit applies itself again a bounded number of times');
  if (edit.kind === 'switchController') {
    return switchController(source, { from: edit.controller, to: edit.to, prop: edit.prop }, depth);
  }
  if (edit.kind === 'setVisibility') {
    return setVisibility(source, edit.prop, edit.rules, depth);
  }
  if (edit.kind === 'setDefaultTable') {
    // A default table is keyed by any prop, a controller or not: it is the table's edit, not a group's.
    return editVariantDefaultTable(source, edit.controller, edit.prop, edit.entries);
  }
  const document = readPropertySyntax(source);
  const syntax = readVariantSyntax(document);
  const group = syntax.groups.find((candidate) => candidate.controller === edit.controller);
  const candidate = syntax.candidates.find((item) => item.controller === edit.controller);
  if (group === undefined && candidate !== undefined && edit.kind === 'attachProp' && syntax.propsInterface !== undefined) {
    // The first group of a component whose props are an interface: the interface becomes a type, in the same write.
    const aliased = replaceFrontmatter(document, applySourceEdits(document.frontmatter, propsInterfaceAsAlias(document.frontmatter, syntax.propsInterface)));
    assert(readVariantSyntax(readPropertySyntax(aliased)).props !== undefined, 'editVariantRules: the interface reads back as a type');
    return editVariantRulesAt(aliased, edit, depth + 1);
  }
  if (group === undefined && (candidate === undefined || edit.kind !== 'attachProp')) {
    return err(refusal('missing', 'componentProps.variants.missingGroup', { name: edit.controller }));
  }
  if (group?.reason !== undefined) {
    return err(refusal('restricted', 'componentProps.variants.readOnly', { name: edit.controller }));
  }
  if (group?.members.some((member) => member.shared) === true) {
    // A member of several options cannot take a rule for one of them: each gets its own member first, in the same write.
    const split = splitSharedMembers(syntax, group);
    if (!split.ok) {
      return split;
    }
    const regrouped = readVariantSyntax(readPropertySyntax(split.value)).groups.find((candidate) => candidate.controller === edit.controller);
    assert(regrouped !== undefined, 'editVariantRules: the group survives its split');
    assert(!regrouped.members.some((member) => member.shared), 'editVariantRules: a split leaves one option per member');
    const after = editVariantRulesAt(split.value, edit, depth + 1);
    // An edit that changes nothing leaves the source as it was, unsplit.
    return after.ok && after.value === split.value ? ok(source) : after;
  }
  const planned =
    group === undefined && candidate !== undefined && edit.kind === 'attachProp'
      ? planCreateGroup(syntax, candidate, edit.prop, edit.options)
      : planGroupEdit(syntax, group, edit);
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

// Each member that names several options (`variant: "month" | "day"`) becomes
// one member per option: the first keeps the member (and its `?`), the rest
// are copies after it, joined by the union's own separator, without the `?`.
// The types it accepts are the same; only the shape is spelled out.
function splitSharedMembers(syntax: VariantSyntax, group: VariantGroupSyntax): Result<string> {
  const frontmatter = syntax.document.frontmatter;
  const edits: SourceEdit[] = [];
  const nodes = group.members.filter((member) => member.shared).filter((member) => member.firstOfMember);
  assert(nodes.length <= VARIANT_LIMITS.optionsMax, 'splitSharedMembers: the members are bounded');
  for (const member of nodes) {
    const type = member.discriminant.type;
    assert(type !== undefined, 'splitSharedMembers: a shared member has a controller type');
    assert(ts.isUnionTypeNode(type), 'splitSharedMembers: a shared member names a union of options');
    const index = group.union.types.indexOf(member.node);
    assert(index >= 0, 'splitSharedMembers: the member is in its union');
    const next = group.union.types[index + 1];
    const previous = group.union.types[index - 1];
    const separator =
      next !== undefined
        ? frontmatter.slice(member.node.end, next.getStart())
        : previous !== undefined
          ? frontmatter.slice(previous.end, member.node.getStart())
          : ' | ';
    const start = member.node.getStart();
    const text = frontmatter.slice(start, member.node.end);
    const question = member.discriminant.questionToken;
    const literals = type.types.map((literal) => literal.getText());
    const [first, ...rest] = literals;
    assert(first !== undefined, 'splitSharedMembers: a union has a first option');
    const copy = (literal: string): string => {
      const typeEdit = { start: type.getStart() - start, end: type.end - start, text: literal };
      const questionEdit = question === undefined ? [] : [{ start: question.getStart() - start, end: question.end - start, text: '' }];
      return applySourceEdits(text, [typeEdit, ...questionEdit]);
    };
    edits.push({ start: type.getStart(), end: type.end, text: first });
    edits.push({ start: member.node.end, end: member.node.end, text: rest.map((literal) => `${separator}${copy(literal)}`).join('') });
  }
  const written = applySourceEdits(frontmatter, edits);
  const error = syntaxError(written);
  if (error !== undefined) {
    return err({ code: 'syntax', message: error });
  }
  return ok(replaceFrontmatter(syntax.document, written));
}

function planGroupEdit(syntax: VariantSyntax, group: VariantGroupSyntax | undefined, edit: VariantRuleEdit): Result<PlannedEdits> {
  assert(group !== undefined, 'planGroupEdit: an edit to an existing group has the group');
  return planEdit(syntax, group, edit);
}

// A prop's rules moved from one controller to another, as one write: let go
// of the first, then join the second. Where the two controllers share option
// names (a `size` and a `density` both with `small`), each shared option keeps
// the state it had; with none in common the prop is allowed for every option.
function switchController(source: string, change: { readonly from: string; readonly to: string; readonly prop: string }, depth: number): Result<string> {
  const { from, to, prop } = change;
  if (from === to) {
    return ok(source);
  }
  const before = variantGroupsOf(readVariantSyntax(readPropertySyntax(source))).find((group) => group.controller === from);
  const index = before?.props.indexOf(prop) ?? -1;
  const states = new Map(before?.options.map((option) => [option.value, option.rules[index]?.state ?? 'optional'] as const) ?? []);
  const detached = editVariantRulesAt(source, { kind: 'detachProp', controller: from, prop }, depth + 1);
  if (!detached.ok) {
    return detached;
  }
  const target = variantGroupsOf(readVariantSyntax(readPropertySyntax(detached.value))).find((group) => group.controller === to);
  if (target === undefined) {
    return err(refusal('missing', 'componentProps.variants.missingGroup', { name: to }));
  }
  const values = target.options.map((option) => option.value);
  const shared = values.filter((value) => states.has(value));
  const allowed = shared.length === 0 ? values : values.filter((value) => !states.has(value) || states.get(value) !== 'forbidden');
  if (allowed.length === 0) {
    return err(refusal('restricted', 'componentProps.variants.switchForbidsAll', { name: to }));
  }
  const attached = editVariantRulesAt(detached.value, { kind: 'attachProp', controller: to, prop, options: allowed }, depth + 1);
  if (!attached.ok) {
    return attached;
  }
  // Required where it was required: one more pass over the same text, still one write and one undo.
  let output = attached.value;
  const required = shared.filter((value) => states.get(value) === 'required');
  assert(required.length <= VARIANT_LIMITS.optionsMax, 'switchController: the options are bounded');
  for (const option of required) {
    const set = editVariantRulesAt(output, { kind: 'setRule', controller: to, option, prop, state: 'required' }, depth + 1);
    if (!set.ok) {
      return set;
    }
    output = set.value;
  }
  assert(output !== source, 'switchController: a switch changes the source');
  return ok(output);
}

// A prop's whole Visibility as one write: let go of every controller the
// Visibility no longer names, join the new ones (allowed where the rule does
// not forbid it), then set each option's state where it differs. Each step is
// one of the edits above, applied to the text the step before it wrote.
function setVisibility(source: string, prop: string, rules: readonly VisibilityRule[], depth: number): Result<string> {
  assert(rules.length <= VARIANT_LIMITS.groupsMax, 'setVisibility: the rules are bounded');
  const ruling = (text: string) =>
    variantGroupsOf(readVariantSyntax(readPropertySyntax(text))).filter((group) => group.editing.kind !== 'candidate' && group.props.includes(prop));
  let output = source;
  const step = (edit: VariantRuleEdit): Result<string> => {
    const next = editVariantRulesAt(output, edit, depth + 1);
    if (next.ok) {
      output = next.value;
    }
    return next;
  };
  const wanted = new Set(rules.map((rule) => rule.controller));
  for (const group of ruling(source)) {
    if (!wanted.has(group.controller)) {
      const detached = step({ kind: 'detachProp', controller: group.controller, prop });
      if (!detached.ok) {
        return detached;
      }
    }
  }
  for (const rule of rules) {
    const allowed = rule.states.filter((entry) => entry.state !== 'forbidden').map((entry) => entry.option);
    if (allowed.length === 0) {
      return err(refusal('restricted', 'componentProps.variants.switchForbidsAll', { name: rule.controller }));
    }
    if (!ruling(output).some((group) => group.controller === rule.controller)) {
      const attached = step({ kind: 'attachProp', controller: rule.controller, prop, options: allowed });
      if (!attached.ok) {
        return attached;
      }
    }
    for (const entry of rule.states) {
      const set = step({ kind: 'setRule', controller: rule.controller, option: entry.option, prop, state: entry.state });
      if (!set.ok) {
        return set;
      }
    }
  }
  verifyVisibility(output, prop, rules);
  return ok(output);
}

function verifyVisibility(output: string, prop: string, rules: readonly VisibilityRule[]): void {
  const groups = variantGroupsOf(readVariantSyntax(readPropertySyntax(output))).filter(
    (group) => group.editing.kind !== 'candidate' && group.props.includes(prop),
  );
  assert(groups.length === rules.length, 'verifyVisibility: exactly the named controllers rule the prop');
  for (const rule of rules) {
    const group = groups.find((candidate) => candidate.controller === rule.controller);
    assert(group !== undefined, 'verifyVisibility: each named controller rules the prop');
    const index = group.props.indexOf(prop);
    for (const entry of rule.states) {
      assert(
        group.options.find((option) => option.value === entry.option)?.rules[index]?.state === entry.state,
        'verifyVisibility: each state reads back as set',
      );
    }
  }
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
    case 'detachProp':
      return planDetachProp(syntax, group, edit.prop);
    case 'setRuleType':
      return planRuleDeclarations(syntax, group, edit.prop, edit.options, { type: edit.type });
    case 'setRuleDescription':
      return planRuleDeclarations(syntax, group, edit.prop, edit.options, { description: edit.description });
    case 'setRuleDescriptions':
      return planRuleDescriptions(syntax, group, edit.prop, edit.entries);
    case 'switchController':
      throw new Error('Assertion failed: a controller switch is two edits, applied before planning');
    case 'setDefaultTable':
      throw new Error('Assertion failed: a default table is written before planning');
    case 'setVisibility':
      throw new Error('Assertion failed: a Visibility is written as its steps, before planning');
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
  const current = ruleOf(member, prop, syntax.inherited);
  if (current.state === state) {
    return ok(NO_EDITS);
  }
  const frontmatter = syntax.document.frontmatter;
  const field = member.fields.get(prop);
  if (state === 'forbidden') {
    if (field === undefined) {
      // Allowed only by the shared declaration (`Base & (A | B)`): the member's own `never` takes it away.
      assert(syntax.inherited.has(prop), 'planSetRule: an allowed prop the member does not name is shared');
      return ok({ frontmatter: [insertField(frontmatter, member.literal, `${prop}?: never`)], template: [] });
    }
    return ok({ frontmatter: [...optionalEdits(field, 'optional'), typeEdit(field, 'never')], template: [] });
  }
  const type = propTypeOf(syntax, group, prop);
  if (!type.ok) {
    return type;
  }
  // A shared requirement holds in every member: one option cannot make it optional again.
  const shared = syntax.inherited.get(prop);
  if (state === 'optional' && shared !== undefined) {
    if (shared.questionToken === undefined) {
      return err(refusal('shape', 'componentProps.variants.cannotGroup'));
    }
  }
  if (field === undefined) {
    return ok({ frontmatter: [insertField(frontmatter, member.literal, declarationText(prop, state, type.value))], template: [] });
  }
  // A prop already allowed keeps its own type; one that was `never` takes the prop's.
  const retyped = current.state === 'forbidden' ? [typeEdit(field, type.value)] : [];
  return ok({ frontmatter: [...optionalEdits(field, state), ...retyped], template: [] });
}

// The prop's declaration in each of `options` given another type or tooltip,
// by the same member edit a save makes (propertyMemberEdits.ts): only the type,
// or only the doc comment, changes; nothing else in the member moves.
function planRuleDeclarations(
  syntax: VariantSyntax,
  group: VariantGroupSyntax,
  prop: string,
  options: readonly string[],
  change: Pick<DeclaredFields, 'type'> | Pick<DeclaredFields, 'description'>,
): Result<PlannedEdits> {
  if (!group.props.includes(prop)) {
    return err(refusal('missing', 'componentProps.variants.missingProp', { name: prop }));
  }
  if ('type' in change) {
    const valid = validatePropertyCode(change.type, '');
    if (!valid.ok) {
      return valid;
    }
  }
  const frontmatter = syntax.document.frontmatter;
  const edits: SourceEdit[] = [];
  const written = new Set<ts.PropertySignature>();
  for (const option of options) {
    const member = group.members.find((candidate) => candidate.value === option);
    if (member === undefined) {
      return err(refusal('missing', 'componentProps.variants.missingOption', { value: option }));
    }
    // An option that inherits the prop is changed where it is declared: the shared declaration, once for all who share it.
    const field = member.fields.get(prop) ?? syntax.inherited.get(prop);
    const rule = ruleOf(member, prop, syntax.inherited);
    if (field === undefined || rule.state === 'forbidden') {
      return err(refusal('restricted', 'componentProps.variants.notAllowedThere', { name: prop, value: option }));
    }
    if (!written.has(field)) {
      written.add(field);
      const previous: DeclaredFields = { name: prop, type: rule.type, required: rule.state === 'required', readonly: false, description: rule.description };
      edits.push(...memberEdits(frontmatter, field, previous, { ...previous, ...change }));
    }
  }
  assert(written.size <= options.length, 'planRuleDeclarations: one declaration per option at most');
  assert(edits.length <= options.length * 2, 'planRuleDeclarations: at most a head and a type per option');
  return ok({ frontmatter: edits, template: [] });
}

// Each option's own tooltip, in one plan: each declaration's doc comment, as setRuleDescription writes one.
function planRuleDescriptions(
  syntax: VariantSyntax,
  group: VariantGroupSyntax,
  prop: string,
  entries: readonly { readonly option: string; readonly description: string }[],
): Result<PlannedEdits> {
  assert(entries.length <= VARIANT_LIMITS.optionsMax, 'planRuleDescriptions: the entries are bounded');
  const edits: SourceEdit[] = [];
  for (const entry of entries) {
    const planned = planRuleDeclarations(syntax, group, prop, [entry.option], { description: entry.description });
    if (!planned.ok) {
      return planned;
    }
    for (const edit of planned.value.frontmatter) {
      // Options that inherit the prop share one declaration: the same comment is written once; two different ones cannot be.
      const same = edits.find((other) => other.start === edit.start && other.end === edit.end);
      if (same === undefined) {
        edits.push(edit);
      } else if (same.text !== edit.text) {
        return err(refusal('restricted', 'componentProps.variants.notAllowedThere', { name: prop, value: entry.option }));
      }
    }
  }
  assert(edits.length <= entries.length, 'planRuleDescriptions: one comment edit per option at most');
  return ok({ frontmatter: edits, template: [] });
}

function planAddOption(syntax: VariantSyntax, group: VariantGroupSyntax, value: string): Result<PlannedEdits> {
  if (booleanGroup(group)) {
    return err(refusal('option', 'componentProps.variants.booleanOptions', { name: group.controller }));
  }
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
  if (booleanGroup(group)) {
    return err(refusal('option', 'componentProps.variants.booleanOptions', { name: group.controller }));
  }
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
  if (booleanGroup(group)) {
    return err(refusal('option', 'componentProps.variants.booleanOptions', { name: group.controller }));
  }
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
  const current = initial === undefined ? undefined : literalValueOf(initial);
  if (initial !== undefined && current !== undefined && current !== value && group.members.some((candidate) => candidate.value === current)) {
    edits.push({ start: initial.getStart(), end: initial.end, text: ts.isStringLiteral(initial) ? literalText(initial, value) : value });
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
  if (group.props.includes(prop) || prop === group.controller) {
    return err(refusal('missing', 'componentProps.variants.cannotAttach', { name: prop }));
  }
  const source = attachedSource(syntax, group.controller, prop);
  if (!source.ok) {
    return source;
  }
  const missing = options.find((value) => !group.members.some((member) => member.value === value));
  if (missing !== undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value: missing }));
  }
  const frontmatter = syntax.document.frontmatter;
  const { declaration: allowed, documentation, shared } = source.value;
  const edits: SourceEdit[] = shared === undefined ? [] : [{ start: shared.getFullStart(), end: shared.end, text: '' }];
  for (const member of group.members) {
    const declaration = options.includes(member.value) ? allowed : `${prop}?: never`;
    const documented =
      options.includes(member.value) && documentation !== '' ? documentedDeclaration(frontmatter, member.literal, documentation, declaration) : declaration;
    edits.push(insertField(frontmatter, member.literal, documented));
  }
  return ok({ frontmatter: edits, template: [] });
}

interface AttachedSource {
  /** The prop's declaration where an option allows it. */
  readonly declaration: string;
  /** Its JSDoc, or ''. */
  readonly documentation: string;
  /** Its declaration in the shared object type, which leaves it; undefined when another group rules it and keeps doing so. */
  readonly shared: ts.PropertySignature | undefined;
}

// What a prop brings to a group it joins: from the shared object type, its
// declaration as written; from another group (both rules then hold, AND), the
// type its first allowing option gives it. A controller never joins one: a
// prop that picks another's options would make a cycle.
function attachedSource(syntax: VariantSyntax, controller: string, prop: string): Result<AttachedSource> {
  const frontmatter = syntax.document.frontmatter;
  if (syntax.groups.some((group) => group.controller === prop)) {
    return err(refusal('missing', 'componentProps.variants.cannotAttach', { name: prop }));
  }
  const field = syntax.common.get(prop);
  if (field?.type !== undefined) {
    if (field.type.kind === ts.SyntaxKind.NeverKeyword) {
      return err(refusal('type', 'componentProps.variants.noType', { name: prop }));
    }
    const comment = memberComment(frontmatter, field);
    return ok({
      declaration: declarationText(prop, field.questionToken === undefined ? 'required' : 'optional', field.type.getText()),
      documentation: comment?.kind === 'jsdoc' ? frontmatter.slice(comment.start, comment.end) : '',
      shared: field,
    });
  }
  const other = syntax.groups.find((group) => group.controller !== controller && group.reason === undefined && group.props.includes(prop));
  if (other === undefined) {
    return err(refusal('missing', 'componentProps.variants.cannotAttach', { name: prop }));
  }
  const type = propTypeOf(syntax, other, prop);
  if (!type.ok) {
    return type;
  }
  const allowedFields = other.members
    .map((member) => member.fields.get(prop))
    .filter((item) => item?.type !== undefined && item.type.kind !== ts.SyntaxKind.NeverKeyword);
  const first = allowedFields[0];
  const comment = first === undefined ? undefined : memberComment(frontmatter, first);
  return ok({
    declaration: declarationText(prop, 'optional', type.value),
    documentation: comment?.kind === 'jsdoc' ? frontmatter.slice(comment.start, comment.end) : '',
    shared: undefined,
  });
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

// A shared prop and a shared string-options prop become a group: both leave
// the shared object type, and `Props` is intersected with a union, one member
// per option, keyed by the controller; the prop is allowed where picked.
function planCreateGroup(syntax: VariantSyntax, candidate: VariantCandidateSyntax, prop: string, options: readonly string[]): Result<PlannedEdits> {
  const props = syntax.props;
  if (prop === candidate.controller) {
    return err(refusal('missing', 'componentProps.variants.cannotAttach', { name: prop }));
  }
  const source = attachedSource(syntax, candidate.controller, prop);
  if (!source.ok) {
    return source;
  }
  if (props === undefined || !(ts.isTypeLiteralNode(props.type) || ts.isIntersectionTypeNode(props.type) || ts.isTypeReferenceNode(props.type))) {
    return err(refusal('shape', 'componentProps.variants.cannotGroup'));
  }
  const missing = options.find((value) => !candidate.values.includes(value));
  if (missing !== undefined) {
    return err(refusal('missing', 'componentProps.variants.missingOption', { value: missing }));
  }
  const frontmatter = syntax.document.frontmatter;
  const unit = indentUnitOf(frontmatter);
  const spelling = candidate.spelling;
  const controllerDocumentation = candidate.field === undefined ? '' : inlineDocumentation(frontmatter, candidate.field);
  const propDocumentation = source.value.documentation === '' ? '' : `${source.value.documentation.replace(/\s*\n\s*\*?\s*/g, ' ')} `;
  const members = candidate.values.map((value) => {
    const literal = spelling.kind === 'string' ? `${spelling.quote}${value}${spelling.quote}` : value;
    const key = `${controllerDocumentation}${candidate.controller}${value === candidate.fallback ? '?' : ''}: ${literal}`;
    const own = options.includes(value) ? `${propDocumentation}${source.value.declaration}` : `${prop}?: never`;
    return `${unit}| { ${key}; ${own} }`;
  });
  assert(members.length === candidate.values.length, 'planCreateGroup: one member per option');
  const removals = [candidate.field, source.value.shared].flatMap((field) =>
    field === undefined ? [] : [{ start: field.getFullStart(), end: field.end, text: '' }],
  );
  return ok({
    frontmatter: [...removals, { start: props.type.end, end: props.type.end, text: ` & (\n${members.join('\n')}\n)` }].sort(
      (first, second) => first.start - second.start,
    ),
    template: [],
  });
}

// A member's JSDoc as one line before a declaration, or nothing.
function inlineDocumentation(frontmatter: string, field: ts.PropertySignature): string {
  const comment = memberComment(frontmatter, field);
  if (comment?.kind !== 'jsdoc') {
    return '';
  }
  return `${frontmatter.slice(comment.start, comment.end).replace(/\s*\n\s*\*?\s*/g, ' ')} `;
}

// A ruled prop given back to every option: its declarations leave the
// members, and it is declared once in the shared object type (one is added
// to `Props` when there is none), Required only if every option required it,
// with the first allowing option's type and comment.
function planDetachProp(syntax: VariantSyntax, group: VariantGroupSyntax, prop: string): Result<PlannedEdits> {
  if (!group.props.includes(prop)) {
    return err(refusal('missing', 'componentProps.variants.missingProp', { name: prop }));
  }
  const type = propTypeOf(syntax, group, prop);
  if (!type.ok) {
    return type;
  }
  const rules = group.members.map((member) => ruleOf(member, prop, syntax.inherited));
  const state = rules.every((rule) => rule.state === 'required') ? 'required' : 'optional';
  const frontmatter = syntax.document.frontmatter;
  const source = group.members.map((member) => member.fields.get(prop)).find((field) => field !== undefined && field.type?.kind !== ts.SyntaxKind.NeverKeyword);
  const comment = source === undefined ? undefined : memberComment(frontmatter, source);
  const documentation = comment?.kind === 'jsdoc' ? frontmatter.slice(comment.start, comment.end) : '';
  const declaration = declarationText(prop, state, type.value);
  const edits: SourceEdit[] = group.members.flatMap((member) => {
    const field = member.fields.get(prop);
    return field === undefined ? [] : [{ start: field.getFullStart(), end: field.end, text: '' }];
  });
  // Another group still rules it: only this one lets go.
  const elsewhere = syntax.groups.some((other) => other !== group && other.props.includes(prop));
  const literal = syntax.commonLiterals[0];
  if (elsewhere) {
    assert(edits.length > 0, 'planDetachProp: a ruled prop has declarations to remove');
  } else if (syntax.inherited.has(prop)) {
    // Already declared outside the union (`Base & (A | B)`): the members' own declarations go, the shared one stays.
    assert(edits.length > 0, 'planDetachProp: a ruled prop has declarations to remove');
  } else if (literal !== undefined) {
    edits.push(insertField(frontmatter, literal, documentation === '' ? declaration : documentedDeclaration(frontmatter, literal, documentation, declaration)));
  } else if (syntax.props !== undefined) {
    const start = syntax.props.type.getStart();
    edits.push({ start, end: start, text: `{ ${documentation === '' ? '' : `${documentation} `}${declaration} } & ` });
  } else {
    return err(refusal('shape', 'componentProps.variants.cannotGroup'));
  }
  return ok({ frontmatter: edits, template: [] });
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

// A true/false controller has exactly those two options: none is added, renamed or removed.
function booleanGroup(group: VariantGroupSyntax): boolean {
  return group.members.some((member) => !ts.isStringLiteral(member.literalNode));
}

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
    const rule = ruleOf(member, prop, syntax.inherited);
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

function literalText(literal: ControllerLiteral, value: string): string {
  if (!ts.isStringLiteral(literal)) {
    return value;
  }
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
  if (edit.kind === 'setVisibility') {
    verifyVisibility(output, edit.prop, edit.rules);
    return;
  }
  const controller = edit.controller;
  const group = variantGroupsOf(readVariantSyntax(readPropertySyntax(output))).find((candidate) => candidate.controller === controller);
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
    case 'switchController':
    case 'setDefaultTable':
      return;
    case 'setRuleDescriptions': {
      const index = group.props.indexOf(edit.prop);
      for (const entry of edit.entries) {
        const rule = group.options.find((option) => option.value === entry.option)?.rules[index];
        assert(rule !== undefined, 'verifyEdit: the option still rules the prop');
        assert(rule.description === entry.description.trim(), 'verifyEdit: each tooltip reads back as set');
      }
      return;
    }
    case 'setRuleType':
    case 'setRuleDescription': {
      const index = group.props.indexOf(edit.prop);
      for (const value of edit.options) {
        const rule = group.options.find((option) => option.value === value)?.rules[index];
        assert(rule !== undefined, 'verifyEdit: the option still rules the prop');
        if (edit.kind === 'setRuleType') {
          assert(rule.type === edit.type.trim(), 'verifyEdit: the type reads back as set');
        } else {
          assert(rule.description === edit.description.trim(), 'verifyEdit: the tooltip reads back as set');
        }
      }
      return;
    }
    case 'detachProp':
      assert(!group.props.includes(edit.prop), 'verifyEdit: the detached prop is no longer ruled');
      assert(group.attachable.includes(edit.prop), 'verifyEdit: the detached prop is shared again');
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
