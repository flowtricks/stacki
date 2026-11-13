// The loop's Selected items: a list picked by hand, as a builder's curated
// collection list is. The picked items show as rows, in the order they render;
// a row drags to a new place or is removed. The add button opens the
// collection's items with a search and a checkbox each, and Select all.
// Every change writes the selection at once (LoopSettings.tsx applies it).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode, RefCallback } from 'react';
import useListReorder from '../../ui/useListReorder';
import { CheckIcon, DragIcon, ElementImageIcon, SearchIcon, TrashIcon } from '../../ui/Icons';
import AssetThumb from '../../ui/AssetThumb';
import { useAssetEntries } from '../../ui/AssetField';
import type { WireAssetEntry } from '../../../shared/ipc/ipcResults';
import { assert } from '../../../shared/core/assert';
import { LOOP_QUERY_LIMITS, type LoopQuery } from '../../editor/loopQuery';
import type { LoopCatalog } from './loopCatalog';
import { RowPopup, SectionHeader } from './LoopRows';
import { SettingDot, type BindingContext, type DraftEditor } from './LoopBinding';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { LinkedSetting } from './LoopLinked';
import { loadItems, type ItemPicture, type PickableItem } from './loopSettingsData';

const PICKER_HEIGHT_PX_MAX = 380;

type ItemsSectionProps = {
  readonly query: LoopQuery;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  /** Which id the list's code matches items by (a builder export's, or the entry's). */
  readonly ids: 'entry' | 'export';
  readonly binding?: BindingContext | undefined;
  /** The section's label, when it says more than its title (a page's own value). */
  readonly label?: ReactNode;
  readonly onChange: (query: LoopQuery) => void;
};

/** Select items, or, once linked to a property, its purple bar with the picked items as its default. */
export function ItemsSection(props: ItemsSectionProps) {
  const { binding } = props;
  // The picked items as a new property's default: the same editor over a draft.
  const draft: DraftEditor = {
    query: props.query,
    render: (query, onChange) => <ItemsEditor {...props} query={query} binding={undefined} onChange={onChange} />,
  };
  return binding?.settings.curated.kind === 'prop' ? (
    <LinkedSetting setting="curated" binding={binding} editor={<ItemsEditor {...props} binding={undefined} />} draft={draft} />
  ) : (
    <ItemsEditor {...props} dot={<SettingDot setting="curated" binding={binding} draft={draft} />} />
  );
}

function ItemsEditor(props: ItemsSectionProps & { readonly dot?: ReactNode }) {
  const translate = useTranslate();
  const selection = props.query.selection ?? [];
  const items = useItems(props.projectPath, props.catalog, { query: props.query, ids: props.ids });
  const [picking, setPicking] = useState(false);
  const [header, setHeader] = useState<HTMLDivElement | undefined>(undefined);
  const attachHeader = useCallback<RefCallback<HTMLDivElement>>((element) => setHeader(element ?? undefined), []);
  const write = (next: readonly string[]): void => {
    assert(next.length <= LOOP_QUERY_LIMITS.selectionMax, 'A selection is bounded');
    props.onChange({ ...props.query, selection: next });
  };
  const reorder = useListReorder({
    count: selection.length,
    // A drop back in its own place changes nothing, so writes nothing.
    onMove: (source, target) => (staysPut(source, target) ? undefined : write(moved(selection, source, target))),
  });
  const itemOf = (id: string): PickableItem | undefined => items?.find((item) => item.id === id);
  const pictures = (items ?? []).some((item) => item.picture !== undefined);
  const files = useProjectFiles(props.projectPath ?? '');
  const thumb = (picture: ItemPicture | undefined): ReactNode => <ItemThumb picture={picture} file={fileOf(files, picture)} pictures={pictures} />;
  return (
    <div className="loop-settings-section">
      <div ref={attachHeader}>
        <SectionHeader
          title={translate('props.loop.items.select')}
          label={props.label}
          dot={props.dot}
          addable={selection.length < LOOP_QUERY_LIMITS.selectionMax}
          onAdd={() => setPicking(!picking)}
        />
      </div>
      {selection.length > 0 && (
        <div className="loop-settings-list">
          {selection.map((id, index) => (
            <PickedRow
              key={id}
              id={id}
              title={itemOf(id)?.title ?? (items === undefined ? id : translate('props.loop.items.notFound', { id }))}
              found={itemOf(id) !== undefined}
              thumb={thumb(itemOf(id)?.picture)}
              row={reorder.rowProps(index)}
              rowClass={reorder.rowClass(index)}
              onRemove={() => write(selection.filter((picked) => picked !== id))}
            />
          ))}
        </div>
      )}
      {picking && (
        <RowPopup anchor={header} heightPxMax={PICKER_HEIGHT_PX_MAX} label={translate('props.loop.items.select')} onClose={() => setPicking(false)}>
          <ItemPicker items={items} selection={selection} pictures={pictures} thumb={thumb} onChange={write} />
        </RowPopup>
      )}
    </div>
  );
}

