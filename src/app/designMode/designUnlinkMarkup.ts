// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the markup a component instance is unlinked into.
//
// Unlinking is Figma's "detach": the instance becomes the plain elements it renders, with the props and slot content
// it has now. The page as the dev server renders it (read with its markers, designLiveCanvas.ts requestPageHtml) is
// the truth this works from, because what a component renders depends on code (its frontmatter, conditions, loops,
// computed classes) that only rendering can answer. Every element the instance draws carries the paths of the nodes
// it stands for (`data-avb-p`, electron/parse/astroSerializeMarked.ts), which says, for each part of the output:
//
// - **Slot content the page wrote** (a path below the instance's): written back as the page's own source, so a
//   component placed in the slot stays that component and its expressions stay expressions.
// - **A component the component's template places** (a path in the component's file that names a component node):
//   kept as that component when every prop and child it is given can be written in the page (a literal, a prop of
//   the instance, the instance's slot content), else written out as what it renders.
// - **Anything else**: the element as rendered, every attribute it has (its classes, and the `data-astro-cid-*`
//   attributes that make the component's scoped styles apply to it), its text escaped for Astro.
//
// What cannot be written as plain markup is refused, never approximated: a script, a style or a framework island in
// the output, a picture at an address only the dev server answers, slot content drawn twice. The caller renders the
// result and compares it with this rendering before keeping it (designUnlinkCheck.ts), so a case this file gets wrong
// is refused there too.
import type { Attr, PageNode } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { err, ok, type Result } from '../../../shared/core/result';

export type UnlinkRefusal = 'not-rendered' | 'script' | 'inline-style' | 'island' | 'picture' | 'slot-twice' | 'unsupported';

/** A prop the component's frontmatter takes from `Astro.props`: the name it is passed by, and its default's source. */
export interface PropBinding {
  readonly key: string;
  readonly fallback: string | undefined;
}

export interface UnlinkComponent {
  /** Project-relative, as its markers name it (`src/components/Card.astro`). */
  readonly file: string;
  readonly nodes: readonly PageNode[];
  /** Each local name the frontmatter binds from `Astro.props` with `const`, and what it is bound to. */
  readonly bindings: ReadonlyMap<string, PropBinding>;
}

/** One child of the instance in the page: its source with its `slot` attribute taken out, and that slot's name. */
export interface SlotChild {
  readonly source: string;
  readonly slot: string | undefined;
  readonly blank: boolean;
}

export interface UnlinkInput {
  readonly document: Document;
  readonly instancePath: string;
  readonly instanceProps: Readonly<Record<string, Attr>>;
  /** By index; undefined for a child that cannot be written outside the instance. */
  readonly children: readonly (SlotChild | undefined)[];
  readonly component: UnlinkComponent;
  /** The tag a component the component's file imports is written as in the page, or undefined when it cannot be. */
  readonly tagFor: (name: string) => string | undefined;
}

export interface UnlinkMarkup {
  readonly markup: string;
  /** The components of the component's file the markup keeps, by the name that file imports them under. */
  readonly kept: ReadonlySet<string>;
}

