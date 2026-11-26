// The canvas page: one temporary page in `.stacki/canvas/` (the folder the defaults canvas already uses, served by the
// same preview route in Desktop and Studio and excluded from git) that renders the component once per frame. Each
// instance is the component's insertion defaults (`.stacki/components.json`, else the starter defaults) with the
// frame's props over them, so slots and required props show what an inserted instance would.
//
// The editor opens this page with each instance closed, and the component's own file when one is opened inside; the
// page itself is never edited (src/app/state/appHistory.ts refuses it), only rewritten whole when frames or preview
// values change. Nothing here is written to the component or its instances.
import { assert } from '../../../../shared/core/assert';
import { encodeText } from '../../../../shared/page/htmlText';
import { PREVIEW_UNMARKED_ATTRIBUTE } from '../../../../shared/page/previewToken';
import { starterDefaults } from '../../../../shared/properties/componentStarterDefaults';
import {
  componentFile,
  DEFAULT_LIMITS,
  resolveComponentRecipe,
  type ComponentDefaults,
  type ComponentRecipe,
  type DefaultValue,
  type DefaultsSnapshot,
  type ResolvedNode,
} from '../../../../shared/properties/componentDefaults';
import {
  defaultAttributes,
  elementMarkup,
  mergeDefaultValues,
  withoutMissingAssets,
  type AssetDefaults,
  type LiteralDefaults,
} from '../../../../shared/properties/componentDefaultValues';
import type { CanvasArrangement, FrameLength } from '../../../../shared/properties/componentCanvas';
import { CANVAS_ARRANGEMENTS, CANVAS_LIMITS, DEFAULT_ARRANGEMENT } from '../../../../shared/properties/componentCanvas';
import { chromeScript, chromeStyles } from './canvasChrome';
import type { CanvasBox, CanvasInstance } from './componentCanvasSession';

/** A group box as the page draws it (canvasGroups.ts), its header already in words. */
export type CanvasPageItem =
  | { readonly kind: 'frame'; readonly key: string; readonly caption: string }
  | { readonly kind: 'group'; readonly key: string; readonly header: string; readonly children: readonly CanvasPageItem[] };

export interface CanvasPageFrame {
  readonly key: string;
  readonly label: string;
  readonly row: number;
  readonly props: Readonly<Record<string, DefaultValue>>;
  readonly assets?: AssetDefaults;
  readonly literals?: LiteralDefaults;
  /** The default slot's markup, in place of the insertion defaults' content; `` is an empty slot. */
  readonly content?: string | undefined;
  readonly omitted: ReadonlySet<string>;
  readonly width: FrameLength;
  readonly height: FrameLength;
  readonly background: string | undefined;
}

export interface CanvasPageInput {
  /** The page's UUID: its file is `.stacki/canvas/<id>.astro`. */
  readonly id: string;
  readonly component: string;
  /** The text a component with a default slot and no insertion content shows (its own name). */
  readonly fallbackText: string;
  readonly theme: 'light' | 'dark';
  /** The project's canvas background, when it sets one (componentCanvas.ts ComponentCanvasFile.background). */
  readonly surface?: string | undefined;
  /** Classes the canvas root (the page's <html>) carries after the layout's own (componentCanvas.ts CanvasRoot). */
  readonly rootClasses?: readonly string[];
  readonly snapshot: DefaultsSnapshot;
  readonly frames: readonly CanvasPageFrame[];
  /** How the frames are grouped into boxes; absent: no boxes, the frames in their rows. */
  readonly groups?: readonly CanvasPageItem[];
  /** How the frames (and groups) that sit together are laid out; absent: side by side (DEFAULT_ARRANGEMENT). */
  readonly arrange?: CanvasArrangement;
}

// The page's <body> is the canvas's world (panned and zoomed by its script, canvasChrome.ts): chrome, unmarked, so the
// editor never names it, and a click between frames is the page's root, <html>. The page has nothing else of its own
// but the frames, one element each around its instance.
const UNMARKED = PREVIEW_UNMARKED_ATTRIBUTE;

