// What a loop goes over, chosen the way a value is bound: a tree of what the
// project and the page hold, each row with what it holds beside it. A
// collection opens to one of its items, so its fields can be seen before it
// is chosen, and a list inside an item (every campus's pastors) can be
// chosen itself; a list on the page opens the same way, down to the lists in
// its items. None and Custom list sit above the tree, and in a component
// "New List property" too: it declares a list prop with the fields its items
// have and loops over it, so the items' fields are the loop item's fields.
//
// The tree is the data picker's own (DataPicker.tsx), fed with the project's
// collections from the catalog and the page's lists from its data tree. Between
// the two sits "Project data": the lists the project keeps outside the page, in
// its data modules (loopProjectData.ts), whether the file imports them yet or
// not. Picking one that is not imported writes its import with the loop.

import { useCallback, useRef, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import DataPicker, { type DataPickerProps, type PickerNode } from './DataPicker';
import NewPropForm from './NewPropForm';
import type { NewPropHost, NewPropSeed } from './newPropModel';
import { ChevronDownIcon, TextIcon, CloseIcon, PlusIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import { fromSample, type TreeNode } from '../../editor/dataSample';
import { listsOnly } from '../../editor/dataSuggest';
import { isGroqPath, type FieldList } from '../../editor/loopFieldList';
import { toRecord } from '../../../shared/core/record';
import type { LoopSource } from '../../editor/loopQuery';
import type { ImportNeed } from '../../editor/dataSample';
import { projectDataNames, projectDataRows } from './loopProjectData';
import type { LoopCatalog } from './loopCatalog';
import { componentNameOf } from './dataPickerModel';
import { RowPopup } from './LoopRows';
import { pickerPaths, useBindOverrideOnPress } from './bindOverride';
import { OverrideNote } from '../../ui/OverrideNote';

/** The page's data, as the data picker reads it, for the Source picker. */
export interface SourcePickerData {
  readonly tree: readonly TreeNode[];
  /** One sampled item per collection, by name, once asked for. */
  readonly samples: Readonly<Record<string, unknown>>;
  readonly onNeedSample?: ((collection: string, index?: number) => void) | undefined;
  readonly onStepItem?: DataPickerProps['onStepItem'];
  /** The frontmatter, so imported functions are not offered as lists. */
  readonly frontmatter: string;
  /** The open file: a component's lists are headed by its name, and lead the tree. */
  readonly file: string | undefined;
  /** The data file exports the file already imports, by local name, so they are listed with the project's data. */
  readonly projectModules?: Readonly<Record<string, string>> | undefined;
}

/** What a pick in the Source picker means. */
export type SourcePick =
  | { readonly kind: 'empty' }
  | { readonly kind: 'list' }
  | { readonly kind: 'collection'; readonly source: LoopSource }
  | { readonly kind: 'field'; readonly list: FieldList }
  /** A list the page holds; from a project module the file does not import yet, with the import to write. */
  | { readonly kind: 'value'; readonly data: string; readonly import?: ImportNeed | undefined };

/** A List property the Source menu can make: the component it goes in, and what the form starts from. */
export interface NewListOffer {
  /** Its `create` declares the prop and points the loop at it. */
  readonly host: NewPropHost;
  readonly seed: NewPropSeed;
}

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
  /** In a component: "New List property", which makes one and loops over it. */
  readonly newList?: NewListOffer | undefined;
  /** Whether the loop reads dynamic data (a property, a collection, a project list): the trigger is purple, as every value bound to data is. */
  readonly bound?: boolean;
  readonly onPick: (pick: SourcePick) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const newList = props.newList;
  const sanity = useSanitySamples(props.loadSanitySample);
  const [anchor, setAnchor] = useState<HTMLButtonElement | undefined>(undefined);
  const attach = useCallback<RefCallback<HTMLButtonElement>>((element) => setAnchor(element ?? undefined), []);
  const choose = (pick: SourcePick): void => {
    setOpen(false);
    props.onPick(pick);
  };
  const override = useBindOverrideOnPress();
  // A running app that answers `cms.bind` is asked first (docs/apps.md, "Overrides"); Alt-click skips it.
  const askApp = (): void =>
    override.ask(
      { purpose: 'loop-source', current: props.current, paths: pickerPaths(sourceTree(props.catalog, props.data, sanity.samples)) },
      {
        onPicked: (path) => {
          const pick = followed(pickOf(path), sanity.samples);
          if (pick === undefined) {
            setOpen(true); // A path that is no list Stacki can loop over: the person picks one.
          } else {
            choose(pick);
          }
        },
        onStacki: () => setOpen(true),
      },
    );
  return (
    <>
      <button
        ref={attach}
        type="button"
        className={`dd-trigger loop-source-trigger${props.bound === true ? ' is-bound' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(event) => {
          setCreating(false);
          if (!open && override.owner !== undefined && !event.altKey) {
            askApp();
            return;
          }
          setOpen(!open);
        }}
      >
        <span className="dd-icon">{props.icon}</span>
        <span className="dd-label">{props.label}</span>
        <span className="dd-chevron">
          <ChevronDownIcon size={11} />
        </span>
      </button>
      <OverrideNote point="cms.bind" />
      {open && creating && newList !== undefined && (
        <RowPopup anchor={anchor} heightPxMax={PICKER_HEIGHT_PX_MAX} label="New List property" onClose={() => setOpen(false)}>
          <NewPropForm host={newList.host} seed={newList.seed} onCancel={() => setCreating(false)} onCreated={() => setOpen(false)} />
        </RowPopup>
      )}
      {open && !creating && (
        <RowPopup anchor={anchor} heightPxMax={PICKER_HEIGHT_PX_MAX} label="Source" onClose={() => setOpen(false)}>
          <div className="loop-source-picker">
            <div className="loop-source-extras">
              {newList !== undefined && (
                <button type="button" className="dp-new-prop" onClick={() => setCreating(true)}>
                  <PlusIcon size={11} />
                  New List property
                </button>
              )}
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
              sources="open"
              origin={{ file: props.data?.file, page: undefined }}
              propSettings={newList?.host.propSettings}
              {...(props.data?.onStepItem ? { onStepItem: props.data.onStepItem } : {})}
              onExpand={(node, index) => {
                if (node.path.startsWith('sanity:')) {
                  sanity.load(node.query?.collection);
                } else if (node.query !== undefined) {
                  props.data?.onNeedSample?.(node.query.collection, index);
                }
              }}
              onPick={(path, need) => {
                const pick = followed(pickOf(path), sanity.samples);
                if (pick !== undefined) {
                  choose(need?.kind === 'import' && pick.kind === 'value' ? { ...pick, import: need.import } : pick);
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
  // A List prop's row is the page's own, at the name it is read by.
  return source.kind === 'list' ? source.collection : `${source.kind}:${source.collection}`;
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

// The project's collections, each opening to one item's fields, and the
// page's lists after them. A component's own lists lead instead: they are what
// its markup is given to loop over, and a collection is a list from outside it.
export function sourceTree(
  catalog: LoopCatalog | undefined,
  data: SourcePickerData | undefined,
  sanitySamples: Readonly<Record<string, unknown>>,
): readonly PickerNode[] {
  const collections: PickerNode[] = [];
  for (const collection of catalog?.collections ?? []) {
    const { source } = collection;
    const preview = collection.count === undefined ? 'collection' : `${collection.count} items`;
    const path = sourcePath(source);
    const sample = source.kind === 'sanity' ? sanitySamples[source.collection] : data?.samples[source.collection];
    // An Astro entry keeps its fields under `data`; a Sanity document is its fields.
    const fields = sample === undefined ? undefined : fieldsOf(source.kind === 'astro' ? (toRecord(sample)?.['data'] ?? sample) : sample, path);
    const query = { collection: source.collection, name: path };
    collections.push({
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
  const inComponent = componentNameOf(data?.file) !== undefined;
  const modules = data?.projectModules ?? {};
  const taken = data === undefined ? new Set<string>() : projectDataNames(data.tree, modules);
  const project = data === undefined ? [] : projectDataRows(data.tree, modules);
  const own = pageLists(data, taken).map((node) => ({ ...node, section: inComponent ? 'loop-component' : 'loop-page' }));
  // Project data sits between the file's own lists and the collections, whichever leads.
  const nodes = inComponent ? [...own, ...project, ...collections] : [...collections, ...project, ...own];
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
function pageLists(data: SourcePickerData | undefined, projectData: ReadonlySet<string>): readonly PickerNode[] {
  if (data === undefined) {
    return [];
  }
  return listsOnly(data.tree).filter((node) => {
    if (node.section === 'collections' || node.query !== undefined || projectData.has(node.path)) {
      return false;
    }
    return !(node.kind === 'imported' && calledIn(data.frontmatter, node.key));
  });
}

function calledIn(frontmatter: string, name: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
    return false;
  }
  return new RegExp(`(^|[^\\w$.])${name.replace(/\$/g, '\\$')}\\s*\\(`).test(frontmatter);
}
