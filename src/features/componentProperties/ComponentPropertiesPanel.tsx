import { ErrorToast } from '../../ui/ErrorToast';
import { useMemo, useState } from 'react';
import { useComponentProperties } from './useComponentProperties';
import type { ComponentPropertiesPanelProps } from './useComponentProperties';
import type { ComponentProperties, ComponentProperty, PropertyChange } from '../../../shared/properties/propertyEditing';
import useListReorder from '../../ui/useListReorder';
import { literalOptions } from '../../../shared/properties/propertyOptions';
import ListFieldRow from '../../ui/ListFieldRow';
import { CheckIcon, ComponentPropertiesIcon, FieldNumberIcon, FieldSwitchIcon, FilterIcon, SortIcon } from '../../ui/Icons';
import { listPropsOf } from '../../editor/listProps';
import { SETTING_PROP_TYPES } from '../../editor/optionsBinding';
import { PropertyGrip, movePropertyItem } from './PropertyReorder';
import { PropertiesIcon } from './PropertiesIcon';
import { PropertyEditor, withListSettingType } from './PropertyEditor';
import './componentProperties.css';

type Selection = { readonly kind: 'none' } | { readonly kind: 'property'; readonly originalName: string; readonly value: ComponentProperty };
const EMPTY_PROPERTY: ComponentProperty = {
  name: '',
  type: 'string',
  required: false,
  readonly: false,
  defaultValue: '',
  description: '',
};

export default function ComponentPropertiesPanel(props: ComponentPropertiesPanelProps) {
  const controller = useComponentProperties(props);
  const data = controller.state.kind === 'ready' ? controller.state.data : undefined;
  return (
    <section className="component-properties" aria-label="Component properties">
      <header className="panel-heading">
        <strong>Properties</strong>
      </header>
      <div className="property-component">
        <PropertiesIcon size={16} />
        {props.name}
      </div>
      {controller.state.kind === 'loading' && <p className="property-help">Loading properties…</p>}
      {controller.state.kind === 'error' && <ErrorToast message={controller.state.message} />}
      {data && <PropertyPanelContent key={controller.revision} data={data} busy={controller.busy} save={controller.save} />}
      {controller.error && <ErrorToast message={controller.error} />}
    </section>
  );
}

interface PropertyContentProps {
  readonly data: ComponentProperties;
  readonly busy: boolean;
  readonly save: (change: PropertyChange) => Promise<boolean>;
}
function PropertyPanelContent({ data, busy, save }: PropertyContentProps) {
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  return (
    <>
      {selection.kind === 'none' && (
        <button
          className="property-add"
          aria-label="Add property"
          title={data.advanced ? 'Add declarations to this combined type in source' : 'Add property'}
          disabled={data.advanced || busy}
          onClick={() =>
            setSelection({
              kind: 'property',
              originalName: '',
              value: EMPTY_PROPERTY,
            })
          }
        >
          +
        </button>
      )}
      <>
        {selection.kind === 'none' && (
          <>
            <PropertyList data={data} busy={busy} onSelect={(value) => setSelection({ kind: 'property', originalName: value.name, value })} onChange={save} />
          </>
        )}
        <PropertySelectionEditor selection={selection} data={data} busy={busy} save={save} onClose={() => setSelection({ kind: 'none' })} />
      </>
    </>
  );
}

function PropertySelectionEditor({
  selection,
  data,
  busy,
  save,
  onClose,
}: PropertyContentProps & {
  readonly selection: Selection;
  readonly onClose: () => void;
}) {
  return (
    <>
      {selection.kind === 'property' && (
        <PropertyEditor
          key={selection.originalName}
          property={selection.value}
          originalName={selection.originalName}
          frontmatter={data.frontmatter}
          access={busy ? 'saving' : propertyIsEditable(selection.value, data) ? 'editable' : 'readonly'}
          onClose={onClose}
          onSave={async (change) => {
            if (await save(change)) {
              onClose();
            }
          }}
          onCommit={save}
        />
      )}
    </>
  );
}

interface PropertyListProps {
  readonly data: ComponentProperties;
  readonly busy: boolean;
  readonly onSelect: (property: ComponentProperty) => void;
  readonly onChange: (change: PropertyChange) => Promise<boolean>;
}
function PropertyList({ data, busy, onSelect, onChange }: PropertyListProps) {
  const disabled = busy || data.advanced;
  const move = (source: number, gap: number): void => {
    const next = movePropertyItem(data.properties, source, gap);
    if (next !== data.properties) {
      void onChange({ kind: 'order', names: next.map((property) => property.name) });
    }
  };
  const reorder = useListReorder({ count: data.properties.length, onMove: move, disabled });
  // A prop the component's loop reads a list setting from shows that setting's
  // icon even while its declared type is still loose (`unknown`).
  const listProps = useMemo(() => listPropsOf(data.frontmatter), [data.frontmatter]);
  return (
    <div className="property-list list-field">
      {data.properties.length === 0 && <p className="property-help">No properties yet. Add a property to define what each instance can customize.</p>}
      {data.properties.map((property, index) => (
        <ListFieldRow
          key={property.name}
          className={`property-row ${reorder.rowClass(index)}`}
          rowProps={reorder.rowProps(index)}
          triggerClassName="property-row-main"
          icon={<PropertyTypeIcon type={withListSettingType(property, listProps).type} />}
          grip={<PropertyGrip label={property.name} index={index} count={data.properties.length} disabled={disabled} onMove={move} />}
          disabled={busy}
          removeDisabled={busy || !propertyIsRemovable(property, data)}
          removeLabel={`Delete ${property.name}`}
          onOpen={() => onSelect(property)}
          onRemove={() => void onChange({ kind: 'remove', name: property.name })}
        >
          {property.name}
          {property.required && (
            <span title="Required" className="property-required">
              {' '}
              *
            </span>
          )}
        </ListFieldRow>
      ))}
    </div>
  );
}

function PropertyTypeIcon({ type }: { readonly type: string }) {
  if (literalOptions(type)) {
    return <ComponentPropertiesIcon size={14} />;
  }
  switch (type) {
    case SETTING_PROP_TYPES.filter:
      return <FilterIcon size={14} />;
    case SETTING_PROP_TYPES.sort:
      return <SortIcon size={14} />;
    case SETTING_PROP_TYPES.curated:
      return <CheckIcon size={14} />;
    case 'boolean':
      return <FieldSwitchIcon size={14} />;
    case 'number':
      return <FieldNumberIcon size={14} />;
    case 'string':
      return 'T';
    default:
      return '{}';
  }
}

function propertyIsEditable(property: ComponentProperty, data: ComponentProperties): boolean {
  return property.editing ? property.editing.kind !== 'restricted' : !data.advanced;
}

function propertyIsRemovable(property: ComponentProperty, data: ComponentProperties): boolean {
  return property.editing ? property.editing.kind === 'editable' : !data.advanced;
}
