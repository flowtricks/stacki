// Text a component prop sets, editable on the canvas like any other text. On
// the page it is the instance's `heading="…"`; in the component it is printed
// as `{heading}` or rendered as HTML with `set:html={heading}` (canvasPropSites.ts).
// Typing writes that attribute on this instance only, through the props
// panel's own prop edit — or adds it, when the instance showed the default.
// HTML content is edited as the Content field edits inline content: one text
// run at a time, with the canvas format bar, and saved back as HTML.

import type { CanvasTextEdit } from '../../features/preview/canvasTextSource';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { CANVAS_TEXT_LIMIT } from '../../../shared/properties/canvasText';
import type { Attr, ImportDecl } from '../../../shared/page/pageNode';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { assert } from '../../../shared/core/assert';
import { componentReference } from './componentReference';
import {
  REPEATS,
  SITES_MAX,
  childrenOf,
  isInstance,
  propSiteReader,
  type InstanceNode,
  type PropNode,
  type PropSiteContext,
  type PropTextSite,
} from './canvasPropSites';
import { domToNodes, isInlineOnly, nodesToHtml } from '../../features/props/richContentModel';
import type { InlineNode } from '../../features/props/richContentModel';
import { formatInlineSelection, inlineStatesAt, inlineWithValue } from './canvasTextFormat';

export { propName, type ComponentSource } from './canvasPropSites';

export interface PropTextContext extends PropSiteContext {
  /** The open page's file, against which its imports resolve. */
  readonly file: string;
  readonly nodes: readonly PropNode[];
  readonly imports: readonly ImportDecl[];
  readonly setProp: (nodeId: string, prop: string, value: Attr) => void;
}

// Instances considered per page.
const INSTANCES_MAX = 64;
const LABEL = 'Component text · this instance';

export async function canvasPropEdits(
  document: CanvasTextDocument,
  context: PropTextContext,
): Promise<CanvasTextEdit[]> {
  const sites = propSiteReader(context);
  const edits: CanvasTextEdit[] = [];
  for (const instance of pageInstances(context.nodes).slice(0, INSTANCES_MAX)) {
    const component = componentReference({
      name: instance.name,
      project: context.projectPath,
      file: context.file,
      imports: context.imports,
      components: context.components,
    });
    const scope = document.pathFor(instance.id);
    if (!component || component.origin?.kind === 'package' || !scope) {
      continue;
    }
    for (const site of await sites(component)) {
      const value = shownValue(instance, component, site.prop);
      if (value === undefined) {
        continue;
      }
      const shown = { instance, site, value, scope, setProp: context.setProp };
      edits.push(...(site.kind === 'text' ? [textEdit(shown, site)] : htmlEdits(shown, site)));
    }
  }
  assert(edits.length <= INSTANCES_MAX * SITES_MAX * 8, 'Prop text stays within its bounds');
  return edits;
}

interface ShownProp {
  readonly instance: InstanceNode;
  readonly site: PropTextSite;
  readonly value: string;
  readonly scope: string;
  readonly setProp: PropTextContext['setProp'];
}

// `{prop}`: the editor holds the rendered words with the template's whitespace
// around them; the attribute holds the words alone.
function textEdit(shown: ShownProp, site: PropTextSite & { readonly kind: 'text' }) {
  const { instance, value, scope } = shown;
  const save = (typed: string) => typed.trim();
  return {
    target: {
      kind: site.parentKind,
      key: `prop:${instance.id}:${site.prop}:${site.path}`,
      path: site.path,
      parent: site.parent,
      value,
      label: LABEL,
      tag: site.tag,
      siblings: site.siblings,
      nested: false,
      scope,
      from: 'prop',
    },
    prop: { nodeID: instance.id, name: site.prop, value: save },
    apply: async (typed: string) => {
      // Unchanged words write nothing, so an edit that only looked adds no attribute.
      if (save(typed) !== value) {
        shown.setProp(instance.id, site.prop, { type: 'string', value: save(typed) });
      }
    },
  } satisfies CanvasTextEdit;
}