/** The attribute every marked element carries (electron/preload/frameRegions.ts PATH_ATTR). */
const PATH_ATTRIBUTE = 'data-avb-p';
/** Elements and text nodes one unlink may write: past this the output is not something to inline. */
const OUTPUT_NODES_MAX = 20_000;
const MARKS_MAX = 64;
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Attribute names Astro reads as its own directives: never written from rendered output. */
const DIRECTIVE = /^(client|server|set|is|class|define|transition):/;
const ATTRIBUTE_NAME = /^[A-Za-z_][\w.:-]*$/;
/** Where a dev server serves a picture it made or a file of the project: valid only while it runs. */
const DEV_ADDRESS = /(^|[\s,("'])\/(_image\?|@fs\/|@id\/|src\/|node_modules\/)/;
const ADDRESS_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'srcset', 'href', 'poster', 'data', 'xlink:href', 'style', 'data-src', 'data-srcset']);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const LITERAL = /^(-?\d+(\.\d+)?|true|false|null|undefined|"[^"\\\n]*"|'[^'\\\n]*')$/;

/** The markup instance `input.instancePath` renders, written as the page's own source; or why it cannot be. */
export function unlinkMarkup(input: UnlinkInput): Result<UnlinkMarkup, UnlinkRefusal> {
  assert(input.instancePath.length > 0, 'unlinkMarkup: an instance has a path');
  assert(!input.instancePath.includes('|'), 'unlinkMarkup: the instance is a node of the page');
  const region = instanceRegion(input.document, input.instancePath);
  if (region === undefined) {
    return err('not-rendered');
  }
  const writer = new MarkupWriter(input, pageCidOf(input.document));
  const written = writer.nodes(region);
  if (!written.ok) {
    return written;
  }
  if (written.value.trim().length === 0) {
    return err('not-rendered');
  }
  assert(writer.count <= OUTPUT_NODES_MAX, 'unlinkMarkup: the output stays within its bound');
  return ok({ markup: written.value, kept: writer.kept });
}

/** The marks an element carries: the paths of the nodes it stands for. */
export function marksOf(element: Element): readonly string[] {
  return (element.getAttribute(PATH_ATTRIBUTE) ?? '')
    .split(' ')
    .filter((mark) => mark.length > 0)
    .slice(0, MARKS_MAX);
}

/**
 * The run of sibling nodes instance `path` renders: between its marker comments where they survived, else from the
 * first to the last outermost element marked with it (a component that renders its slot to a string drops every
 * comment inside, which is most of a Lumos page). Undefined when nothing on the page is the instance's.
 */
export function instanceRegion(document: Document, path: string): readonly ChildNode[] | undefined {
  const byComments = commentRegion(document, path);
  if (byComments !== undefined) {
    return byComments;
  }
  const marked = [...document.querySelectorAll(`[${PATH_ATTRIBUTE}]`)].filter((element) => marksOf(element).includes(path));
  const roots = marked.filter((element) => !marked.some((other) => other !== element && other.contains(element)));
  const first = roots[0];
  const last = roots[roots.length - 1];
  if (first === undefined || last === undefined) {
    return undefined;
  }
  const parent = first.parentNode;
  if (parent === null || roots.some((root) => root.parentNode !== parent)) {
    return undefined;
  }
  const siblings = [...parent.childNodes];
  const run = siblings.slice(siblings.indexOf(first), siblings.indexOf(last) + 1);
  // Between two of its roots, an element that is not one of them is another node's.
  const strangers = run.filter((node) => isElement(node) && !roots.some((root) => root === node));
  return strangers.length === 0 ? run : undefined;
}

function commentRegion(document: Document, path: string): readonly ChildNode[] | undefined {
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */);
  const starts: Comment[] = [];
  const ends: Comment[] = [];
  for (let node = walker.nextNode(); node !== null && starts.length <= 1 && ends.length <= 1; node = walker.nextNode()) {
    if (isComment(node) && node.data === `avb-s:${path}`) {
      starts.push(node);
    } else if (isComment(node) && node.data === `avb-e:${path}`) {
      ends.push(node);
    }
  }
  const [start] = starts;
  const [end] = ends;
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    start === undefined ||
    end === undefined ||
    start.parentNode !== end.parentNode ||
    start.parentNode === null
  ) {
    return undefined;
  }
  const siblings = [...start.parentNode.childNodes];
  const from = siblings.indexOf(start);
  const to = siblings.indexOf(end);
  return from < to ? siblings.slice(from + 1, to) : undefined;
}

/**
 * The page's own scope attribute (`data-astro-cid-…` of its `<style>`), read off an element only the page wrote: the
 * page adds it to every element it writes, so the unlinked markup must not carry it written out a second time.
 */
function pageCidOf(document: Document): string | undefined {
  for (const element of [...document.querySelectorAll(`[${PATH_ATTRIBUTE}]`)].slice(0, OUTPUT_NODES_MAX)) {
    const marks = marksOf(element);
    if (marks.length > 0 && marks.every((mark) => !mark.includes('|'))) {
      const cid = [...element.attributes].find((attribute) => attribute.name.startsWith('data-astro-cid-'));
      if (cid !== undefined) {
        return cid.name;
      }
    }
  }
  return undefined;
}

/** Whether a node of the template is drawn once or by a loop, whose own variables may shadow a prop's name. */
type Repeat = 'once' | 'looped';

/** What a run of written output last was: slot content or a kept component may stand for several rendered roots. */
type Trail = { readonly kind: 'none' } | { readonly kind: 'child'; readonly index: number } | { readonly kind: 'kept'; readonly path: string };

class MarkupWriter {
  readonly kept = new Set<string>();
  count = 0;
  private readonly writtenChildren = new Set<number>();
  private readonly writtenKept = new Set<string>();
  private trail: Trail = { kind: 'none' };
  private readonly namespace: string;