export function canvasPageSource(input: CanvasPageInput): string {
  assert(/^[a-f0-9-]{36}$/.test(input.id), 'A canvas page is named by a UUID');
  assert(input.frames.length > 0, 'A canvas page draws at least one frame');
  assert(input.frames.length <= CANVAS_LIMITS.framesMax, 'A canvas page draws a bounded number of frames');
  const imports = new ImportTable(input.snapshot);
  const recipe = baseRecipe(input);
  // Each frame's element by its key; the tree then places them in their boxes.
  const markup = new Map(input.frames.map((frame) => [frame.key, { frame, instance: instanceMarkup(input, recipe, frame, imports) }]));
  assert(markup.size === input.frames.length, 'Each frame has a key of its own');
  const world = worldMarkup(input, markup);
  const arrange = input.arrange ?? DEFAULT_ARRANGEMENT;
  assert(CANVAS_ARRANGEMENTS.includes(arrange), 'A canvas page is laid out one of the canvas’s ways');
  // The default is no attribute, so a canvas nobody arranged is drawn exactly as before the choice existed. On the root,
  // whose attributes the editor's in-place update of a rewritten page carries over; the <body> is scaffolding it leaves.
  const arranged = arrange === DEFAULT_ARRANGEMENT ? '' : ` data-stacki-arrange="${arrange}"`;
  const source = `---
// Generated by Stacki: the component canvas of ${input.component.replaceAll('*/', '')}. Removed when the canvas closes; never edited.
import 'virtual:stacki-component-preview-styles';
import { contextStyles, htmlAttributes, bodyAttributes } from 'virtual:stacki-component-preview-context';
${imports.declarations().join('\n')}
const chrome = ${JSON.stringify(chromeStyles(input.theme, input.surface))};
const script = ${JSON.stringify(chromeScript(input.id, input.theme))};
---
<html {...htmlAttributes} class={[htmlAttributes.class, ${rootClassList(input.rootClasses ?? [])}'stacki-designer'].filter(Boolean).join(' ')}${input.surface === undefined ? '' : ' data-stacki-surface'}${arranged}>
<head>
<meta charset="utf-8" />
<style is:inline set:html={chrome}></style>
</head>
<body {...bodyAttributes} ${UNMARKED} data-flow="${world.flow}">
{contextStyles.map((css) => <style is:inline set:html={css}></style>)}
${world.html}
<script is:inline set:html={script}></script>
</body>
</html>
`;
  assert(source.length <= DEFAULT_LIMITS.sourceCharsMax, 'A canvas page fits the canvas source bound');
  return source;
}

/** A node of the canvas page as the editor's parser reads it: only what finding the frames' instances needs. */
export interface CanvasTreeNode {
  readonly kind: string;
  readonly name?: string;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string }>> | undefined;
  readonly children?: readonly CanvasTreeNode[] | undefined;
}

/**
 * Each frame's instance in the parsed canvas page, in frame order, by its node path (`0.1.2`): a `stacki-frame` names
 * its frame (an expression attribute holding the key as a JSON string, frameMarkup) and its body holds the instance.
 */
export function canvasInstancesOf(nodes: readonly CanvasTreeNode[]): readonly CanvasInstance[] {
  return frameInstancesOf(nodes);
}

/** The canvas page's root (its <html>, by path), each frame's instance in it, and the boxes (frames and groups) around them. */
export interface CanvasTree {
  readonly root: string;
  readonly instances: readonly CanvasInstance[];
  readonly boxes: readonly CanvasBox[];
}

/** The parsed canvas page's root and instances; undefined root throws, since the page always writes one <html>. */
export function canvasTreeOf(nodes: readonly CanvasTreeNode[]): CanvasTree {
  const rootIndex = nodes.findIndex((node) => node.kind === 'element' && node.name === 'html');
  assert(rootIndex >= 0, 'A canvas page has an <html> root');
  const found = boxesOf(nodes);
  return { root: String(rootIndex), instances: found.instances, boxes: found.boxes };
}

