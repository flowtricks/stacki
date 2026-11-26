// What the Settings panel shows for a component canvas frame, and what each of its writes stores. Pure.
//
// The panel is the ordinary one, so it is given what an instance on a page gives it: attributes that are set, and a
// schema whose defaults are what shows where nothing is set. Every value the frame is actually given is an attribute,
// shown as real text and a marked label: the scope's own (blue), a wider scope's (orange, with where it comes from:
// canvasFrameSettings.tsx provenanceExtra), the component defaults' (blue, as Set component defaults made it) and the
// canvas's sample for a required prop (blue). Only the component's own code fallback stays the field's resting default,
// unmarked, as on a page. Showing a value saves nothing: only an edit writes, to the scope. A split prop is the
// frame's own value.
//
// Writes go the other way: an attribute the panel would write into a page becomes a preview value
// (componentCanvas.ts): text, a number or on and off; an imported file under src/; or a list or object of plain data.
// Any other code has no preview value, since the canvas never runs what a field holds.
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { resolveFrame, type ComponentCanvas, type FrameEdit, type FrameEntry, type ResolvedFrame } from '../../../shared/properties/componentCanvas';
import type { ComponentRecipe } from '../../../shared/properties/componentDefaults';
import { defaultAttributes, isAssetDefaultFile, literalReferences } from '../../../shared/properties/componentDefaultValues';
import type { FieldDefinition } from '../../features/props/propRules';
import type { Attr } from '../../../shared/page/pageNodeTypes';
import { FRAME_ATTRIBUTES, previewValue, sampleValue, type ModelFrame } from '../../features/preview/componentCanvas/canvasModel';

export interface FramePanelValues {
  /** The attributes the panel shows as set: the scope's own values, and the frame's split values. */
  readonly props: Readonly<Record<string, Attr>>;
  readonly schema: readonly FieldDefinition[];
  /** The imports the panel's asset fields read the values' names from, as frontmatter. */
  readonly imports: string;
  /** Each of those names and its project file. */
  readonly bindings: ReadonlyMap<string, string>;
  /** The default slot as this scope shows it; `defaults` when its words are the component defaults' alone. */
  readonly content: { readonly html: string; readonly own: boolean; readonly given?: 'defaults' };
  /**
   * Where each value shown that the scope's own entry does not hold comes from, when that is not a wider scope (whose
   * label says so itself): the component defaults, or the canvas's sample for a required prop. Nothing at the scope
   * holds these, so nothing there resets them.
   */
  readonly givenBy: ReadonlyMap<string, GivenSource>;
}

/** Where a value the frame is given, and no scope sets, comes from. */
export type GivenSource = 'defaults' | 'sample';

export interface FramePanelInput {
  readonly schema: readonly FieldDefinition[];
  /** Whether the component passes other attributes on, so every frame may hold a class and a style. */
  readonly rest: boolean;
  readonly settings: ComponentCanvas | undefined;
  readonly frame: ModelFrame;
  /** The key edits go to: the frame's own, a split value's, or `` for every frame. */
  readonly scope: string;
  readonly defaults: ComponentRecipe;
}

// The canvas page is `.stacki/canvas/<id>.astro`, two folders below the project.
const CANVAS_TO_ROOT = '../../';

export function framePanelValues(input: FramePanelInput): FramePanelValues {
  const { schema, settings, frame, scope, defaults } = input;
  const names = new NameTable();
  const entry = settings?.frames?.[scope];
  const own = ownAttributes(schemaNames(input), entry, names);
  for (const part of frame.parts) {
    if (part.value.kind === 'value') {
      own[part.prop] = splitAttribute(
        part.value,
        schema.find((field) => field.name === part.prop),
      );
    } else {
      delete own[part.prop];
    }
  }
  const shown = resolveFrame(settings, scope);
  const fields = fieldsOf(input);
  assert(fields.length >= schema.length, 'The panel keeps every field of the component');
  const given: Record<string, Attr> = {};
  const givenBy = new Map<string, GivenSource>();
  for (const field of fields) {
    const held = Object.hasOwn(own, field.name) ? undefined : givenAttribute(field, { shown, defaults, names });
    if (held !== undefined) {
      given[field.name] = held.attribute;
      if (held.source !== 'scope') {
        givenBy.set(field.name, held.source);
      }
    }
  }
  assert(givenBy.size <= fields.length, 'A frame is given at most one value per field');
  const html = shown.content ?? defaultContent(defaults);
  return {
    props: { ...given, ...own },
    schema: fields,
    imports: names.frontmatter(),
    bindings: names.files(),
    givenBy,
    // Words the frame shows are set, wherever they come from; empty is nothing set.
    content: { html, own: entry?.content !== undefined || html !== '', ...(shown.content === undefined && html !== '' ? { given: 'defaults' as const } : {}) },
  };
}