// `set:html={prop}`: each text run of the prop's inline HTML is its own text,
// found by position, formatted with the canvas bar and saved back as HTML.
function htmlEdits(
  shown: ShownProp,
  site: PropTextSite & { readonly kind: 'html' },
): CanvasTextEdit[] {
  const children = inlineContent(shown.value);
  if (!children) {
    return [];
  }
  const { instance, scope } = shown;
  const before = nodesToHtml(children);
  const write = (html: string) => {
    if (html !== before) {
      shown.setProp(instance.id, site.prop, { type: 'string', value: html });
    }
  };
  return textRuns(children).flatMap(({ trail, value }, segment) => {
    if (value.trim() === '') {
      return [];
    }
    const typedHTML = (typed: string) => nodesToHtml(inlineWithValue(children, trail, typed));
    const path = `${site.parent}#${segment}`;
    const edit: CanvasTextEdit = {
      target: {
        kind: 'element',
        key: `prop:${instance.id}:${site.prop}:${path}`,
        path,
        parent: site.parent,
        value,
        label: LABEL,
        tag: site.tag,
        siblings: [],
        nested: trail.length > 1,
        scope,
        from: 'prop',
        segment,
      },
      prop: { nodeID: instance.id, name: site.prop, value: typedHTML },
      apply: async (typed) => write(typedHTML(typed)),
      format: {
        states: () => inlineStatesAt(children, trail),
        apply: (selection, action) => {
          const typed = inlineWithValue(children, trail, selection.value);
          const next = formatInlineSelection(typed, { ...selection, trail }, action);
          if (next) {
            write(nodesToHtml(next));
          }
          return next !== undefined;
        },
      },
    };
    return [edit];
  });
}

// A prop's HTML as the Content field's inline nodes, or undefined when it is
// more than inline content (blocks, scripts) and so not editable as text here.
function inlineContent(html: string): readonly InlineNode[] | undefined {
  const host = document.createElement('div');
  host.innerHTML = html;
  const nodes = domToNodes(host);
  return isInlineOnly(nodes) ? nodes : undefined;
}

// Every text node of inline content, in document order, with its way down.
// A stack of pending lists, each read from its next index, so nothing is reordered.
function textRuns(children: readonly InlineNode[]) {
  const runs: { readonly trail: readonly number[]; readonly value: string }[] = [];
  const stack: {
    readonly list: readonly InlineNode[];
    readonly trail: readonly number[];
    at: number;
  }[] = [{ list: children, trail: [], at: 0 }];
  for (let visited = 0; stack.length > 0 && visited < CANVAS_TEXT_LIMIT; visited++) {
    const level = stack[stack.length - 1];
    assert(level !== undefined, 'A pending inline list exists');
    const node = level.list[level.at];
    if (node === undefined) {
      stack.pop();
      continue;
    }
    const trail = [...level.trail, level.at];
    level.at += 1;
    if (node.kind === 'text') {
      runs.push({ trail, value: node.value });
    } else if (node.kind === 'element') {
      stack.push({ list: node.children ?? [], trail, at: 0 });
    }
  }
  return runs;
}

// The page's component instances that render at most once: not inside a loop
// or an expression, where one attribute would stand for many copies. A branch
// (`{show && <X />}`) renders its instance once or not at all.
function pageInstances(nodes: readonly PropNode[]): InstanceNode[] {
  const found: InstanceNode[] = [];
  const queue: PropNode[] = [...nodes];
  for (let index = 0; index < queue.length && index < 10_000; index++) {
    const node = queue[index];
    if (!node || REPEATS.includes(node.kind)) {
      continue;
    }
    if (isInstance(node)) {
      found.push(node);
    }
    queue.push(...childrenOf(node));
  }
  return found;
}

// The text an instance shows for a prop: its own string attribute, or, when it
// sets none, the component's string default. An expression is the page's code.
function shownValue(
  instance: InstanceNode,
  component: ScanComponent,
  prop: string,
): string | undefined {
  const attr = 'props' in instance ? instance.props?.[prop] : undefined;
  if (attr !== undefined) {
    return attr.type === 'string' && usable(attr.value) ? attr.value : undefined;
  }
  const fallback = component.schema?.find((field) => field.name === prop)?.default;
  return typeof fallback === 'string' && usable(fallback) ? fallback : undefined;
}

function usable(value: string): boolean {
  return value.trim() !== '' && value.length <= CANVAS_TEXT_LIMIT;
}
