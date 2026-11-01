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
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { AstroIcon, SanityIcon, CloseIcon, CollectionIcon, LayersIcon } from '../../ui/Icons';
import { assert } from '../../../shared/core/assert';
import {
  emptyQuery,
  type LoopFieldKind,
  type LoopQuery,
  type LoopSource,
} from '../../editor/loopQuery';
import {
  readLoop,
  readingChain,
  type LoopReadInput,
  type LoopReading,
  type QueryHome,
} from '../../editor/loopQueryRead';
import type { LoopTarget } from '../../editor/loopQueryPlan';
import {
  loadFields,
  LOOP_CATALOG_LIMITS,
  titled,
  type CatalogField,
  type LoopCatalog,
} from './loopCatalog';
import { fieldNamed, parseSourceKey, readingKey, sourceKey } from './loopSettingsModel';
import { LoopLineage, tracedCollection, useLoopTrace, type TracedCollection } from './LoopLineage';
import { FilterSection } from './LoopFilters';
import { LimitSection, SortSection } from './LoopOrder';
import {
  editableTrace,
  useCatalogFields,
  useLoopCatalog,
  writeTracedQuery,
} from './loopSettingsData';
import './loopSettings.css';

/** What applying a change did: nothing to say, or why it could not be done. */
export type LoopApplyResult =
  | {
      readonly ok: true;
      readonly unbound: number;
      readonly lost: readonly string[];
      readonly restored: boolean;
    }
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
  readonly onApply: (
    target: LoopTarget,
    sanityClient: 'available' | 'unavailable',
  ) => LoopApplyResult;
  /** A button opening the code that declares `name`, the list's holder. */
  readonly sourceButton?: ((name: string) => ReactNode) | undefined;
}

interface SourceRowProps {
  readonly reading: LoopReading;
  readonly data: string;
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
  const back =
    before === undefined
      ? ''
      : ` Switch back to ${before} to link ${count === 1 ? 'it' : 'them'} again.`;
  return `Unlinked ${count} ${plural}${named}: this list doesn’t have ${count === 1 ? 'that field' : 'those fields'}.${back}`;
}

// What the loop reads now, as the Source menu names it.
function readingLabel(
  reading: LoopReading,
  data: string,
  catalog: LoopCatalog | undefined,
): string | undefined {
  if (reading.kind === 'query' || reading.kind === 'partial') {
    const source = reading.kind === 'query' ? reading.query.source : reading.source;
    return (
      catalog?.collections.find((collection) => sourceKey(collection.source) === sourceKey(source))
        ?.title ?? titled(source.collection)
    );
  }
  return reading.kind === 'value' ? data.trim() : undefined;
}

const NOTICE_MS = 6_000;

export default function LoopSettings(props: LoopSettingsProps) {
  const catalog = useLoopCatalog(props.projectPath);
  const [notice, setNotice] = useNotice();
  const { reading, fields } = useLoopReading(props.input, props.projectPath, catalog);
  const holder = readingChain(reading)[0];
  const traced = useTracedEditing(
    reading,
    { projectPath: props.projectPath, filePath: props.filePath, catalog },
    setNotice,
  );
  const apply = (target: LoopTarget): void => {
    const client = catalog?.sanity.kind === 'connected' ? catalog.sanity.client : 'unavailable';
    const before = readingLabel(reading, props.input.data, catalog);
    setNotice(noticeFor(props.onApply(target, client), before));
  };
  const applyQuery = (query: LoopQuery): void =>
    apply({ kind: 'query', query, fields: fields ?? [] });
  const shared = { catalog, projectPath: props.projectPath };
  return (
    <div className="loop-settings">
      <SourceRow
        reading={reading}
        data={props.input.data}
        projectPath={props.projectPath}
        lists={props.lists}
        sourceButton={holder === undefined ? undefined : props.sourceButton?.(holder)}
        catalog={catalog}
        traced={traced.collection}
        onChoose={apply}
        onNotice={(text) => setNotice({ tone: 'error', text })}
      />
      {notice !== undefined && (
        <NoticeBanner notice={notice} onDismiss={() => setNotice(undefined)} />
      )}
      {reading.kind === 'value' && reading.origin.kind === 'call' && (
        <TracedSettings
          {...shared}
          names={reading.chain.length > 0 ? reading.chain : [props.input.data.trim()]}
          traced={traced}
        />
      )}
      {reading.kind === 'partial' && (
        <PartialNotice
          reason={reading.reason}
          onReplace={() =>
            apply({ kind: 'query', query: emptyQuery(reading.source), fields: fields ?? [] })
          }
        />
      )}
      {reading.kind === 'query' && (
        <>
          {reading.home !== undefined && <OptionsNote home={reading.home} />}
          <QuerySections
            {...shared}
            query={reading.query}
            fields={fields}
            stored={reading.home?.kind === 'options' ? 'data' : 'code'}
            onChange={applyQuery}
          />
        </>
      )}
    </div>
  );
}