type ProjectFile = Extract<WireAssetEntry, { readonly isDir: false }>;

// The project's files by path, read once for the section: an Astro entry's
// picture is one of them, drawn with the Assets panel's own thumbnail.
function useProjectFiles(projectPath: string): ReadonlyMap<string, ProjectFile> {
  const entries = useAssetEntries(projectPath);
  return useMemo(() => new Map(entries.flatMap((entry) => (entry.isDir ? [] : [[entry.rel, entry] as const]))), [entries]);
}

function fileOf(files: ReadonlyMap<string, ProjectFile>, picture: ItemPicture | undefined): ProjectFile | undefined {
  return picture?.kind === 'file' ? files.get(picture.file) : undefined;
}

// An item's first picture, or, beside items that have one, a grey square that
// keeps the names lined up.
function ItemThumb(props: { readonly picture: ItemPicture | undefined; readonly file: ProjectFile | undefined; readonly pictures: boolean }) {
  if (props.picture?.kind === 'url') {
    return (
      <span className="loop-settings-thumb">
        <img src={thumbnailURL(props.picture.url)} alt="" loading="lazy" draggable={false} />
      </span>
    );
  }
  if (props.file !== undefined) {
    return <AssetThumb file={props.file} className="loop-settings-thumb" />;
  }
  if (!props.pictures) {
    return undefined;
  }
  return (
    <span className="loop-settings-thumb is-placeholder">
      <ElementImageIcon size={12} />
    </span>
  );
}

// A Sanity CDN image asks for a thumbnail's size rather than the original.
function thumbnailURL(url: string): string {
  let address: URL;
  try {
    address = new URL(url); // The document list parsed it as https already.
  } catch {
    return url;
  }
  if (address.hostname !== 'cdn.sanity.io') {
    return url;
  }
  address.searchParams.set('w', '96');
  address.searchParams.set('h', '96');
  address.searchParams.set('fit', 'crop');
  return address.toString();
}

// A picked item: its grip and remove button show on hover; the row drags.
function PickedRow(props: {
  readonly id: string;
  readonly title: string;
  readonly found: boolean;
  readonly thumb: ReactNode;
  readonly row: ReturnType<ReturnType<typeof useListReorder>['rowProps']>;
  readonly rowClass: string;
  readonly onRemove: () => void;
}) {
  const translate = useTranslate();
  return (
    <div {...props.row} className={`loop-settings-item loop-settings-picked ${props.rowClass}`}>
      <span className="loop-settings-item-drag" aria-hidden="true">
        <DragIcon size={12} />
      </span>
      {props.thumb}
      <span className={`loop-settings-picked-title${props.found ? '' : ' missing'}`} title={props.id}>
        {props.title}
      </span>
      <button
        type="button"
        className="loop-settings-item-remove"
        aria-label={translate('props.loop.items.remove')}
        title={translate('ui.remove')}
        onClick={props.onRemove}
      >
        <TrashIcon size={13} />
      </button>
    </div>
  );
}