function schemaNames(input: Pick<FramePanelInput, 'schema'>): ReadonlySet<string> {
  return new Set([...input.schema.map((field) => field.name), ...FRAME_ATTRIBUTES]);
}

// The component's fields, with a class field where the component takes one only through `...rest`.
function fieldsOf(input: Pick<FramePanelInput, 'schema' | 'rest'>): readonly FieldDefinition[] {
  if (!input.rest || input.schema.some((field) => field.name === 'class')) {
    return input.schema;
  }
  return [...input.schema, { name: 'class', type: 'string', optional: true }];
}

// The scope's own entry as attributes, written as picking each value by hand would write it.
function ownAttributes(known: ReadonlySet<string>, entry: FrameEntry | undefined, names: NameTable): Record<string, Attr> {
  // An empty text an older version stored is no value: the field shows what the frame is given instead.
  const props = Object.fromEntries(Object.entries(entry?.props ?? {}).filter(([, value]) => value !== ''));
  const values = { props, assets: entry?.assets ?? {}, literals: entry?.literals ?? {} };
  const attributes = defaultAttributes(values, (file) => names.name(file)).filter(([name]) => known.has(name));
  assert(attributes.length <= LIMITS.attrsPerNodeMax, 'A frame entry holds a bounded number of values');
  return Object.fromEntries(attributes);
}

function splitAttribute({ value }: { readonly value: string | boolean }, field: FieldDefinition | undefined): Attr {
  if (typeof value === 'boolean') {
    return { type: 'expr', value: String(value) };
  }
  return field?.numeric === true ? { type: 'expr', value } : { type: 'string', value };
}

interface Resting {
  readonly shown: ResolvedFrame;
  readonly defaults: ComponentRecipe;
  readonly names: NameTable;
}

// The value a field the scope sets nothing for is given anyway, as an attribute, and where from: a wider scope's, the
// component defaults', or the canvas's sample for a required prop; undefined where only the component's own code would
// give one.
function givenAttribute(
  field: FieldDefinition,
  { shown, defaults, names }: Resting,
): { readonly attribute: Attr; readonly source: 'scope' | GivenSource } | undefined {
  const name = field.name;
  if (shown.unset.has(name)) {
    return undefined;
  }
  for (const [source, held] of [
    ['scope', shown],
    ['defaults', defaults],
  ] as const) {
    const value = held.props?.[name];
    const asset = held.assets?.[name];
    const literal = held.literals?.[name];
    const values =
      value !== undefined
        ? { props: { [name]: value } }
        : asset !== undefined
          ? { assets: { [name]: asset } }
          : literal !== undefined
            ? { literals: { [name]: literal } }
            : undefined;
    if (values !== undefined) {
      // With the panel's own names for its files, so a list or a picture edited from here keeps its imports.
      const attribute = defaultAttributes(values, (file) => names.name(file)).find(([written]) => written === name)?.[1];
      return attribute === undefined ? undefined : { attribute, source };
    }
  }
  // What the canvas draws for a required prop nothing gives (canvasModel.ts); an element id's made-up one is not worth showing.
  const sample = field.optional === false && field.default === undefined && name !== 'id' ? sampleValue(field) : undefined;
  const attribute = sample === undefined ? undefined : defaultAttributes({ props: { [name]: sample } }, (file) => names.name(file))[0]?.[1];
  return attribute === undefined ? undefined : { attribute, source: 'sample' };
}

// The slot's markup where no scope sets it: the defaults' words, or their plain-text children. Children that are
// components have no markup here; the field then shows empty, and what is typed replaces them in the frames it covers.
function defaultContent(defaults: ComponentRecipe): string {
  if (defaults.text !== undefined) {
    return escapeText(defaults.text);
  }
  const children = defaults.children ?? [];
  const words = children.map((child) => ('literal' in child && child.verbatim === undefined ? escapeText(child.literal) : undefined));
  return words.every((word) => word !== undefined) ? words.join('') : '';
}

// Braces as entities, as a page's own writer keeps them: bare, they would read as an expression, and the content
// would open as code.
const escapeText = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;');

/** A node of the Content field's edit, as far as its markup goes. */
export interface ContentNode {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string } | undefined>> | undefined;
  readonly children?: readonly ContentNode[] | undefined;
}

const CONTENT_VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'source', 'wbr']);