/** The page's tag for a frame's box and for a group's: real elements of the page, which the editor selects as divs. */
export const CANVAS_FRAME_TAG = 'stacki-frame';
export const CANVAS_GROUP_TAG = 'stacki-group';

function frameInstancesOf(nodes: readonly CanvasTreeNode[]): readonly CanvasInstance[] {
  return boxesOf(nodes).instances;
}

function boxesOf(nodes: readonly CanvasTreeNode[]): { readonly instances: readonly CanvasInstance[]; readonly boxes: readonly CanvasBox[] } {
  const found: CanvasInstance[] = [];
  const boxes: CanvasBox[] = [];
  // Depth first, in the page's own order, so the instances come in the order their frames are drawn however deep the
  // boxes around them are.
  const pending: { readonly node: CanvasTreeNode; readonly path: string }[] = nodes.map((node, index) => ({ node, path: String(index) }));
  for (let visited = 0; visited < DEFAULT_LIMITS.nodesMax * CANVAS_LIMITS.framesMax; visited++) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    const element = next.node.kind === 'element' ? next.node.name : undefined;
    const instance = element === CANVAS_FRAME_TAG ? frameInstance(next.node, next.path) : undefined;
    if (element === CANVAS_GROUP_TAG) {
      boxes.push({ kind: 'group', key: keyAttribute(next.node, 'data-group'), path: next.path, label: labelAttribute(next.node) });
    }
    if (instance === undefined) {
      pending.unshift(...(next.node.children ?? []).map((child, index) => ({ node: child, path: `${next.path}.${String(index)}` })));
    } else {
      boxes.push({ kind: 'frame', key: instance.key, path: next.path, label: labelAttribute(next.node) });
      found.push(instance);
    }
  }
  assert(found.length <= CANVAS_LIMITS.framesMax, 'A canvas page holds a bounded number of frames');
  assert(boxes.length <= CANVAS_LIMITS.framesMax * (CANVAS_LIMITS.splitPropsMax + 1), 'A canvas page holds a bounded number of boxes');
  return { instances: found, boxes };
}

function frameInstance(frame: CanvasTreeNode, path: string): CanvasInstance | undefined {
  const key = keyAttribute(frame, 'data-frame');
  const instanceIndex = (frame.children ?? []).findIndex((child) => child.kind === 'component');
  if (instanceIndex < 0) {
    return undefined;
  }
  return { key, path: `${path}.${String(instanceIndex)}` };
}

// A box's key, written as an expression holding a JSON string (frameMarkup, worldMarkup).
function keyAttribute(node: CanvasTreeNode, name: 'data-frame' | 'data-group'): string {
  const attribute = node.props?.[name];
  const key: unknown = attribute?.type === 'expr' && attribute.value !== undefined ? JSON.parse(attribute.value) : undefined;
  assert(typeof key === 'string', name === 'data-frame' ? 'A canvas frame names its frame' : 'A canvas group names its group');
  return key;
}

/** A box's caption or header, as the page wrote it (an expression holding a JSON string); `` where it wrote none. */
export function canvasBoxLabel(node: Pick<CanvasTreeNode, 'props'>): string {
  return labelAttribute(node);
}

function labelAttribute(node: Pick<CanvasTreeNode, 'props'>): string {
  const attribute = node.props?.['data-label'];
  const label: unknown = attribute?.type === 'expr' && attribute.value !== undefined ? JSON.parse(attribute.value) : undefined;
  return typeof label === 'string' ? label : '';
}

// The root's classes as literal array items: componentCanvas.ts canvasRootClasses admitted only selector-safe names.
function rootClassList(classes: readonly string[]): string {
  assert(classes.length <= CANVAS_LIMITS.rootClassesMax, 'The canvas root carries a bounded number of classes');
  return classes
    .map((name) => {
      assert(/^-?[A-Za-z_][\w-]*$/.test(name), 'A root class is a plain class name');
      return `${JSON.stringify(name)}, `;
    })
    .join('');
}

