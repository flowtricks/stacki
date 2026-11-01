// The loop's list settings, as a visual builder's collection list has them:
// a Source menu of every collection the project can loop over (Astro content
// collections, the Sanity connection's types) and the lists already on the
// page, then Filters, Sort and Limit items. Every control writes through one
// plan (loopQueryPlan.ts), which also cleans up what the old settings leave
// behind, so each change is one undo step and never leaves broken code.
//
// What it shows comes from reading the code (loopQueryRead.ts), not from
// anything Stacki stored, so a loop written by hand or by an AI assistant
// opens here the same way: settings it can show are shown, and code it cannot
// is kept and said to be custom rather than rewritten.

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { type DropdownOption } from '../../ui/Dropdown';
import { AstroIcon, SanityIcon, CloseIcon, CollectionIcon, LayersIcon, TextIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import { emptyQuery, type LoopFieldKind, type LoopQuery, type LoopSource } from '../../editor/loopQuery';
import { readLoop, readingChain, type LoopReadInput, type LoopReading, type QueryHome } from '../../editor/loopQueryRead';
import type { LoopTarget } from '../../editor/loopQueryPlan';
import { literalCode, literalItems, STARTER_ITEMS } from '../../editor/loopLiteral';
import { LiteralItemsSection } from './LoopLiteralItems';
import { fieldListOf, type FieldList } from '../../editor/loopFieldList';
import { fieldListPath, SourcePicker, sourcePath, type SourcePick, type SourcePickerData } from './LoopSourcePicker';
import { loadFields, LOOP_CATALOG_LIMITS, titled, type CatalogField, type LoopCatalog } from './loopCatalog';
import { fieldNamed, readingKey, sourceKey } from './loopSettingsModel';
import { connectableProps, propNameProblem, SETTING_TITLES } from '../../editor/optionsBinding';
import { propTooltip } from '../../editor/loopProps';
import type { BindingContext } from './LoopBinding';
import { LOOP_SETTINGS, type LoopSetting, type SettingHome } from '../../editor/optionsQuery';
import { LoopLineage, tracedCollection, useLoopTrace, type TracedCollection } from './LoopLineage';
import { FilterSection } from './LoopFilters';
import { LimitSection, SortSection } from './LoopOrder';
import { editableTrace, loadSanitySample, useCatalogFields, useLoopCatalog, writeTracedQuery } from './loopSettingsData';
import { ItemsSection } from './LoopItems';
import { LoopDetails } from './LoopRows';
import SegSwitch from './SegSwitch';
import './loopSettings.css';

/** What applying a change did: nothing to say, or why it could not be done. */
export type LoopApplyResult =
  | { readonly ok: true; readonly unbound: number; readonly lost: readonly string[]; readonly restored: boolean }
  | { readonly ok: false; readonly message: string };

export interface LoopListOption {
  readonly path: string;
  readonly label: string;
  readonly hint: string;
}

export interface LoopSettingsProps {
  /** The code the loop reads: its data expression, the frontmatter and imports. */
  readonly input: Omit<LoopReadInput, 'fieldKind'>;
  readonly projectPath: string | undefined;
  /** The open file, which imports are resolved from when tracing a list. */
  readonly filePath: string | undefined;
  /** Lists on the page — props, constants, an outer item's lists. */
  readonly lists: readonly LoopListOption[];
  readonly onApply: (target: LoopTarget, sanityClient: 'available' | 'unavailable') => LoopApplyResult;
  /** Renames a linked setting's property or changes its tooltip, across the site. */
  readonly onEditProperty?: ((key: string, edit: { readonly name: string; readonly description: string }) => Promise<string | undefined>) | undefined;
  /** A button opening the code that declares `name`, the list's holder. */
  readonly sourceButton?: ((name: string) => ReactNode) | undefined;
  /** The page's data, for the Source picker's tree of what a loop can go over. */
  readonly pickerData?: SourcePickerData | undefined;
  /** What follows the settings (the loop's Code field), before Details at the end. */
  readonly children?: ReactNode;
}

interface SourceRowProps {
  readonly reading: LoopReading;
  readonly data: string;
  /** The items of a list typed in place, which the menu names Custom list. */
  readonly literal: readonly string[] | undefined;
  /** A list inside every item of a collection, which the menu names by both. */
  readonly fieldList: FieldList | undefined;
  readonly pickerData: SourcePickerData | undefined;
  readonly projectPath: string | undefined;
  readonly lists: readonly LoopListOption[];
  readonly sourceButton: ReactNode;
  readonly catalog: LoopCatalog | undefined;
  /** The collection a traced list comes from, which names it in the menu. */
  readonly traced: TracedCollection | undefined;
  readonly onChoose: (target: LoopTarget) => void;
  readonly onNotice: (text: string) => void;
}

interface Notice {
  readonly tone: 'info' | 'warning' | 'error';
  readonly text: string;
}

// "Unlinked 2 bindings (Role, Featured): this list doesn’t have those fields.
// Switch back to Campus Pastors to link them again."
function unlinkWarning(count: number, lost: readonly string[], before: string | undefined): string {
  const named = lost.length === 0 ? '' : ` (${lost.map((field) => titled(field)).join(', ')})`;
  const plural = count === 1 ? 'binding' : 'bindings';
  const back = before === undefined ? '' : ` Switch back to ${before} to link ${count === 1 ? 'it' : 'them'} again.`;
  return `Unlinked ${count} ${plural}${named}: this list doesn’t have ${count === 1 ? 'that field' : 'those fields'}.${back}`;
}

// What the loop reads now, as the Source menu names it.
function readingLabel(reading: LoopReading, data: string, catalog: LoopCatalog | undefined): string | undefined {
  if (reading.kind === 'query' || reading.kind === 'partial') {
    const source = reading.kind === 'query' ? reading.query.source : reading.source;
    return catalog?.collections.find((collection) => sourceKey(collection.source) === sourceKey(source))?.title ?? titled(source.collection);
  }
  return reading.kind === 'value' ? data.trim() : undefined;
}

const NOTICE_MS = 6_000;

export default function LoopSettings(props: LoopSettingsProps) {
  const catalog = useLoopCatalog(props.projectPath);
  const [notice, setNotice] = useNotice();
  const { reading, fields } = useLoopReading(props.input, props.projectPath, catalog);
  const holder = readingChain(reading)[0];
  const traced = useTracedEditing(reading, { projectPath: props.projectPath, filePath: props.filePath, catalog }, setNotice);
  const apply = (target: LoopTarget): void => {
    const client = catalog?.sanity.kind === 'connected' ? catalog.sanity.client : 'unavailable';
    const before = readingLabel(reading, props.input.data, catalog);
    setNotice(noticeFor(props.onApply(target, client), before));
  };
  const shared = { catalog, projectPath: props.projectPath };
  const literal = reading.kind === 'code' ? literalItems(props.input.data) : undefined;
  const readerOf = (path: string, exported: string): string | undefined =>
    props.input.imports.find((entry) => entry.path === path && (entry.imported ?? entry.name) === exported)?.name;
  const readers = { astro: readerOf('astro:content', 'getCollection'), sanity: readerOf('sanity:client', 'sanityClient') };
  const fieldList = reading.kind === 'code' ? fieldListOf(props.input.frontmatter, props.input.data, readers) : undefined;
  const binding = bindingFor(
    reading,
    { frontmatter: props.input.frontmatter, filePath: props.filePath },
    { onChange: (change) => apply({ kind: 'binding', change }), onEditProperty: props.onEditProperty },
  );
  return (
    <div className="loop-settings">
      <SourceRow
        reading={reading}
        data={props.input.data}
        literal={literal}
        fieldList={fieldList}
        pickerData={props.pickerData}
        projectPath={props.projectPath}
        lists={props.lists}
        sourceButton={holder === undefined ? undefined : props.sourceButton?.(holder)}
        catalog={catalog}
        traced={traced.collection}
        onChoose={apply}
        onNotice={(text) => setNotice({ tone: 'error', text })}
      />
      {notice !== undefined && <NoticeBanner notice={notice} onDismiss={() => setNotice(undefined)} />}
      <ReadingSettings {...shared} reading={reading} traced={traced} fields={fields} binding={binding} literal={literal} onApply={apply} />
      {props.children}
      <ReadingDetails reading={reading} data={props.input.data} traced={traced} catalog={catalog} />
    </div>
  );
}

// A component's list can link its settings to its properties: one kept as
// data links them where they are; one written as code over a content
// collection is rewritten as data first, when linking (optionsBinding.ts).
// A page is not a component: nothing passes it props.
function bindingFor(
  reading: LoopReading,
  file: { readonly frontmatter: string; readonly filePath: string | undefined },
  actions: Pick<BindingContext, 'onChange' | 'onEditProperty'>,
): BindingContext | undefined {
  if (file.filePath === undefined) {
    return undefined;
  }
  if (/(^|[\\/])src[\\/]pages[\\/]/.test(file.filePath)) {
    return undefined;
  }
  if (reading.kind !== 'query') {
    return undefined;
  }
  const base = {
    ...actions,
    componentName: titled(
      file.filePath
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.astro$/, '') ?? 'Component',
    ),
    problemOf: (key: string): string | undefined => propNameProblem(file.frontmatter, key),
    connectable: (setting: LoopSetting): readonly string[] => connectableProps(file.frontmatter, setting),
    tooltipOf: (key: string): string => propTooltip(file.frontmatter, key),
  };
  if (reading.home?.kind === 'options') {
    return { ...base, settings: reading.home.settings };
  }
  // Code over a content collection: nothing is linked yet.
  return reading.home === undefined && reading.query.source.kind === 'astro' ? { ...base, settings: UNLINKED } : undefined;
}

