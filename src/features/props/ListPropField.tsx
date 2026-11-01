// A component prop that holds one of its list's settings, as a page sets it:
// `<SectionCampusPastors filters={{"filterFor": "ALL", "fields": […]}} />`.
// The component reads the prop into its loop (listProps.ts finds which), so
// the page edits it with the loop's own Filters or Sort editor over that
// collection's fields, as a builder's component instance offers its linked
// collection list settings. Until the page sets one, the component's default
// shows; the first change writes the page's own and turns the label blue,
// whose Reset goes back.
//
// Show and Skip are numbers and use the number field every prop has; a value
// the editors cannot show (code naming a variable, say) keeps the code field.

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { emptyQuery, type LoopFieldKind, type LoopQuery } from '../../editor/loopQuery';
import type { ListProp } from '../../editor/listProps';
import {
  filterValueText,
  readFilterValue,
  readSortValue,
  sortValueText,
} from '../../editor/optionsQuery';
import type { Attr } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { FilterSection } from './LoopFilters';
import { SortSection } from './LoopOrder';
import { useCatalogFields, useLoopCatalog } from './loopSettingsData';
import { fieldNamed } from './loopSettingsModel';
import { ResetLabel } from '../../ui/ResetLabel';
import { FilterIcon, SortIcon } from '../../ui/Icons';
import type { ValueChange } from './bindingTypes';
import './loopSettings.css';

/** The settings editor for a list prop, or undefined when the value is one it cannot show. */
export function ListPropField(props: {
  /** The prop's name, labelled as every prop on an instance is. */
  readonly name: string;
  readonly listProp: ListProp;
  readonly value: Attr | undefined;
  readonly projectPath: string | undefined;
  /** The field to show instead when the value is code the editor cannot read. */
  readonly fallback: ReactNode;
  readonly onChange: ValueChange;
}) {
  const { listProp, value } = props;
  const catalog = useLoopCatalog(props.projectPath);
  const fields = useCatalogFields(props.projectPath, catalog, listProp.source);
  const own = value?.type === 'expr' ? value.value : undefined;
  const query = useMemo(
    () =>
      queryOf(
        listProp,
        own ?? listProp.defaultCode,
        (path: string): LoopFieldKind | undefined => fieldNamed(fields, path)?.kind,
      ),
    [listProp, own, fields],
  );
  // Anything set some other way (a string, a bare attribute) is not a list setting.
  const foreign = value !== undefined && value.type !== 'expr';
  if (foreign || query === undefined) {
    return props.fallback;
  }
  const write = (next: LoopQuery): void => {
    const text = listProp.setting === 'filter' ? filterValueText(next) : sortValueText(next.sorts);
    props.onChange({ type: 'expr', value: text }, true);
  };
  // Set on this page, the label turns blue and resets from a click, as any
  // set field's label does; unset, the component's default shows.
  const label = (
    <ResetLabel
      label={
        <span className="list-prop-label">
          {listProp.setting === 'filter' ? <FilterIcon size={12} /> : <SortIcon size={12} />}
          {props.name}
        </span>
      }
      active={own !== undefined}
      onReset={() => props.onChange(undefined, true)}
    />
  );
  return (
    <div className="props-field list-prop-field">
      {listProp.setting === 'filter' ? (
        <FilterSection
          query={query}
          fields={fields}
          catalog={catalog}
          projectPath={props.projectPath}
          operatorSet="data"
          label={label}
          onChange={write}
        />
      ) : (
        <SortSection
          query={query}
          fields={fields}
          randomOrder="unavailable"
          label={label}
          onChange={write}
        />
      )}
    </div>
  );
}

// The query a filter or sort value states, over the list's collection.
function queryOf(
  listProp: ListProp,
  text: string,
  kind: (path: string) => LoopFieldKind | undefined,
): LoopQuery | undefined {
  assert(
    listProp.setting === 'filter' || listProp.setting === 'sort',
    'Only filters and sorts are edited as lists',
  );
  const base = emptyQuery(listProp.source);
  if (listProp.setting === 'filter') {
    const filter = readFilterValue(text, kind);
    return filter === undefined
      ? undefined
      : { ...base, match: filter.match, conditions: filter.conditions };
  }
  const sorts = readSortValue(text, kind);
  return sorts === undefined ? undefined : { ...base, sorts };
}