/** What an inserted instance is given (the component defaults), which a frame shows unless it sets its own. */
export function frameDefaults(snapshot: DefaultsSnapshot, component: string, fallbackText: string): ComponentRecipe {
  const recipe = baseRecipe({ snapshot, component, fallbackText });
  assert(Object.keys(recipe.props ?? {}).length <= DEFAULT_LIMITS.propsMax, 'Default props are bounded');
  return recipe;
}

// The recipe every frame starts from: the project's own, else the starter one, and text for a default slot that would
// otherwise be empty, because many components (a button, a modal) render nothing without their slot.
function baseRecipe(input: Pick<CanvasPageInput, 'snapshot' | 'component' | 'fallbackText'>): ComponentRecipe {
  const own: ComponentRecipe | undefined = input.snapshot.config.components[input.component];
  const recipe: ComponentRecipe = own ?? starterDefaults(input.snapshot.catalog).components[input.component] ?? {};
  const entry = input.snapshot.catalog.find((component) => component.file === input.component);
  if (entry?.slots.includes('default') === true && recipe.text === undefined && recipe.children === undefined) {
    return { ...recipe, text: input.fallbackText };
  }
  return recipe;
}

function instanceMarkup(input: CanvasPageInput, recipe: ComponentRecipe, frame: CanvasPageFrame, imports: ImportTable): string {
  // A frame's own value replaces the default of that prop, wherever the recipe holds it (an image, a list).
  const merged = mergeDefaultValues(recipe, { props: frame.props, assets: frame.assets ?? {}, literals: frame.literals ?? {} });
  const shown = <T>(values: Readonly<Record<string, T>> | undefined): Readonly<Record<string, T>> =>
    Object.fromEntries(Object.entries(values ?? {}).filter(([name]) => !frame.omitted.has(name)));
  const props = shown(merged.props);
  const held = { assets: shown(merged.assets), literals: shown(merged.literals) };
  // The frame's own slot content stands in place of the defaults' words and children.
  const { text: defaultText, children: defaultChildren, ...rest } = recipe;
  const content =
    frame.content === undefined
      ? { ...(defaultText === undefined ? {} : { text: defaultText }), ...(defaultChildren === undefined ? {} : { children: defaultChildren }) }
      : {};
  const config: ComponentDefaults = {
    version: 1,
    components: { ...input.snapshot.config.components, [input.component]: { ...rest, ...content, props, ...held } },
  };
  const resolved = resolveComponentRecipe(input.component, config, input.snapshot.catalog);
  // A recipe the resolver refuses (a cycle, a missing child) still draws the component, with its props and no children.
  const node: ResolvedNode = resolved.ok ? resolved.value : { component: input.component, props, ...held, content: { kind: 'empty' } };
  const gone = new Set(input.snapshot.missingAssets);
  const shownNode = withoutMissingAssets(node, (file) => !gone.has(file)).node;
  if (frame.content === undefined || frame.content === '') {
    return renderNode(frame.content === '' ? { ...shownNode, content: { kind: 'empty' } } : shownNode, imports, 0);
  }
  return renderNode({ ...shownNode, content: { kind: 'children', children: [{ literal: '', verbatim: slotHTML(frame.content) }] } }, imports, 0);
}

// A frame's content as one expression-free slot child: set:html takes it as HTML text, never as Astro source, and the
// escapes keep the page's own parser from reading a brace or a tag inside the string.
function slotHTML(content: string): string {
  return `<Fragment set:html={${escapedLiteral(content)}} />`;
}