const UNLINKED: Readonly<Record<LoopSetting, SettingHome>> = {
  filter: { kind: 'inline' },
  sort: { kind: 'inline' },
  limit: { kind: 'inline' },
  offset: { kind: 'inline' },
  curated: { kind: 'inline' },
};

// The settings the reading has: a traced list's, a partly custom list's
// notice, a collection list's, or a typed list's items.
function ReadingSettings(props: {
  readonly reading: LoopReading;
  readonly traced: ReturnType<typeof useTracedEditing>;
  readonly fields: readonly CatalogField[] | undefined;
  readonly binding: BindingContext | undefined;
  readonly literal: readonly string[] | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly onApply: (target: LoopTarget) => void;
}) {
  const { reading, fields, literal, onApply } = props;
  const shared = { catalog: props.catalog, projectPath: props.projectPath };
  return (
    <>
      {reading.kind === 'value' && reading.origin.kind === 'call' && <TracedSettings {...shared} traced={props.traced} />}
      {reading.kind === 'partial' && <PartialNotice onReplace={() => onApply({ kind: 'query', query: emptyQuery(reading.source), fields: fields ?? [] })} />}
      {reading.kind === 'query' && (
        <CollectionSettings
          {...shared}
          query={reading.query}
          home={reading.home}
          fields={fields}
          binding={props.binding}
          onChange={(query) => onApply({ kind: 'query', query, fields: fields ?? [] })}
        />
      )}
      {literal !== undefined && <LiteralItemsSection items={literal} onChange={(items) => onApply({ kind: 'value', data: literalCode(items) })} />}
    </>
  );
}