// Where a traced list comes from, and its settings when they can be edited there.
function TracedSettings(props: {
  readonly names: readonly string[];
  readonly traced: ReturnType<typeof useTracedEditing>;
  readonly catalog: LoopCatalog | undefined;
  readonly projectPath: string | undefined;
}) {
  const { traced } = props;
  return (
    <>
      <LoopLineage
        names={props.names}
        trace={traced.trace}
        catalog={props.catalog}
        fields={traced.fields}
        editable={traced.editable !== undefined}
      />
      {traced.editable !== undefined && (
        <QuerySections
          catalog={props.catalog}
          projectPath={props.projectPath}
          query={traced.editable.query}
          fields={traced.fields}
          stored="traced"
          onChange={traced.apply}
        />
      )}
    </>
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
        onChange={props.onChange}
      />
      <SortSection
        query={props.query}
        fields={props.fields}
        randomOrder={randomOrder}
        onChange={props.onChange}
      />
      <LimitSection query={props.query} onChange={props.onChange} />
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
  return result.restored
    ? { tone: 'info', text: 'Bindings inside are linked again, as they were for this list.' }
    : undefined;
}

function NoticeBanner(props: { readonly notice: Notice; readonly onDismiss: () => void }) {
  const { notice } = props;
  return (
    <div
      className={`loop-settings-notice ${notice.tone}`}
      role={notice.tone === 'info' ? 'status' : 'alert'}
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="loop-settings-remove"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={props.onDismiss}
      >
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
function useLoopReading(
  input: Omit<LoopReadInput, 'fieldKind'>,
  projectPath: string | undefined,
  catalog: LoopCatalog | undefined,
) {
  const first = useMemo(() => readLoop(input), [input]);
  const firstSource =
    first.kind === 'query'
      ? first.query.source
      : first.kind === 'partial'
        ? first.source
        : undefined;
  const fields = useCatalogFields(projectPath, catalog, firstSource);
  const reading = useMemo(() => {
    if (fields === undefined || firstSource === undefined) {
      return first;
    }
    const fieldKind = (_source: LoopSource, path: string): LoopFieldKind | undefined =>
      fieldNamed(fields, path)?.kind;
    return readLoop({ ...input, fieldKind });
  }, [first, fields, firstSource, input]);
  return { reading, fields };
}

// A list an import computes, traced through the files it passes through to the
// collection it comes from; when that ends in a GROQ query, its settings are
// edited where the query lives, rewritten only if the file still holds it.
function useTracedEditing(
  reading: LoopReading,
  location: {
    readonly projectPath: string | undefined;
    readonly filePath: string | undefined;
    readonly catalog: LoopCatalog | undefined;
  },
  setNotice: (notice: Notice | undefined) => void,
) {
  const origin = reading.kind === 'value' ? reading.origin : undefined;
  const [version, setVersion] = useState(0);
  const trace = useLoopTrace(origin, {
    projectPath: location.projectPath,
    filePath: location.filePath,
    version,
  });
  const collection = tracedCollection(trace);
  const fields = useCatalogFields(location.projectPath, location.catalog, collection?.source);
  const editable = collection === undefined ? undefined : editableTrace(collection);
  const apply = (query: LoopQuery): void => {
    const projectPath = location.projectPath;
    if (projectPath === undefined || editable === undefined) {
      return;
    }
    void writeTracedQuery(projectPath, editable.literal, { file: editable.file, query }).then(
      (outcome) => {
        setVersion((current) => current + 1);
        setNotice(outcome.ok ? undefined : { tone: 'error', text: outcome.message });
      },
    );
  };
  return { trace, collection, fields, editable, apply };
}

// ---------------------------------------------------------------------------
// Source.
// ---------------------------------------------------------------------------

function SourceRow(props: SourceRowProps) {
  const { reading, catalog } = props;
  const current = readingKey(reading, props.data);
  const options = sourceOptions(props, catalog, current);
  const choose = (key: string): void => {
    if (key === current) {
      return;
    }
    const parsed = parseSourceKey(key);
    if (parsed === undefined) {
      return;
    }
    if (parsed.kind === 'empty') {
      props.onChoose({ kind: 'empty' });
      return;
    }
    if (parsed.kind === 'value') {
      props.onChoose({ kind: 'value', data: parsed.data });
      return;
    }
    if (
      parsed.source.kind === 'sanity' &&
      catalog?.sanity.kind === 'connected' &&
      catalog.sanity.client === 'unavailable'
    ) {
      props.onNotice(
        'Add the @sanity/astro integration to this project to loop over Sanity content.',
      );
      return;
    }
    void chooseCollection(props, catalog, parsed.source);
  };
  return (
    <div className="props-field loop-settings-row">
      <label>
        <span className="prop-label">Source</span>
      </label>
      <div className="loop-settings-source">
        <Dropdown<string>
          livePreview={false}
          value={current}
          options={options}
          onChange={choose}
          searchable={options.length > 12}
          searchPlaceholder="Search lists…"
          ariaLabel="Source"
        />
        {props.sourceButton}
      </div>
    </div>
  );
}

// Another collection: its fields are read first, so the children can be
// re-pointed at them and a new Sanity query can return images as addresses.
// The limit carries over; filters and sorts name the old collection's fields.
async function chooseCollection(
  props: {
    readonly projectPath: string | undefined;
    readonly reading: LoopReading;
    readonly onChoose: (target: LoopTarget) => void;
  },
  catalog: LoopCatalog | undefined,
  source: LoopSource,
): Promise<void> {
  const fields =
    props.projectPath && catalog ? await loadFields(props.projectPath, catalog, source) : undefined;
  const previous = props.reading.kind === 'query' ? props.reading.query : undefined;
  const query: LoopQuery = {
    ...emptyQuery(source),
    limit: previous?.limit,
    offset: previous?.offset ?? 0,
  };
  props.onChoose({ kind: 'query', query, fields: fields ?? [] });
}

function sourceOptions(
  props: SourceRowProps,
  catalog: LoopCatalog | undefined,
  current: string,
): DropdownOption<string>[] {
  const options: DropdownOption<string>[] = [{ value: 'empty', label: 'None' }];
  const sanityLabel =
    catalog?.sanity.kind === 'connected' ? `Sanity · ${catalog.sanity.label}` : 'Sanity';
  const sanityMissing =
    catalog?.sanity.kind === 'connected' && catalog.sanity.client === 'unavailable';
  for (const collection of catalog?.collections ?? []) {
    const astro = collection.source.kind === 'astro';
    const hint =
      sanityMissing && !astro
        ? 'needs @sanity/astro'
        : collection.count === undefined
          ? ''
          : String(collection.count);
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
    options.push({
      value: `value:${list.path}`,
      label: list.label,
      group: 'On this page',
      hint: list.hint,
      icon: <LayersIcon size={13} />,
    });
  }
  // What the loop reads now is always listed, even before the catalog loads
  // or when it is a list the menus do not offer.
  if (!options.some((option) => option.value === current)) {
    options.push(currentOption(props, current));
  }
  assert(
    options.length <= LOOP_CATALOG_LIMITS.collectionsMax + props.lists.length + 2,
    'The Source menu is bounded',
  );
  return options;
}

function currentOption(props: SourceRowProps, current: string): DropdownOption<string> {
  const reading = props.reading;
  if (reading.kind === 'query' || reading.kind === 'partial') {
    const source = reading.kind === 'query' ? reading.query.source : reading.source;
    return {
      value: current,
      label: source.collection,
      group: source.kind === 'astro' ? 'Content collections' : 'Sanity',
      icon: <CollectionIcon size={13} />,
    };
  }
  if (reading.kind === 'value' && props.traced !== undefined) {
    // Named for what it really is: the collection, and the code it comes through.
    const source = props.traced.source;
    const title =
      props.catalog?.collections.find((entry) => sourceKey(entry.source) === sourceKey(source))
        ?.title ?? titled(source.collection);
    const via =
      reading.origin.kind === 'call' ? `via ${reading.origin.exportName}()` : props.data.trim();
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
    const hint =
      origin.kind === 'call'
        ? `${origin.exportName}()`
        : origin.kind === 'import'
          ? 'import'
          : origin.kind === 'frontmatter'
            ? 'this file'
            : '';
    return {
      value: current,
      label: props.data.trim(),
      group: 'On this page',
      hint,
      icon: <LayersIcon size={13} />,
    };
  }
  return { value: current, label: 'Custom code', hint: 'edit below' };
}

// Where an options object's settings are saved, said once above them.
function OptionsNote(props: { readonly home: QueryHome }) {
  const home = props.home;
  if (home.kind === 'chain') {
    return (
      <div className="loop-settings-empty loop-settings-note">{`Applied to ${home.list}, kept as written.`}</div>
    );
  }
  const filters =
    home.filter.kind === 'prop'
      ? ' Filters are this component’s default Filters; a page using it can set its own.'
      : '';
  return (
    <div className="loop-settings-empty loop-settings-note">{`Saved in this file, in the settings ${home.reader}() applies.${filters}`}</div>
  );
}

function PartialNotice(props: { readonly reason: string; readonly onReplace: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <div className="loop-settings-partial">
      <div className="loop-settings-partial-title">Custom code shapes this list</div>
      <div className="loop-settings-partial-reason">
        {props.reason} It still works; edit it in the code.
      </div>
      <button
        type="button"
        className="loop-settings-link"
        onClick={() => (armed ? props.onReplace() : setArmed(true))}
        onBlur={() => setArmed(false)}
      >
        {armed ? 'Click again to replace the code' : 'Use list settings instead'}
      </button>
    </div>
  );
}
