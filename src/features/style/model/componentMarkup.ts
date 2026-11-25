// Whether a selector's classes and attributes are written in the open component's
// markup, which is what makes its chip green in the selector well.
//
// Green means "this comes with the component": inside `ContentWrapper.astro`,
// `<div class="layout theme-dark">` writes `layout` and `theme-dark` into every
// instance, so `.layout` and `.theme-dark` are the component's, wherever their CSS
// lives. A class the page passes in (`class={className}`) is not written there, and
// neither is anything on a page, so those chips are never green by this rule. The
// stylesheet that holds the rule (`fromComponent`) decides where an edit is saved,
// not the chip's colour. For an instance selected on a page the classes are decided
// from the instance side (instanceMarkupOf), since a component often computes them
// (`text-style-${variant}`) where no literal can be read.

import { assert } from '../../../../shared/core/assert';
import { compileSelectorList, type AttrCond, type CompiledSelector, type Compound } from './selectorParse';

/**
 * At most this many attributes are read from one element's markup. A real element
 * carries a handful; the cap keeps a generated element from costing a scan.
 */
export const COMPONENT_MARKUP_ATTRIBUTES_MAX = 256;

/**
 * At most this many related elements (ancestors, earlier siblings) are followed for
 * one compound of a selector. The component's own tree bounds them; the cap keeps a
 * generated tree from costing a scan.
 */
export const COMPONENT_MARKUP_RELATED_MAX = 1024;

/**
 * What the selected element's own node in the open component file writes: its
 * literal classes (`class`, `class:list`, without what an instance passes) and its
 * other attributes, each with its literal value, or undefined for an expression.
 * `parent` and `previous` are the element's parent and previous sibling in the same
 * component, written the same way; absent where the component ends (its root has
 * no parent here: what wraps it is the page's or another component's markup).
 */
export type ComponentMarkup = {
  readonly classes: readonly string[];
  readonly attributes: ReadonlyMap<string, string | undefined>;
  readonly parent?: ComponentMarkup | undefined;
  readonly previous?: ComponentMarkup | undefined;
};

/**
 * True when every part of the selector that says where it is applied is applied
 * inside the component, and there is at least one such part. Every compound counts,
 * across combinators: in `.container > [class]` the parent's `.container` decides,
 * and when the parent is outside the component (the page, the parent component) the
 * selector is applied from outside. The parts that say where are classes, ids and
 * attributes compared with a value; a tag, `*`, a pseudo or a presence-only
 * attribute (`[class]`, `[data-x]`, set from either side alike) says nothing, so it
 * never makes a chip green on its own. In a list every member must qualify. False
 * without a component (undefined markup) and for text that does not parse.
 */
export function writtenInMarkup(selector: string, markup: ComponentMarkup | undefined): boolean {
  if (markup === undefined) {
    return false;
  }
  assert(markup.attributes.size <= COMPONENT_MARKUP_ATTRIBUTES_MAX, 'writtenInMarkup: the markup attributes are capped');
  const members = compileSelectorList(selector);
  if (members.length === 0) {
    return false;
  }
  const written = members.every((member) => memberWritten(member, markup));
  assert(!written || members.length > 0, 'writtenInMarkup: a written selector has a member');
  return written;
}

/** The selected element's markup, read from its node's props, capped. */
export function componentMarkupOf(input: {
  readonly classes: readonly string[];
  readonly props: Readonly<Record<string, { readonly type: string; readonly value?: string }>> | undefined;
  readonly parent?: ComponentMarkup | undefined;
  readonly previous?: ComponentMarkup | undefined;
}): ComponentMarkup {
  const attributes = new Map<string, string | undefined>();
  for (const [name, attribute] of Object.entries(input.props ?? {})) {
    if (attributes.size < COMPONENT_MARKUP_ATTRIBUTES_MAX) {
      // Classes are read from `classes`, which already holds the literal ones only;
      // a directive (`class:list`, `set:html`) is not an attribute of the element.
      if (name !== 'class' && !name.includes(':')) {
        attributes.set(name.toLowerCase(), attribute.type === 'string' ? String(attribute.value ?? '') : undefined);
      }
    } else {
      break;
    }
  }
  assert(attributes.size <= COMPONENT_MARKUP_ATTRIBUTES_MAX, 'componentMarkupOf: bounded by COMPONENT_MARKUP_ATTRIBUTES_MAX');
  assert(!attributes.has('class'), 'componentMarkupOf: classes are kept apart from attributes');
  return { classes: [...input.classes], attributes, parent: input.parent, previous: input.previous };
}

/** At most this many rendered classes are read for an instance. A real element carries a handful. */
export const INSTANCE_RENDERED_CLASSES_MAX = 256;

/** An Astro prop as the page model holds it: a string, an expression, or bare. */
type MarkupProp = { readonly type: string; readonly value?: string };