// A string as a JavaScript literal with no brace or angle bracket in it for the page's own parser to read.
function escapedLiteral(text: string): string {
  const literal = JSON.stringify(text).replace(/[<>{}]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  assert(!/[<>{}]/.test(literal), 'A written string is escaped');
  return literal;
}

function renderNode(node: ResolvedNode, imports: ImportTable, depth: number): string {
  assert(depth <= DEFAULT_LIMITS.depthMax, 'A canvas instance has bounded depth');
  if ('literal' in node) {
    return node.verbatim ?? encodeText(node.literal);
  }
  const name =
    'component' in node
      ? imports.binding(node.component)
      : node.from !== undefined && node.tag !== undefined
        ? imports.builtin(node.tag, node.from)
        : (node.tag ?? node.element);
  const props = defaultAttributes(node, (file) => imports.asset(file))
    .map(([key, attribute]) => renderProp(key, attribute))
    .join('');
  if (node.content.kind === 'empty') {
    return elementMarkup(name, props, undefined);
  }
  const children =
    node.content.kind === 'text' ? encodeText(node.content.text) : node.content.children.map((child) => renderNode(child, imports, depth + 1)).join('');
  return elementMarkup(name, props, children);
}

function renderProp(name: string, attribute: { readonly type: 'string' | 'expr'; readonly value: string }): string {
  assert(/^[A-Za-z_$][\w$:-]*$/.test(name), 'A prop name is an attribute name');
  if (attribute.type !== 'string') {
    return ` ${name}={${attribute.value}}`;
  }
  // Astro hands a component's attribute text on as written, entities and all, so text that markup would need an
  // entity for (HTML for a rich text prop, a quote, an ampersand) is given as a string expression instead.
  return /[&<>"{}\r\n]/.test(attribute.value) ? ` ${name}={${escapedLiteral(attribute.value)}}` : ` ${name}="${attribute.value}"`;
}

interface WrittenFrame {
  readonly frame: CanvasPageFrame;
  readonly instance: string;
}

// The world's contents: the frames inside their boxes. With boxes, the first split prop's values go down the canvas and
// everything inside a box goes across it; without, a single row, or one row for each of the first prop's values.
function worldMarkup(input: CanvasPageInput, frames: ReadonlyMap<string, WrittenFrame>): { readonly html: string; readonly flow: 'row' | 'column' } {
  const flat = input.frames.map((frame): CanvasPageItem => ({ kind: 'frame', key: frame.key, caption: frame.label }));
  const items = input.groups ?? flat;
  const written = new Set<string>();
  const write = (item: CanvasPageItem, depth: number): string => {
    assert(depth <= CANVAS_LIMITS.splitPropsMax, 'Boxes nest no deeper than the split');
    if (item.kind === 'frame') {
      const held = frames.get(item.key);
      assert(held !== undefined, 'A box holds frames the page draws');
      written.add(item.key);
      // Among groups, a frame that stands alone at the top is headed as they are.
      const heading = depth === 0 && items.some((other) => other.kind === 'group');
      return frameMarkup({ ...held.frame, label: item.caption }, held.instance, { heading });
    }
    // A real element of the page, as a frame is: the editor selects it as a div, and the Navigator lists it as one.
    const children = item.children.map((child) => write(child, depth + 1)).join('\n');
    const named = `data-group={${escapedLiteral(item.key)}} data-label={${escapedLiteral(item.header)}} data-depth="${String(depth)}"`;
    return `<${CANVAS_GROUP_TAG} ${named}>\n${children}\n</${CANVAS_GROUP_TAG}>`;
  };
  const html = items.map((item) => write(item, 0)).join('\n');
  assert(written.size === frames.size, 'Every frame is drawn once');
  const stacked = items.some((item) => item.kind === 'group') || input.frames.some((frame) => frame.row > 0);
  return { html, flow: stacked ? 'column' : 'row' };
}

function frameMarkup(frame: CanvasPageFrame, instance: string, drawn: { readonly heading: boolean }): string {
  const style: string[] = [];
  const flags: string[] = drawn.heading ? ['data-heading'] : [];
  if (frame.width !== 'hug') {
    style.push(`width: ${String(frame.width)}px`);
    flags.push('data-fixed-width');
  }
  if (frame.height !== 'hug') {
    style.push(`height: ${String(frame.height)}px`);
    flags.push('data-fixed-height');
  }
  if (frame.background === undefined) {
    flags.push('data-transparent');
  } else {
    // shared/properties/componentCanvas.ts canvasBackground refused anything that could end the declaration.
    assert(!/[;"<>{}]/.test(frame.background), 'A frame background is one CSS value');
    style.push(`background: ${frame.background}`);
  }
  // An expression, not a quoted attribute: Astro escapes a static attribute's `&` once more, and the page's script
  // compares this with the key it is sent. A key is URI-encoded pairs, so it holds no quote, brace or angle bracket.
  assert(!/["{}<>\\]/.test(frame.key), 'A frame key is URI-encoded');
  const key = JSON.stringify(frame.key);
  // !important, inline: the frame's own size, place and background beat any rule of the project's (canvasChrome.ts).
  const styleAttribute = style.length === 0 ? '' : ` style="${style.map((declaration) => `${declaration} !important`).join('; ')}"`;
  const flagAttributes = flags.map((flag) => ' ' + flag).join('');
  // The caption is the frame's own (`data-label`, drawn by its ::before), not an element anyone can point at. The frame
  // itself is marked: a press on its caption or around its instance selects it, as a div (componentCanvasSession.ts
  // canvasBoxOf). The label is an expression, so the page's parser hands it back exactly as written (canvasBoxLabel).
  const label = escapedLiteral(frame.label);
  return `<${CANVAS_FRAME_TAG} data-frame={${key}} data-label={${label}}${flagAttributes}${styleAttribute}>${instance}</${CANVAS_FRAME_TAG}>`;
}

// One import per component the frames use, under a name that cannot meet the page's own words (its constants are
// lower case, a component's name is not).
class ImportTable {
  private readonly names = new Map<string, string>();
  private readonly assets = new Map<string, string>();
  private readonly builtins = new Map<string, string>();

  /** The name one of Astro's built-ins is imported under. */
  builtin(tag: string, from: string): string {
    const key = `import { ${tag} as canvas${tag} } from ${JSON.stringify(from)};`;
    this.builtins.set(key, `canvas${tag}`);
    assert(this.builtins.size <= DEFAULT_LIMITS.nodesMax, 'A canvas page imports a bounded number of built-ins');
    return `canvas${tag}`;
  }
  constructor(private readonly snapshot: DefaultsSnapshot) {}

  /** The name an asset default's file is imported under. */
  asset(file: string): string {
    const held = this.assets.get(file);
    if (held !== undefined) {
      return held;
    }
    const name = 'canvasAsset' + String(this.assets.size);
    this.assets.set(file, name);
    assert(this.assets.size <= DEFAULT_LIMITS.storedNodesMax, 'A canvas page imports a bounded number of files');
    return name;
  }

  binding(file: string): string {
    const held = this.names.get(file);
    if (held !== undefined) {
      return held;
    }
    componentFile(file);
    const base =
      file
        .split('/')
        .at(-1)
        ?.replace(/\.astro$/, '') ?? '';
    // The component's own name where it is free, so the editor's panels, breadcrumb and tag name it as the person
    // does; a second component of the same name (another folder's Button) is numbered.
    const own = /^[A-Z][A-Za-z0-9]*$/.test(base) ? base : 'Component';
    const taken = new Set(this.names.values());
    const name = taken.has(own) ? own + String(this.names.size) : own;
    assert(!taken.has(name), 'Each component the canvas imports has its own binding');
    this.names.set(file, name);
    assert(this.names.size <= DEFAULT_LIMITS.nodesMax, 'A canvas page imports a bounded number of components');
    return name;
  }

  declarations(): readonly string[] {
    const components = [...this.names].map(([file, name]) => {
      const specifier = this.snapshot.catalog.find((entry) => entry.file === file)?.importPath ?? '../../' + file;
      return `import ${name} from ${JSON.stringify(specifier)};`;
    });
    return [...components, ...[...this.assets].map(([file, name]) => `import ${name} from ${JSON.stringify('../../' + file)};`), ...this.builtins.keys()];
  }
}