// The explanation behind the settings, folded under Details at the end of the
// panel: where a traced list comes from, why custom code shapes one, where an
// export's settings are saved. Nothing when there is nothing to explain.
function ReadingDetails(props: {
  readonly reading: LoopReading;
  readonly data: string;
  readonly traced: ReturnType<typeof useTracedEditing>;
  readonly catalog: LoopCatalog | undefined;
}) {
  const { reading, traced } = props;
  if (reading.kind === 'value' && reading.origin.kind === 'call') {
    return (
      <LoopDetails>
        <LoopLineage
          names={reading.chain.length > 0 ? reading.chain : [props.data.trim()]}
          trace={traced.trace}
          catalog={props.catalog}
          fields={traced.fields}
          editable={traced.editable !== undefined}
        />
      </LoopDetails>
    );
  }
  if (reading.kind === 'partial') {
    return (
      <LoopDetails>
        <div className="loop-lineage-note">{reading.reason} It still works; edit it in the code.</div>
      </LoopDetails>
    );
  }
  return reading.kind === 'query' && reading.home !== undefined ? (
    <LoopDetails>
      <OptionsNote home={reading.home} />
    </LoopDetails>
  ) : undefined;
}

// A collection list: Dynamic (filters, sort, limit) or Selected (items picked
// by hand), as a builder's collection list offers both.
function CollectionSettings(props: {
  readonly query: LoopQuery;
  readonly binding: BindingContext | undefined;
  readonly home: QueryHome | undefined;
  readonly fields: readonly CatalogField[] | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly onChange: (query: LoopQuery) => void;
}) {
  const { home } = props;
  // A builder export's items carry the CMS's own ids, which its code matches.
  const ids = home?.kind === 'options' || (home?.kind === 'chain' && home.itemPath[0] === 'fields') ? 'export' : 'entry';
  // Either way the other mode's settings go, as a builder clears them; the
  // projection and the entry's name are how the code reads, and stay.
  const base = { ...emptyQuery(props.query.source), projection: props.query.projection, parameter: props.query.parameter };
  // Selected with nothing picked yet is held here, not written: a list of no
  // items has no collection to name in code. The first pick writes it.
  const [pending, setPending] = useState(false);
  const sourceName = sourceKey(props.query.source);
  useEffect(() => setPending(false), [sourceName]);
  const query = props.query.selection === undefined && pending ? { ...base, selection: [] } : props.query;
  const switchTo = (mode: 'dynamic' | 'selected'): void => {
    setPending(mode === 'selected');
    if (mode === 'dynamic' && props.query.selection !== undefined) {
      props.onChange(base);
    }
  };
  return (
    <>
      <div className="props-field loop-settings-row loop-settings-mode">
        <label>
          <span className="prop-label">Items</span>
        </label>
        <SegSwitch
          options={[
            { value: 'dynamic', label: 'Dynamic' },
            { value: 'selected', label: 'Selected' },
          ]}
          current={query.selection === undefined ? 'dynamic' : 'selected'}
          onPick={switchTo}
        />
      </div>
      {query.selection === undefined ? (
        <QuerySections {...props} query={query} stored={home?.kind === 'options' ? 'data' : 'code'} />
      ) : (
        <ItemsSection
          query={query}
          catalog={props.catalog}
          projectPath={props.projectPath}
          ids={ids}
          binding={props.binding}
          onChange={(next) => (next.selection?.length === 0 && props.query.selection === undefined ? undefined : props.onChange(next))}
        />
      )}
    </>
  );
}