  constructor(
    private readonly input: UnlinkInput,
    private readonly pageCid: string | undefined,
  ) {
    this.namespace = `${input.component.file}|`;
  }

  nodes(list: readonly ChildNode[]): Result<string, UnlinkRefusal> {
    let out = '';
    for (const node of list) {
      this.count += 1;
      if (this.count > OUTPUT_NODES_MAX) {
        return err('unsupported');
      }
      const written = this.node(node);
      if (!written.ok) {
        return written;
      }
      out += written.value;
    }
    return ok(out);
  }

  private node(node: ChildNode): Result<string, UnlinkRefusal> {
    if (isText(node)) {
      if (node.data.trim().length > 0) {
        this.trail = { kind: 'none' };
      }
      return ok(escapeText(node.data));
    }
    if (isComment(node)) {
      // The editor's markers are its own; a comment the site wrote stays.
      return ok(node.data.startsWith('avb-') || node.data.includes('--') ? '' : `<!--${node.data}-->`);
    }
    if (!isElement(node)) {
      return ok('');
    }
    const marks = marksOf(node);
    const child = this.childIndexOf(marks);
    if (child !== undefined) {
      return this.slotChild(child);
    }
    const placed = this.placedComponent(marks);
    if (placed !== undefined) {
      const kept = this.keptComponent(placed, node);
      if (kept !== undefined) {
        return kept;
      }
    }
    this.trail = { kind: 'none' };
    return this.element(node);
  }

  /** The index of the instance's child an element is (part of), from its marks. */
  private childIndexOf(marks: readonly string[]): number | undefined {
    const prefix = `${this.input.instancePath}.`;
    for (const mark of marks) {
      if (!mark.includes('|') && mark.startsWith(prefix)) {
        const index = Number(mark.slice(prefix.length).split('.')[0]);
        if (Number.isSafeInteger(index) && index >= 0) {
          return index;
        }
      }
    }
    return undefined;
  }

  private slotChild(index: number): Result<string, UnlinkRefusal> {
    if (this.writtenChildren.has(index)) {
      // Another root of the same child, right after the first: already written with it.
      if (this.trail.kind === 'child' && this.trail.index === index) {
        return ok('');
      }
      return err('slot-twice');
    }
    const child = this.input.children[index];
    if (child === undefined) {
      return err('unsupported');
    }
    this.writtenChildren.add(index);
    this.trail = { kind: 'child', index };
    return ok(child.source);
  }

  /** The component node of the component's own template an element is the root of, with its path, if any. */
  private placedComponent(marks: readonly string[]): { readonly path: string; readonly node: PageNode; readonly inLoop: boolean } | undefined {
    for (const mark of marks) {
      if (mark.startsWith(this.namespace)) {
        const path = mark.slice(this.namespace.length);
        const found = nodeAtPath(this.input.component.nodes, path);
        if (found !== undefined && found.node.kind === 'component') {
          return { path, node: found.node, inLoop: found.inLoop };
        }
      }
    }
    return undefined;
  }

  private keptComponent(
    placed: { readonly path: string; readonly node: PageNode; readonly inLoop: boolean },
    root: Element,
  ): Result<string, UnlinkRefusal> | undefined {
    if (this.writtenKept.has(placed.path)) {
      return this.trail.kind === 'kept' && this.trail.path === placed.path ? ok('') : undefined;
    }
    const tag = this.keptTag(placed, root);
    if (tag === undefined) {
      return undefined;
    }
    this.writtenKept.add(placed.path);
    for (const index of tag.children) {
      this.writtenChildren.add(index);
    }
    if (placed.node.kind === 'component') {
      this.kept.add(placed.node.name);
    }
    this.trail = { kind: 'kept', path: placed.path };
    return ok(tag.source);
  }

