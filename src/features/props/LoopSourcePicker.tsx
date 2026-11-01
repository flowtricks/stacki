// What a loop goes over, chosen the way a value is bound: a tree of what the
// project and the page hold, each row with what it holds beside it. A
// collection opens to one of its items, so its fields can be seen before it
// is chosen, and a list inside an item (every campus's pastors) can be
// chosen itself; a list on the page opens the same way, down to the lists in
// its items. None and Custom list sit above the tree.
//
// The tree is the data picker's own (DataPicker.tsx), fed with the project's
// collections from the catalog and the page's lists from its data tree.

import { useCallback, useRef, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import DataPicker, { type DataPickerProps, type PickerNode } from './DataPicker';
import { ChevronDownIcon, TextIcon, CloseIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { fromSample, type TreeNode } from '../../editor/dataSample';
import { listsOnly } from '../../editor/dataSuggest';
import { isGroqPath, type FieldList } from '../../editor/loopFieldList';
import { toRecord } from '../../../shared/core/record';
import type { LoopSource } from '../../editor/loopQuery';
import type { LoopCatalog } from './loopCatalog';
import { RowPopup } from './LoopRows';

/** The page's data, as the data picker reads it, for the Source picker. */
export interface SourcePickerData {
  readonly tree: readonly TreeNode[];
  /** One sampled item per collection, by name, once asked for. */
  readonly samples: Readonly<Record<string, unknown>>;
  readonly onNeedSample?: ((collection: string) => void) | undefined;
  readonly onStepItem?: DataPickerProps['onStepItem'];
  /** The frontmatter, so imported functions are not offered as lists. */
  readonly frontmatter: string;
}

/** What a pick in the Source picker means. */
export type SourcePick =
  | { readonly kind: 'empty' }
  | { readonly kind: 'list' }
  | { readonly kind: 'collection'; readonly source: LoopSource }
  | { readonly kind: 'field'; readonly list: FieldList }
  | { readonly kind: 'value'; readonly data: string };

const PICKER_HEIGHT_PX_MAX = 460;
const FIELD_PATH_DEPTH_MAX = 8;

export function SourcePicker(props: {
  readonly label: ReactNode;
  readonly icon: ReactNode;
  /** The tree path of what the loop reads now, which the picker marks. */
  readonly current: string | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly data: SourcePickerData | undefined;
  /** One document of a Sanity type, so its row opens to what documents hold. */
  readonly loadSanitySample?: ((type: string) => Promise<unknown>) | undefined;
  readonly onPick: (pick: SourcePick) => void;
}) {
  const [open, setOpen] = useState(false);
  const sanity = useSanitySamples(props.loadSanitySample);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setAnchor(element ?? undefined), []);
  const choose = (pick: SourcePick): void => {
    setOpen(false);
    props.onPick(pick);
  };
  return (
    <>
      <button ref={attach} type="button" className="dd-trigger loop-source-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dd-icon">{props.icon}</span>
        <span className="dd-label">{props.label}</span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>
      {open && (
        <RowPopup anchor={anchor} heightPxMax={PICKER_HEIGHT_PX_MAX} label="Source" onClose={() => setOpen(false)}>
          <div className="loop-source-picker">
            <div className="loop-source-extras">
              <button type="button" className="dp-row" onClick={() => choose({ kind: 'empty' })}>
                <CloseIcon size={11} />
                <span className="dp-key">None</span>
              </button>
              <button type="button" className="dp-row" onClick={() => choose({ kind: 'list' })}>
                <TextIcon size={11} />
                <span className="dp-key">Custom list</span>
                <span className="dp-preview">type the items</span>
              </button>
            </div>
            <DataPicker
              tree={sourceTree(props.catalog, props.data, sanity.samples)}
              current={props.current}
              footer={false}
              {...(props.data?.onStepItem ? { onStepItem: props.data.onStepItem } : {})}
              onExpand={(node) => {
                if (node.path.startsWith('sanity:')) {
                  sanity.load(node.query?.collection);
                } else if (node.query !== undefined) {
                  props.data?.onNeedSample?.(node.query.collection);
                }
              }}
              onPick={(path) => {
                const pick = followed(pickOf(path), sanity.samples);
                if (pick !== undefined) {
                  choose(pick);
                }
              }}
            />
          </div>
        </RowPopup>
      )}
    </>
  );
}

/** The tree path a loop's source is at, for the picker's mark. */
export function sourcePath(source: LoopSource): string {
  return `${source.kind}:${source.collection}`;
}

/** The tree path of a list inside a collection's items. */
export function fieldListPath(list: FieldList): string {
  return `${sourcePath(list.source)}.${list.path.join('.')}`;
}

// A path the tree hands back, as a pick: `astro:campus`, `astro:campus.pastors`,
// `sanity:pastor`, or a value on the page (`items1`, `pastor.data.tags`).
export function pickOf(path: string): SourcePick | undefined {
  const collection = /^(astro|sanity):([^.[\]]+)$/.exec(path);
  if (collection?.[1] === 'astro' || collection?.[1] === 'sanity') {
    const name = collection[2];
    assert(name !== undefined, 'A collection path names it');
    return { kind: 'collection', source: { kind: collection[1], collection: name } };
  }
  const field = /^(astro|sanity):([^.[\]]+)\.(.+)$/.exec(path);
  if (field?.[1] === 'astro' || field?.[1] === 'sanity') {
    const keys = (field[3] ?? '').split('.');
    // A list inside one particular item (`[0]`) is not a list of every item's.
    if (keys.some((key) => key === '' || key.includes('[')) || keys.length > FIELD_PATH_DEPTH_MAX) {
      return undefined;
    }
    if (field[1] === 'sanity' && !isGroqPath(keys)) {
      return undefined;
    }
    return { kind: 'field', list: { source: { kind: field[1], collection: field[2] ?? '' }, path: keys, follow: 'values' } };
  }
  return { kind: 'value', data: path };
}

// A Sanity list whose items are references is followed to the documents.
function followed(pick: SourcePick | undefined, samples: Readonly<Record<string, unknown>>): SourcePick | undefined {
  if (pick?.kind !== 'field' || pick.list.source.kind !== 'sanity') {
    return pick;
  }
  let value: unknown = samples[pick.list.source.collection];
  for (const key of pick.list.path) {
    value = toRecord(value)?.[key];
  }
  const first: unknown = Array.isArray(value) ? value[0] : undefined;
  const reference = toRecord(first)?.['_ref'] !== undefined;
  return reference ? { ...pick, list: { ...pick.list, follow: 'references' } } : pick;
}

// Sanity documents read once per type while the picker is open.
function useSanitySamples(load: ((type: string) => Promise<unknown>) | undefined) {
  const [samples, setSamples] = useState<Readonly<Record<string, unknown>>>({});
  const asked = useRef(new Set<string>());
  return {
    samples,
    load: (type: string | undefined): void => {
      if (type === undefined || load === undefined || asked.current.has(type)) {
        return;
      }
      asked.current.add(type);
      void load(type).then((sample) => setSamples((previous) => (sample === undefined ? previous : { ...previous, [type]: sample })));
    },
  };
}

// The project's collections, each opening to one item's fields, then the
// page's lists.
function sourceTree(
  catalog: LoopCatalog | undefined,
  data: SourcePickerData | undefined,
  sanitySamples: Readonly<Record<string, unknown>>,
): readonly PickerNode[] {
  const nodes: PickerNode[] = [];
  for (const collection of catalog?.collections ?? []) {
    const { source } = collection;
    const preview = collection.count === undefined ? 'collection' : `${collection.count} items`;
    const path = sourcePath(source);
    const sample = source.kind === 'sanity' ? sanitySamples[source.collection] : data?.samples[source.collection];
    // An Astro entry keeps its fields under `data`; a Sanity document is its fields.
    const fields = sample === undefined ? undefined : fieldsOf(source.kind === 'astro' ? (toRecord(sample)?.['data'] ?? sample) : sample, path);
    const query = { collection: source.collection, name: path };
    nodes.push({
      path,
      key: collection.title,
      kind: 'collection',
      preview,
      children: fields,
      section: source.kind === 'sanity' ? 'loop-sanity' : 'collections',
      query,
      lazy: sample === undefined,
      pickable: true,
    });
  }
  for (const node of pageLists(data)) {
    nodes.push({ ...node, section: 'loop-page' });
  }
  assert(nodes.length <= LIMITS.treeNodesMax, 'The Source tree is bounded');
  return nodes;
}

// An item's fields, shown with their values; only lists inside it can be chosen.
function fieldsOf(item: unknown, base: string): readonly PickerNode[] | undefined {
  return listMarked(fromSample(item, base, 1), 0);
}

function listMarked(nodes: readonly TreeNode[] | undefined, depth: number): readonly PickerNode[] | undefined {
  if (nodes === undefined || depth > LIMITS.treeDepthMax) {
    return undefined;
  }
  return nodes.map((node) => ({
    ...node,
    pickable: node.kind === 'list',
    // Inside a list, items are one item's: shown for reading, never chosen.
    children: node.kind === 'list' ? undefined : listMarked(node.children, depth + 1),
  }));
}

// The page's own lists, without collections (above) or the functions a
// page imports to call (`queryItems(…)`): a function is not a list.
function pageLists(data: SourcePickerData | undefined): readonly PickerNode[] {
  if (data === undefined) {
    return [];
  }
  return listsOnly(data.tree).filter((node) => {
    if (node.section === 'collections' || node.query !== undefined) {
      return false;
    }
    return !(node.kind === 'import' && calledIn(data.frontmatter, node.key));
  });
}

function calledIn(frontmatter: string, name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return false;
  }
  return new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(frontmatter);
}