// A traced list's settings, when they can be edited where its query lives.
function TracedSettings(props: {
  readonly traced: ReturnType<typeof useTracedEditing>;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
}) {
  const editable = props.traced.editable;
  return editable === undefined ? undefined : (
    <QuerySections
      catalog={props.catalog}
      projectPath={props.projectPath}
      query={editable.query}
      fields={props.traced.fields}
      stored="traced"
      onChange={props.traced.apply}
    />
  );
}

// Filters, Sort and Limit items for a query, wherever it is stored: code Stacki
// writes, data a builder's helper applies, or a GROQ string in another file.
function QuerySections(props: {
  readonly query: LoopQuery;
  readonly fields: readonly CatalogField[] | undefined;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
  readonly stored: 'code' | 'data' | 'traced';
  readonly binding?: BindingContext | undefined;
  readonly onChange: (query: LoopQuery) => void;
}) {
  // Data has no "now" to compare with; a shuffle runs in JS, so neither data
  // nor another file's query string can hold one.
  const operatorSet = props.stored === 'data' ? 'data' : 'code';
  const randomOrder = props.stored === 'code' ? 'available' : 'unavailable';
  return (
    <>
      <FilterSection
        query={props.query}
        fields={props.fields}
        catalog={props.catalog}
        projectPath={props.projectPath}
        operatorSet={operatorSet}
        binding={props.binding}
        onChange={props.onChange}
      />
      <SortSection query={props.query} fields={props.fields} randomOrder={randomOrder} binding={props.binding} onChange={props.onChange} />
      <LimitSection query={props.query} binding={props.binding} onChange={props.onChange} />
    </>
  );
}