/**
 * What a component instance selected on a page renders with from inside its
 * component, decided from the instance side. The usage site says exactly what the
 * instance passes in (`<Heading variant="display" class="margin-block-8">`), and the
 * canvas reports every class the rendered element carries, so every rendered class
 * the instance did not pass was applied inside the component, however the component
 * builds it: a literal, a `class:list` entry, a `text-style-${variant}` template or a
 * variant map. A class the component writes straight from a prop's value
 * (`class:list={["button", variant]}` with `variant="primary"`) is the instance's,
 * because the instance named it.
 *
 * `passed` is the instance tag's own class tokens (`class`, `class:list`). `root` is
 * the component's root element when its source could be read (templateRoot.ts): it
 * gives the attributes the component writes, and the classes when the rendered list
 * cannot be trusted to split: none reported yet, or the instance passes a class
 * expression whose value is not known here (`class={extra}`). Undefined when nothing
 * is known about the instance's rendering.
 */
export function instanceMarkupOf(input: {
  readonly props: Readonly<Record<string, MarkupProp>> | undefined;
  readonly passed: readonly string[];
  readonly rendered: readonly string[];
  readonly root: { readonly classes: readonly string[]; readonly props: Readonly<Record<string, MarkupProp>> | undefined } | undefined;
}): ComponentMarkup | undefined {
  const rendered = input.rendered.slice(0, INSTANCE_RENDERED_CLASSES_MAX);
  const props = Object.entries(input.props ?? {}).slice(0, COMPONENT_MARKUP_ATTRIBUTES_MAX);
  const passed = new Set(input.passed);
  for (const [name, prop] of props) {
    // A string prop whose value is itself a rendered class (`variant="primary"` into
    // `class:list={[variant]}`) put that class there. A computed one (`text-style-display`
    // from `variant="display"`) is the component's: its markup built the name.
    if (prop.type === 'string' && !name.includes(':')) {
      for (const token of String(prop.value ?? '').split(/\s+/)) {
        if (token.length > 0 && rendered.includes(token)) {
          passed.add(token);
        }
      }
    }
  }
  const unknown = props.some(([name, prop]) => prop.type === 'expr' && name.toLowerCase().includes('class') && !literalOnly(String(prop.value ?? '')));
  const rootProps = Object.fromEntries(Object.entries(input.root?.props ?? {}).filter(([name]) => input.props?.[name] === undefined));
  if (rendered.length > 0 && !unknown) {
    const classes = [...new Set(rendered.filter((name) => name.length > 0 && !passed.has(name)))];
    assert(
      classes.every((name) => !passed.has(name)),
      'instanceMarkupOf: a class the instance passed is never inside',
    );
    return componentMarkupOf({ classes, props: rootProps });
  }
  if (input.root === undefined) {
    return undefined;
  }
  // Without a trustworthy split, only what the component's root spells out is its own.
  const classes = input.root.classes.filter((name) => !passed.has(name));
  assert(classes.length <= input.root.classes.length, 'instanceMarkupOf: a filter never adds');
  return componentMarkupOf({ classes, props: rootProps });
}

/**
 * Whether a class expression holds only literals (`["a", 'b c']`), so the tokens
 * read from it are all it can add. Anything else (an identifier, a `${}` hole, a
 * condition) may add classes nobody can read from the source.
 */