  /** A nested component written as itself: its tag with every prop and child as the page can write them, or undefined. */
  private keptTag(
    placed: { readonly node: PageNode; readonly inLoop: boolean },
    root: Element,
  ): { readonly source: string; readonly children: readonly number[] } | undefined {
    const node = placed.node;
    if (node.kind !== 'component' || node.dynamicTag === true || node.name === 'Fragment') {
      return undefined;
    }
    const tag = this.input.tagFor(node.name);
    if (tag === undefined) {
      return undefined;
    }
    const repeat: Repeat = placed.inLoop ? 'looped' : 'once';
    let props = '';
    for (const name of node.attrOrder ?? Object.keys(node.props ?? {})) {
      const attr = node.props?.[name];
      if (attr === undefined) {
        continue;
      }
      const written = this.propSource(name, attr, repeat);
      if (written === undefined) {
        return undefined;
      }
      props += written;
    }
    // The component's own scope, which Astro passes to every component its template places: kept as it was passed.
    for (const attribute of [...root.attributes]) {
      if (
        attribute.name.startsWith('data-astro-cid-') &&
        attribute.value === 'true' &&
        attribute.name !== this.pageCid &&
        !props.includes(` ${attribute.name}`)
      ) {
        props += ` ${attribute.name}`;
      }
    }
    if (node.children === undefined) {
      return { source: `<${tag}${props} />`, children: [] };
    }
    const children: number[] = [];
    let inner = '';
    for (const child of node.children) {
      const written = this.childSource(child, repeat, children);
      if (written === undefined) {
        return undefined;
      }
      inner += written;
    }
    return { source: `<${tag}${props}>${inner}</${tag}>`, children };
  }

  /** One prop of a kept component, as the page writes it (a leading space included), or undefined when it can't be. */
  private propSource(name: string, attr: Attr, repeat: Repeat): string | undefined {
    if (!ATTRIBUTE_NAME.test(name)) {
      return undefined;
    }
    switch (attr.type) {
      case 'bare':
        return ` ${name}`;
      case 'string':
        return quoted(name, attr.value);
      case 'spread':
        return undefined;
      case 'expr': {
        const value = attr.value.trim();
        if (LITERAL.test(value)) {
          return ` ${name}={${value}}`;
        }
        const passed = this.passedValue(value, repeat);
        if (passed === undefined) {
          return undefined;
        }
        switch (passed.kind) {
          case 'absent':
            return '';
          case 'bare':
            return ` ${name}`;
          case 'string':
            return quoted(name, passed.value);
          case 'expr':
            return ` ${name}={${passed.value}}`;
          default: {
            const exhaustive: never = passed;
            return exhaustive;
          }
        }
      }
      default: {
        const exhaustive: never = attr;
        return exhaustive;
      }
    }
  }

  /** One child of a kept component, as the page writes it, or undefined. Slot content it places is noted in `children`. */
  private childSource(child: PageNode, repeat: Repeat, children: number[]): string | undefined {
    switch (child.kind) {
      case 'text':
        return child.value;
      case 'comment':
        return child.jsx === true ? '' : `<!--${child.value}-->`;
      case 'expr': {
        // An expression node is read with its braces.
        const written = child.value.trim();
        if (!written.startsWith('{') || !written.endsWith('}')) {
          return undefined;
        }
        const value = written.slice(1, -1).trim();
        const passed = this.passedValue(value, repeat);
        if (passed === undefined) {
          return LITERAL.test(value) ? `{${value}}` : undefined;
        }
        switch (passed.kind) {
          case 'absent':
            return '';
          case 'bare':
            return '{true}';
          case 'string':
            return sourceText(passed.value);
          case 'expr':
            return `{${passed.value}}`;
          default: {
            const exhaustive: never = passed;
            return exhaustive;
          }
        }
      }
      case 'element':
        return child.name === 'slot' ? this.slotSource(child, children) : undefined;
      case 'component':
      case 'raw':
      case 'raw-line':
      case 'map':
      case 'cond':
      case 'branch':
      case 'chunk-group':
        return undefined;
      default: {
        const exhaustive: never = child;
        return exhaustive;
      }
    }
  }

  /** A `<slot>` the component passes on: the instance's content for that slot, or undefined when it has none to give. */
  private slotSource(slot: PageNode, children: number[]): string | undefined {
    if (slot.kind !== 'element') {
      return undefined;
    }
    const nameAttr = slot.props?.['name'];
    if (nameAttr !== undefined && nameAttr.type !== 'string') {
      return undefined;
    }
    const name = nameAttr?.value;
    const given = this.input.children.flatMap((child, index) => (child !== undefined && child.slot === name ? [{ child, index }] : []));
    if (given.every(({ child }) => child.blank)) {
      // The slot's fallback is the component's own markup: written as it renders instead.
      return (slot.children ?? []).length === 0 ? '' : undefined;
    }
    let out = '';
    for (const { child, index } of given) {
      if (this.writtenChildren.has(index) || children.includes(index)) {
        return undefined;
      }
      children.push(index);
      out += child.source;
    }
    return out;
  }