// What applying a change says: why it failed, what it unlinked, or that a
// switch back linked bindings again; nothing when it simply worked.
function noticeFor(result: LoopApplyResult, before: string | undefined): Notice | undefined {
  if (!result.ok) {
    return { tone: 'error', text: result.message };
  }
  if (result.unbound > 0) {
    return { tone: 'warning', text: unlinkWarning(result.unbound, result.lost, before) };
  }
  return result.restored ? { tone: 'info', text: 'Bindings inside are linked again, as they were for this list.' } : undefined;
}

function NoticeBanner(props: { readonly notice: Notice; readonly onDismiss: () => void }) {
  const { notice } = props;
  return (
    <div className={`loop-settings-notice ${notice.tone}`} role={notice.tone === 'info' ? 'status' : 'alert'}>
      <span>{notice.text}</span>
      <button type="button" className="loop-settings-remove" aria-label="Dismiss" title="Dismiss" onClick={props.onDismiss}>
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

// An unlink warning stays until it is dismissed or the next change: it says
// what was lost and how to get it back. Anything else fades on its own.
function useNotice(): readonly [Notice | undefined, (notice: Notice | undefined) => void] {
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  useEffect(() => {
    if (notice === undefined || notice.tone === 'warning') {
      return undefined;
    }
    const timer = setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);
  return [notice, setNotice];
}

// Read once for the source, then again with its fields' kinds, which settle
// what `data.featured` alone means (a switch is on; anything else is code).
function useLoopReading(input: Omit<LoopReadInput, 'fieldKind'>, projectPath: string | undefined, catalog: LoopCatalog | undefined) {
  const first = useMemo(() => readLoop(input), [input]);
  const firstSource = first.kind === 'query' ? first.query.source : first.kind === 'partial' ? first.source : undefined;
  const fields = useCatalogFields(projectPath, catalog, firstSource);
  const reading = useMemo(() => {
    if (fields === undefined || firstSource === undefined) {
      return first;
    }
    const fieldKind = (_source: LoopSource, path: string): LoopFieldKind | undefined => fieldNamed(fields, path)?.kind;
    return readLoop({ ...input, fieldKind });
  }, [first, fields, firstSource, input]);
  return { reading, fields };
}

// A list an import computes, traced through the files it passes through to the
// collection it comes from; when that ends in a GROQ query, its settings are
// edited where the query lives, rewritten only if the file still holds it.
function useTracedEditing(
  reading: LoopReading,
  location: { readonly projectPath: string | undefined; readonly filePath: string | undefined; readonly catalog: LoopCatalog | undefined },
  setNotice: (notice: Notice | undefined) => void,
) {
  const origin = reading.kind === 'value' ? reading.origin : undefined;
  const [version, setVersion] = useState(0);
  const trace = useLoopTrace(origin, { projectPath: location.projectPath, filePath: location.filePath, version });
  const collection = tracedCollection(trace);
  const fields = useCatalogFields(location.projectPath, location.catalog, collection?.source);
  const editable = collection === undefined ? undefined : editableTrace(collection);
  const apply = (query: LoopQuery): void => {
    const projectPath = location.projectPath;
    if (projectPath === undefined || editable === undefined) {
      return;
    }
    void writeTracedQuery(projectPath, editable.literal, { file: editable.file, query }).then((outcome) => {
      setVersion((current) => current + 1);
      setNotice(outcome.ok ? undefined : { tone: 'error', text: outcome.message });
    });
  };
  return { trace, collection, fields, editable, apply };
}

// ---------------------------------------------------------------------------
// Source.
// ---------------------------------------------------------------------------

function SourceRow(props: SourceRowProps) {
  const { reading, catalog } = props;
  const current = sourceKeyOf(props);
  const shown = props.fieldList === undefined ? sourceOptions(props, catalog, current).find((option) => option.value === current) : undefined;
  const choose = (pick: SourcePick): void => {
    if (pick.kind === 'empty' || pick.kind === 'value') {
      props.onChoose(pick);
      return;
    }
    if (pick.kind === 'list') {
      props.onChoose({ kind: 'value', data: literalCode(STARTER_ITEMS) });
      return;
    }
    if (pick.kind === 'field') {
      props.onChoose({ kind: 'field', list: pick.list });
      return;
    }
    if (sourceKey(pick.source) === current) {
      return;
    }
    if (pick.source.kind === 'sanity' && catalog?.sanity.kind === 'connected' && catalog.sanity.client === 'unavailable') {
      props.onNotice('Add the @sanity/astro integration to this project to loop over Sanity content.');
      return;
    }
    void chooseCollection(props, catalog, pick.source);
  };
  return (
    <div className="props-field loop-settings-row">
      <label>
        <span className="prop-label">Source</span>
      </label>
      <div className="loop-settings-source">
        <SourcePicker
          label={props.fieldList === undefined ? (shown?.label ?? 'None') : fieldListLabel(props.fieldList, catalog)}
          icon={fieldListIcon(props.fieldList) ?? shown?.icon ?? <CollectionIcon size={13} />}
          current={pickerPath(props, reading)}
          catalog={catalog}
          data={props.pickerData}
          loadSanitySample={(type) =>
            props.projectPath !== undefined && catalog !== undefined ? loadSanitySample(props.projectPath, catalog, type) : Promise.resolve(undefined)
          }
          onPick={choose}
        />
        {props.sourceButton}
      </div>
    </div>
  );
}

// What the Source menu knows the current list by.
function sourceKeyOf(props: SourceRowProps): string {
  if (props.literal !== undefined) {
    return 'list';
  }
  return props.fieldList === undefined ? readingKey(props.reading, props.data) : `field:${sourceKey(props.fieldList.source)}`;
}

// Where the picker's tree marks the current list.
function pickerPath(props: SourceRowProps, reading: LoopReading): string | undefined {
  if (props.fieldList !== undefined) {
    return fieldListPath(props.fieldList);
  }
  if (reading.kind === 'query') {
    return sourcePath(reading.query.source);
  }
  return reading.kind === 'value' ? props.data.trim() : undefined;
}

function fieldListIcon(list: FieldList | undefined): ReactNode {
  if (list === undefined) {
    return undefined;
  }
  return list.source.kind === 'astro' ? <AstroIcon size={13} /> : <SanityIcon size={13} />;
}

// "Campus › Pastors": the collection, then the list inside its items.
function fieldListLabel(list: FieldList, catalog: LoopCatalog | undefined): string {
  const collection = catalog?.collections.find((entry) => sourceKey(entry.source) === sourceKey(list.source));
  return [collection?.title ?? titled(list.source.collection), ...list.path.map((key) => titled(key))].join(' › ');
}

// Another collection: its fields are read first, so the children can be
// re-pointed at them and a new Sanity query can return images as addresses.
// The limit carries over; filters and sorts name the old collection's fields.
async function chooseCollection(
  props: { readonly projectPath: string | undefined; readonly reading: LoopReading; readonly onChoose: (target: LoopTarget) => void },
  catalog: LoopCatalog | undefined,
  source: LoopSource,
): Promise<void> {
  const fields = props.projectPath && catalog ? await loadFields(props.projectPath, catalog, source) : undefined;
  const previous = props.reading.kind === 'query' ? props.reading.query : undefined;
  const query: LoopQuery = { ...emptyQuery(source), limit: previous?.limit, offset: previous?.offset ?? 0 };
  props.onChoose({ kind: 'query', query, fields: fields ?? [] });
}

function sourceOptions(props: SourceRowProps, catalog: LoopCatalog | undefined, current: string): DropdownOption<string>[] {
  const options: DropdownOption<string>[] = [
    { value: 'empty', label: 'None' },
    { value: 'list', label: 'Custom list', hint: 'type the items', icon: <TextIcon size={13} /> },
  ];
  const sanityLabel = catalog?.sanity.kind === 'connected' ? `Sanity · ${catalog.sanity.label}` : 'Sanity';
  const sanityMissing = catalog?.sanity.kind === 'connected' && catalog.sanity.client === 'unavailable';
  for (const collection of catalog?.collections ?? []) {
    const astro = collection.source.kind === 'astro';
    const hint = sanityMissing && !astro ? 'needs @sanity/astro' : collection.count === undefined ? '' : String(collection.count);
    options.push({
      value: sourceKey(collection.source),
      label: collection.title,
      group: astro ? 'Content collections' : sanityLabel,
      groupIcon: astro ? <AstroIcon size={12} /> : <SanityIcon size={12} />,
      hint,
      icon: <CollectionIcon size={13} />,
      dim: sanityMissing && !astro,
    });
  }
  for (const list of props.lists) {
    options.push({ value: `value:${list.path}`, label: list.label, group: 'On this page', hint: list.hint, icon: <LayersIcon size={13} /> });
  }
  // What the loop reads now is always listed, even before the catalog loads
  // or when it is a list the menus do not offer.
  if (!options.some((option) => option.value === current)) {
    options.push(currentOption(props, current));
  }
  assert(options.length <= LOOP_CATALOG_LIMITS.collectionsMax + props.lists.length + 3, 'The Source menu is bounded');
  return options;
}

function currentOption(props: SourceRowProps, current: string): DropdownOption<string> {
  const reading = props.reading;
  if (reading.kind === 'query' || reading.kind === 'partial') {
    const source = reading.kind === 'query' ? reading.query.source : reading.source;
    return { value: current, label: source.collection, group: source.kind === 'astro' ? 'Content collections' : 'Sanity', icon: <CollectionIcon size={13} /> };
  }
  if (reading.kind === 'value' && props.traced !== undefined) {
    // Named for what it really is: the collection, and the code it comes through.
    const source = props.traced.source;
    const title = props.catalog?.collections.find((entry) => sourceKey(entry.source) === sourceKey(source))?.title ?? titled(source.collection);
    const via = reading.origin.kind === 'call' ? `via ${reading.origin.exportName}()` : props.data.trim();
    return {
      value: current,
      label: `${title} · ${props.data.trim()}`,
      group: 'On this page',
      hint: via,
      icon: source.kind === 'sanity' ? <SanityIcon size={13} /> : <AstroIcon size={13} />,
    };
  }
  if (reading.kind === 'value') {
    const origin = reading.origin;
    const hint = origin.kind === 'call' ? `${origin.exportName}()` : origin.kind === 'import' ? 'import' : origin.kind === 'frontmatter' ? 'this file' : '';
    return { value: current, label: props.data.trim(), group: 'On this page', hint, icon: <LayersIcon size={13} /> };
  }
  return { value: current, label: 'Custom code', hint: 'edit below' };
}

// Where an options object's settings are saved.
function OptionsNote(props: { readonly home: QueryHome }) {
  const home = props.home;
  const bound =
    home.kind === 'options' ? LOOP_SETTINGS.filter((setting) => home.settings[setting].kind === 'prop').map((setting) => SETTING_TITLES[setting]) : [];
  const defaults = bound.length === 0 ? '' : ` ${bound.join(', ')} are this component’s defaults; a page using it can set its own.`;
  const text = home.kind === 'chain' ? `Applied to ${home.list}, kept as written.` : `Saved in this file, in the settings ${home.reader}() applies.${defaults}`;
  return <div className="loop-lineage-note">{text}</div>;
}

function PartialNotice(props: { readonly onReplace: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="loop-settings-partial">
      <div className="loop-settings-partial-title">Custom code shapes this list</div>
      <button type="button" className="loop-settings-link" onClick={() => (armed ? props.onReplace() : setArmed(true))} onBlur={() => setArmed(false)}>
        {armed ? 'Click again to replace the code' : 'Use list settings instead'}
      </button>
    </div>
  );
}