// Search, Select all, and a checkbox per item. A newly checked item goes to
// the end of the list; unchecking removes it wherever it is.
function ItemPicker(props: {
  readonly items: readonly PickableItem[] | undefined;
  readonly selection: readonly string[];
  readonly pictures: boolean;
  readonly thumb: (picture: ItemPicture | undefined) => ReactNode;
  readonly onChange: (selection: readonly string[]) => void;
}) {
  const translate = useTranslate();
  const [search, setSearch] = useState('');
  const { items, selection } = props;
  const shown = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (items ?? []).filter((item) => words === '' || item.title.toLowerCase().includes(words));
  }, [items, search]);
  const chosen = new Set(selection);
  const allShown = shown.length > 0 && shown.every((item) => chosen.has(item.id));
  const toggleAll = (): void => {
    const shownIds = new Set(shown.map((item) => item.id));
    props.onChange(
      allShown
        ? selection.filter((id) => !shownIds.has(id))
        : [...selection, ...shown.map((item) => item.id).filter((id) => !chosen.has(id))].slice(0, LOOP_QUERY_LIMITS.selectionMax),
    );
  };
  const toggle = (id: string): void => {
    props.onChange(chosen.has(id) ? selection.filter((picked) => picked !== id) : [...selection, id].slice(0, LOOP_QUERY_LIMITS.selectionMax));
  };
  return (
    <div className="loop-settings-picker">
      <label className="loop-settings-picker-search">
        <SearchIcon size={12} />
        <input
          value={search}
          placeholder={translate('props.loop.items.search')}
          spellCheck={false}
          autoFocus={true}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      {items === undefined ? (
        <div className="loop-settings-empty">{translate('props.loop.items.loading')}</div>
      ) : (
        <>
          <label className={`loop-settings-picker-row all${allShown ? ' chosen' : ''}`}>
            <input type="checkbox" checked={allShown} disabled={shown.length === 0} onChange={toggleAll} />
            <span className="loop-settings-picker-title">{translate('props.loop.items.selectAll')}</span>
            <PickerCheck checked={allShown} />
          </label>
          <PickerList shown={shown} chosen={chosen} searching={search !== ''} pictures={props.pictures} thumb={props.thumb} onToggle={toggle} />
        </>
      )}
    </div>
  );
}

function PickerList(props: {
  readonly shown: readonly PickableItem[];
  readonly chosen: ReadonlySet<string>;
  readonly searching: boolean;
  readonly pictures: boolean;
  readonly thumb: (picture: ItemPicture | undefined) => ReactNode;
  readonly onToggle: (id: string) => void;
}) {
  const translate = useTranslate();
  return (
    <div className="loop-settings-picker-list">
      {props.shown.map((item) => {
        const checked = props.chosen.has(item.id);
        return (
          <label key={item.id} className={`loop-settings-picker-row${checked ? ' chosen' : ''}${props.pictures ? ' pictured' : ''}`}>
            <input type="checkbox" checked={checked} onChange={() => props.onToggle(item.id)} />
            {props.thumb(item.picture)}
            <span className="loop-settings-picker-title">{item.title}</span>
            <PickerCheck checked={checked} />
          </label>
        );
      })}
      {props.shown.length === 0 && (
        <div className="loop-settings-empty">{props.searching ? translate('props.loop.items.noMatch') : translate('props.loop.items.empty')}</div>
      )}
    </div>
  );
}

// The check ends the row, as a menu's does, so pictures and names line up on the left.
function PickerCheck(props: { readonly checked: boolean }) {
  return (
    <span className="loop-settings-picker-check" aria-hidden="true">
      {props.checked && <CheckIcon size={12} />}
    </span>
  );
}

/** Whether dropping the item at `source` into slot `target` leaves the order as it was. */
export function staysPut(source: number, target: number): boolean {
  return target === source || target === source + 1;
}

/** The ids with the one at `source` placed at drop slot `target` (measured before removal). */
export function moved<T>(ids: readonly T[], source: number, target: number): readonly T[] {
  assert(source >= 0, 'A moved item has a place');
  assert(source < ids.length, 'A moved item exists');
  assert(target >= 0, 'A drop slot has a place');
  assert(target <= ids.length, 'A drop slot is inside the list');
  const next = [...ids];
  const [item] = next.splice(source, 1);
  assert(item !== undefined, 'A moved item was taken out');
  next.splice(target > source ? target - 1 : target, 0, item);
  return next;
}

// The collection's items, loaded once per source and id form.
function useItems(projectPath: string | undefined, catalog: LoopCatalog | undefined, target: { readonly query: LoopQuery; readonly ids: 'entry' | 'export' }) {
  const { kind, collection } = target.query.source;
  const key = `${kind}:${collection}:${target.ids}`;
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly items: readonly PickableItem[] } | undefined>(undefined);
  useEffect(() => {
    if (projectPath === undefined || catalog === undefined) {
      return undefined;
    }
    let live = true;
    void loadItems(projectPath, catalog, { source: { kind, collection }, ids: target.ids }).then((items) => {
      if (live) {
        setLoaded({ key, items });
      }
    });
    return () => {
      live = false;
    };
  }, [projectPath, catalog, kind, collection, target.ids, key]);
  return loaded?.key === key ? loaded.items : undefined;
}