/** The Content field's nodes as the slot markup a frame stores. A `{…}` chip is words: nothing on the canvas runs it. */
export function contentHTML(nodes: readonly ContentNode[]): string {
  let count = 0;
  const write = (list: readonly ContentNode[], depth: number): string => {
    assert(depth <= LIMITS.treeDepthMax, 'Content nesting is bounded');
    return list
      .map((node) => {
        count += 1;
        assert(count <= LIMITS.treeNodesMax, 'Content has a bounded number of nodes');
        if (node.kind !== 'element') {
          return escapeText(node.value ?? '');
        }
        const name = node.name ?? '';
        assert(/^[a-z][a-z0-9-]*$/.test(name), 'Content holds HTML elements');
        const attributes = Object.entries(node.props ?? {})
          .map(([key, value]) => (value?.type === 'string' ? ` ${key}="${escapeText(value.value ?? '').replaceAll('"', '&quot;')}"` : ` ${key}`))
          .join('');
        return CONTENT_VOID_TAGS.has(name) ? `<${name}${attributes}>` : `<${name}${attributes}>${write(node.children ?? [], depth + 1)}</${name}>`;
      })
      .join('');
  };
  return write(nodes, 0);
}

/**
 * Stored markup's nodes as the Content field's own reading of what was typed: it reads each `{…}` in text as an
 * expression node. Read back any other way, the field would take its own words for a change and redraw under the caret.
 */
export function contentFieldNodes<Node extends ContentNode>(nodes: readonly Node[], depth = 0): readonly ContentNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'Content nesting is bounded');
  return nodes.flatMap((node): readonly ContentNode[] => {
    if (node.kind !== 'text') {
      return [node.children === undefined ? node : { ...node, children: contentFieldNodes(node.children, depth + 1) }];
    }
    const pieces = (node.value ?? '').split(/(\{[^{}]*\})/).filter((piece) => piece !== '');
    return pieces.map((piece) => ({ kind: /^\{[^{}]*\}$/.test(piece) ? 'expr' : 'text', value: piece }));
  });
}

/**
 * What a write of `value` to the prop stores: a preview value, an imported file, literal data, or, cleared, nothing at
 * this scope. Undefined for code that has none, which the caller says rather than stores. `bindings` are the import
 * names the panel gave the project files (FramePanelValues.bindings).
 */
export function frameEditOf(name: string, value: Attr | undefined, bindings: ReadonlyMap<string, string>): FrameEdit | undefined {
  // A field emptied says nothing at this scope: what a wider scope or the defaults give shows again, never an empty value.
  if (value === undefined || (value.type === 'string' && value.value === '')) {
    return { kind: 'inherit', name };
  }
  const preview = previewValue(value);
  if (preview !== undefined) {
    return { kind: 'prop', name, value: preview };
  }
  if (value.type !== 'expr') {
    return undefined;
  }
  const source = value.value.trim();
  const named = /^([A-Za-z_$][\w$]*)(\.src)?$/.exec(source);
  const file = named === null ? undefined : bindings.get(named[1] ?? '');
  if (file !== undefined) {
    return { kind: 'asset', name, asset: named?.[2] === undefined ? { file } : { file, url: true } };
  }
  const references = literalReferences(source, new Set(bindings.keys()));
  if (references === undefined) {
    return undefined;
  }
  if (references.length === 0) {
    return { kind: 'literal', name, literal: source };
  }
  const imports = Object.fromEntries(references.map((reference) => [reference.name, bindings.get(reference.name) ?? '']));
  return { kind: 'literal', name, literal: { source, imports } };
}

/** A picked project file as a prop's write: a URL for public/, else an import of the file under src/. */
export function framePickEdit(name: string, picked: { readonly rel: string; readonly root: string }, reference: 'url' | 'module'): FrameEdit | undefined {
  if (picked.root !== 'src') {
    return { kind: 'prop', name, value: '/' + picked.rel.split('/').slice(1).join('/') };
  }
  if (!isAssetDefaultFile(picked.rel)) {
    return undefined;
  }
  return { kind: 'asset', name, asset: reference === 'url' ? { file: picked.rel, url: true } : { file: picked.rel } };
}

// The names the panel's expressions import project files by. Kept per render: each file has one name.
class NameTable {
  private readonly held = new Map<string, string>();

  name(file: string): string {
    const existing = this.held.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const name = `frameAsset${String(this.held.size)}`;
    this.held.set(file, name);
    assert(this.held.size <= LIMITS.attrsPerNodeMax, 'A frame names a bounded number of files');
    return name;
  }

  frontmatter(): string {
    return [...this.held].map(([file, name]) => `import ${name} from ${JSON.stringify(CANVAS_TO_ROOT + file)};`).join('\n');
  }

  files(): ReadonlyMap<string, string> {
    return new Map([...this.held].map(([file, name]) => [name, file]));
  }
}