  /** What an expression of the component's template is, when it is one of its props as the instance passes it. */
  private passedValue(
    expression: string,
    repeat: Repeat,
  ):
    | { readonly kind: 'absent' }
    | { readonly kind: 'bare' }
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'expr'; readonly value: string }
    | undefined {
    // A loop's own variables may shadow a prop's name.
    if (repeat === 'looped' || !IDENTIFIER.test(expression)) {
      return undefined;
    }
    const binding = this.input.component.bindings.get(expression);
    if (binding === undefined) {
      return undefined;
    }
    const props = this.input.instanceProps;
    if (Object.values(props).some((attr) => attr.type === 'spread')) {
      return undefined;
    }
    const attr = Object.hasOwn(props, binding.key) ? props[binding.key] : undefined;
    if (attr === undefined) {
      if (binding.fallback === undefined) {
        return { kind: 'absent' };
      }
      return LITERAL.test(binding.fallback) ? { kind: 'expr', value: binding.fallback } : undefined;
    }
    switch (attr.type) {
      case 'bare':
        return { kind: 'bare' };
      case 'string':
        return { kind: 'string', value: attr.value };
      case 'expr':
        return { kind: 'expr', value: attr.value };
      case 'spread':
        return undefined;
      default: {
        const exhaustive: never = attr;
        return exhaustive;
      }
    }
  }

  private element(element: Element): Result<string, UnlinkRefusal> {
    const tag = element.localName;
    const refused = refusalForTag(element);
    if (refused !== undefined) {
      return err(refused);
    }
    let attributes = '';
    for (const attribute of [...element.attributes]) {
      const name = attribute.name;
      if (name.startsWith('data-avb-') || name.startsWith('data-astro-source-') || name === this.pageCid) {
        continue;
      }
      if (!ATTRIBUTE_NAME.test(name) || DIRECTIVE.test(name)) {
        return err('unsupported');
      }
      if (ADDRESS_ATTRIBUTES.has(name) && DEV_ADDRESS.test(attribute.value)) {
        return err('picture');
      }
      attributes += attribute.value === '' ? ` ${name}` : quotedRendered(name, attribute.value);
    }
    if (VOID_ELEMENTS.has(tag)) {
      return ok(`<${tag}${attributes} />`);
    }
    const content = isTemplate(element) ? [...element.content.childNodes] : [...element.childNodes];
    const inner = this.nodes(content);
    if (!inner.ok) {
      return inner;
    }
    return ok(`<${tag}${attributes}>${inner.value}</${tag}>`);
  }
}

function refusalForTag(element: Element): UnlinkRefusal | undefined {
  const tag = element.localName;
  if (tag === 'script') {
    return 'script';
  }
  if (tag === 'style' || (tag === 'link' && /\bstylesheet\b/i.test(element.getAttribute('rel') ?? ''))) {
    return 'inline-style';
  }
  if (tag.startsWith('astro-')) {
    return 'island';
  }
  return undefined;
}

/** The node at a marker path of a template (`0.2.1`), and whether a loop holds it; undefined for a path it lacks. */
export function nodeAtPath(nodes: readonly PageNode[], path: string): { readonly node: PageNode; readonly inLoop: boolean } | undefined {
  const steps = path.split('.').map(Number);
  if (steps.length > LIMITS.treeDepthMax || steps.some((step) => !Number.isSafeInteger(step) || step < 0)) {
    return undefined;
  }
  let list: readonly PageNode[] = nodes;
  let found: PageNode | undefined;
  let inLoop = false;
  for (const step of steps) {
    if (found?.kind === 'map') {
      inLoop = true;
    }
    found = list[step];
    if (found === undefined) {
      return undefined;
    }
    list = 'children' in found && Array.isArray(found.children) ? found.children : [];
  }
  return found === undefined ? undefined : { node: found, inLoop };
}

/** Text as Astro source: markup characters and the braces that open an expression written as references. */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

/** A value from the page's source, in quotes as it was written (its entities still entities), or undefined. */
function quoted(name: string, value: string): string | undefined {
  if (!value.includes('"')) {
    return ` ${name}="${value}"`;
  }
  return value.includes("'") ? undefined : ` ${name}='${value}'`;
}

/** A rendered value, escaped into quotes. */
function quotedRendered(name: string, value: string): string {
  return ` ${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
}

/** A value from the page's source (an attribute's text, its entities already written as entities), as text. */
function sourceText(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
}

const isText = (node: Node): node is Text => node.nodeType === 3;
const isComment = (node: Node): node is Comment => node.nodeType === 8;
const isElement = (node: Node): node is Element => node.nodeType === 1;
const isTemplate = (element: Element): element is HTMLTemplateElement => element.localName === 'template' && 'content' in element;
