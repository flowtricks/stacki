// What the canvas selection hands the AI composer's "Add selected element" (src/features/ai/mentions/
// selectionMention.ts): the node the Properties panel shows, read the way that panel reads it, as plain
// data. A component instance gives its component's file and each value the instance writes: a declared
// prop as `prop`, anything else it passes (class, style, data-*, aria-*, what reaches a `{...rest}`) as
// `attr`, each slot a child fills as `slot`. A native element gives its file, its locator (the child
// indexes the canvas uses, `0.2`), its tag, its attributes and its short text. Only written values are
// taken: a default the instance leaves alone is not, one it writes is, even when it equals the default.
// A spread (`{...props}`) has no name to give, so it is left out.
//
// Pure: the shell passes in the node, the component the scan resolved for it, its file and its locator.
import { assert } from '../../../shared/core/assert';
import { isProjectRelativePath } from '../../../shared/properties/ai/mentions';
import type { Attr, PageNode } from '../../../shared/page/pageNodeTypes';
import type { ScanComponent } from '../../../shared/properties/projectScan';
import { shortText, type SelectionMember, type SelectionMention } from '../../features/ai/mentions/selectionMention';

/** Children read for a component's filled slots or an element's text: far more than any real node holds. */
const CHILDREN_READ_MAX = 512;

export interface SelectionSource {
  readonly node: PageNode | undefined;
  /** The scan's component for a component instance (componentReference, as the Properties panel resolves it). */
  readonly component: ScanComponent | undefined;
  /** The project-relative file the node is in. */
  readonly file: string | undefined;
  /** The node's child indexes in that file's tree (`0.2`). */
  readonly locator: string | undefined;
  /** The component's project-relative file, when the scan gives none (a package component). */
  readonly componentFile: string | undefined;
}

export function selectionMentionOf(source: SelectionSource): SelectionMention | undefined {
  const { node, file, locator } = source;
  if (node === undefined || file === undefined || locator === undefined || !isProjectRelativePath(file)) {
    return undefined;
  }
  if (node.kind === 'component') {
    const path = source.component?.file ?? source.componentFile;
    if (path === undefined || !isProjectRelativePath(path)) {
      return undefined;
    }
    const declared = new Set((source.component?.schema ?? []).map((field) => field.name));
    const members: SelectionMember[] = [
      ...writtenValues(node.props, node.attrOrder).map((entry) => ({ role: declared.has(entry.name) ? ('prop' as const) : ('attr' as const), ...entry })),
      ...filledSlots(node.children).map((name) => ({ role: 'slot' as const, name, value: undefined })),
    ];
    return { kind: 'component', key: `${file}#${locator}`, path, name: node.name, members };
  }
  if (node.kind === 'element') {
    const text = shortText(textOf(node.children));
    const members: SelectionMember[] = [
      ...writtenValues(node.props, node.attrOrder).map((entry) => ({ role: 'attr' as const, ...entry })),
      ...(text === undefined ? [] : [{ role: 'text' as const, name: 'text', value: text }]),
    ];
    return { kind: 'element', key: `${file}#${locator}`, path: file, locator, tag: node.name, members };
  }
  return undefined;
}

/** Each written attribute in source order, with the value as written: text, the code of an expression, none for a bare one. */
function writtenValues(
  props: Readonly<Record<string, Attr>> | undefined,
  order: readonly string[] | undefined,
): readonly { readonly name: string; readonly value: string | undefined }[] {
  if (props === undefined) {
    return [];
  }
  const names = order ?? Object.keys(props);
  const values: { readonly name: string; readonly value: string | undefined }[] = [];
  for (const name of names) {
    const attr = props[name];
    if (attr !== undefined && attr.type !== 'spread') {
      values.push({ name, value: attr.type === 'bare' ? undefined : attr.value });
    }
  }
  assert(values.length <= names.length, 'writtenValues: at most one value per attribute');
  return values;
}

/** The slots a component's children fill: each `slot="name"`, and `default` when other content is there. */
function filledSlots(children: readonly PageNode[] | undefined): readonly string[] {
  const slots: string[] = [];
  let fillsDefault = false;
  for (const child of (children ?? []).slice(0, CHILDREN_READ_MAX)) {
    const slot = 'props' in child ? child.props?.['slot'] : undefined;
    if (slot?.type === 'string' && slot.value !== '') {
      if (!slots.includes(slot.value)) {
        slots.push(slot.value);
      }
    } else if (child.kind !== 'comment' && !(child.kind === 'text' && child.value.trim() === '')) {
      fillsDefault = true;
    }
  }
  return fillsDefault ? ['default', ...slots.filter((slot) => slot !== 'default')] : slots;
}

/** An element's own text: its text children, joined. Nested elements are not read: the text is a hint, not the content. */
function textOf(children: readonly PageNode[] | undefined): string {
  return (children ?? [])
    .slice(0, CHILDREN_READ_MAX)
    .map((child) => (child.kind === 'text' ? child.value : ''))
    .join(' ');
}

/** The locator and file of a canvas path (`src/components/Card.astro|0.2`, or a bare `0.2` of the open file). */
export function locatorOf(canvasPath: string | undefined, openFile: string | undefined): { readonly file: string; readonly locator: string } | undefined {
  if (canvasPath === undefined) {
    return undefined;
  }
  const bar = canvasPath.lastIndexOf('|');
  const file = bar < 0 ? openFile : canvasPath.slice(0, bar);
  const locator = canvasPath.slice(bar + 1);
  if (file === undefined || !/^\d+(?:\.\d+)*$/u.test(locator)) {
    return undefined;
  }
  return { file, locator };
}