function literalOnly(expression: string): boolean {
  const stripped = expression.replace(/(["'])[^"'`]*\1/g, '').replace(/`[^`$]*`/g, '');
  assert(stripped.length <= expression.length, 'literalOnly: stripping never adds');
  return /^[\s[\],]*$/.test(stripped);
}

/** Markup that writes nothing, against which a compound shows whether it says where it is applied. */
const NO_MARKUP: ComponentMarkup = { classes: [], attributes: new Map() };

/**
 * Whether one member is applied inside: its subject against the element, then each
 * compound to the left against the elements its combinator reaches (right to left,
 * as a browser matches). A compound that says where it is applied must be written
 * on one of those elements in this component; the elements it was found on are
 * where the next compound is looked for. A compound that says nothing only moves
 * along. Past the component's edge nothing is inside, so a compound there that
 * says where is applied from outside.
 */
function memberWritten(member: CompiledSelector, markup: ComponentMarkup): boolean {
  const subject = member.compounds[member.compounds.length - 1];
  if (subject === undefined) {
    return false;
  }
  const own = compoundNeeds(subject, markup);
  if (own === 'missing') {
    return false;
  }
  let inside = own === 'written';
  let candidates: readonly ComponentMarkup[] = [markup];
  // combinators[index] joins compounds[index] to the compound after it (selectorParse).
  assert(member.combinators.length === member.compounds.length - 1, 'memberWritten: one combinator between each two compounds');
  for (let index = member.compounds.length - 2; index >= 0; index -= 1) {
    const compound = member.compounds[index];
    assert(compound !== undefined, 'memberWritten: the compound is in range');
    const reached = relatedMarkup(candidates, member.combinators[index] ?? ' ');
    if (compoundNeeds(compound, NO_MARKUP) === 'missing') {
      const matched = reached.filter((candidate) => compoundNeeds(compound, candidate) === 'written');
      if (matched.length === 0) {
        return false;
      }
      inside = true;
      candidates = matched;
    } else {
      candidates = reached;
    }
  }
  assert(candidates.length <= COMPONENT_MARKUP_RELATED_MAX, 'memberWritten: the candidates are capped');
  return inside;
}

/** The elements a combinator reaches from any of `from`, within the component, capped. */
function relatedMarkup(from: readonly ComponentMarkup[], combinator: string): ComponentMarkup[] {
  const reached = new Set<ComponentMarkup>();
  const step = combinator === '+' || combinator === '~' ? 'previous' : 'parent';
  const repeat = combinator === ' ' || combinator === '~';
  for (const start of from) {
    let next = start[step];
    while (next !== undefined && reached.size < COMPONENT_MARKUP_RELATED_MAX) {
      reached.add(next);
      next = repeat ? next[step] : undefined;
    }
  }
  assert(reached.size <= COMPONENT_MARKUP_RELATED_MAX, 'relatedMarkup: bounded by COMPONENT_MARKUP_RELATED_MAX');
  assert(!reached.has(NO_MARKUP), 'relatedMarkup: the empty markup is never related');
  return [...reached];
}

type Needs = 'nothing' | 'written' | 'missing';

/**
 * What a compound asks of the element's markup: nothing, everything it names
 * written, or a name the markup lacks. `:not()` asks for nothing to be present.
 * `:is()` and `:where()` are followed one level: an alternative that nests another
 * group is not read, and counts as missing, the honest answer for markup this did
 * not check. One level covers the well's selectors without recursion.
 */
function compoundNeeds(compound: Compound, markup: ComponentMarkup): Needs {
  const own = namesNeeds(compound, markup);
  if (own === 'missing') {
    return 'missing';
  }
  let named = own === 'written';
  for (const group of compound.requireAny) {
    // One alternative of `:is(.image, .video)` is enough.
    const answers = group.map((alternative): Needs => {
      const subject = alternative.compounds[alternative.compounds.length - 1];
      if (subject === undefined) {
        return 'missing';
      }
      return subject.requireAny.length === 0 ? namesNeeds(subject, markup) : 'missing';
    });
    if (answers.includes('written')) {
      named = true;
    } else if (!answers.includes('nothing')) {
      return 'missing';
    }
  }
  assert(compound.requireAny.length > 0 || named === (own === 'written'), 'compoundNeeds: without groups the names decide');
  return named ? 'written' : 'nothing';
}

/** The compound's own classes, attributes and id, against the markup. */
function namesNeeds(compound: Compound, markup: ComponentMarkup): Needs {
  // A presence-only attribute (`[class]`) says nothing about where it was set.
  const valued = compound.attrs.filter((attribute) => attribute.operator !== undefined && attribute.value !== undefined);
  const named = compound.classes.length + valued.length + (compound.id === undefined ? 0 : 1);
  if (!compound.classes.every((name) => markup.classes.includes(name))) {
    return 'missing';
  }
  if (!valued.every((attribute) => attributeWritten(attribute, markup))) {
    return 'missing';
  }
  if (compound.id !== undefined) {
    if (markup.attributes.get('id') !== compound.id) {
      return 'missing';
    }
  }
  assert(named >= 0, 'namesNeeds: a count is never negative');
  return named > 0 ? 'written' : 'nothing';
}

/** Whether the markup writes an attribute the way the selector asks for it. */
function attributeWritten(attribute: AttrCond, markup: ComponentMarkup): boolean {
  const name = attribute.name.toLowerCase();
  const value = name === 'class' ? (markup.classes.length > 0 ? markup.classes.join(' ') : undefined) : markup.attributes.get(name);
  // Presence-only attributes are neutral (namesNeeds), so only a compared value is asked.
  assert(attribute.operator !== undefined, 'attributeWritten: the attribute is compared');
  assert(attribute.value !== undefined, 'attributeWritten: the attribute has a value');
  if (value === undefined) {
    return false;
  }
  const actual = attribute.insensitive ? value.toLowerCase() : value;
  const wanted = attribute.insensitive ? attribute.value.toLowerCase() : attribute.value;
  switch (attribute.operator) {
    case '=':
      return actual === wanted;
    case '~=':
      return actual.split(/\s+/).includes(wanted);
    case '|=':
      return actual === wanted || actual.startsWith(`${wanted}-`);
    case '^=':
      return wanted.length > 0 && actual.startsWith(wanted);
    case '$=':
      return wanted.length > 0 && actual.endsWith(wanted);
    case '*=':
      return wanted.length > 0 && actual.includes(wanted);
    default:
      return false;
  }
}
