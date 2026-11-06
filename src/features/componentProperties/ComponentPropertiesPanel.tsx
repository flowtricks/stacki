import { ErrorToast } from '../../ui/ErrorToast';
import { useMemo, useState } from 'react';
import { useComponentProperties } from './useComponentProperties';
import type { ComponentPropertiesPanelProps } from './useComponentProperties';
import type { ComponentProperties, ComponentProperty, PropertyChange } from '../../../shared/properties/propertyEditing';
import type { PropertySaveHost } from './propertyAutosave';
import useListReorder from '../../ui/useListReorder';
import ListFieldRow from '../../ui/ListFieldRow';
import { WarningTriangleIcon } from '../../ui/Icons';
import { unusedProps } from '../../editor/propUsage';
import { listPropsOf } from '../../editor/listProps';
import type { EditorNode } from '../../editor/pageView';
import { AttributesPropertyEditor, AttributesPropertyRow, type AttributesHost } from './PropertyAttributes';
import { readAttributesProperty } from './attributesProperty';
import { kindIcon } from './PropertyType';
import { PropertyGrip, movePropertyItem } from './PropertyReorder';
import { PropertiesIcon } from './PropertiesIcon';
import { PropertyEditor, propertyIsEditable, withListSettingType } from './PropertyEditor';
import './componentProperties.css';

type Selection =
  { readonly kind: 'none' } | { readonly kind: 'property'; readonly originalName: string; readonly value: ComponentProperty } | { readonly kind: 'attributes' };

/** The panel's props: the component file, and the open page's elements for its attributes prop. */
export type PropertiesPanelProps = ComponentPropertiesPanelProps &
  AttributesHost & {
    /** The open component's page model: the elements an attributes prop is connected to. */
    readonly nodes?: readonly EditorNode[] | undefined;
  };
const EMPTY_PROPERTY: ComponentProperty = {
  name: '',
  type: 'string',
  required: false,
  readonly: false,
  defaultValue: '',
  description: '',
};

export default function ComponentPropertiesPanel(props: PropertiesPanelProps) {
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
      {data && (
        <PropertyPanelContent
          key={controller.revision}
          data={data}
          busy={controller.busy}
          save={controller.save}
          saveHost={controller.saveHost}
          host={{ nodes: props.nodes, onSelectNode: props.onSelectNode, onReplaceProps: props.onReplaceProps }}
        />
      )}
      {controller.error && <ErrorToast message={controller.error} />}
    </section>
  );
}

interface PropertyContentProps {
  readonly data: ComponentProperties;
  readonly busy: boolean;
  readonly save: (change: PropertyChange) => Promise<boolean>;
  readonly saveHost: PropertySaveHost;
}
type ContentHost = AttributesHost & { readonly nodes: readonly EditorNode[] | undefined };
function PropertyPanelContent({ data, busy, save, saveHost, host }: PropertyContentProps & { readonly host: ContentHost }) {
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const attributes = useMemo(() => readAttributesProperty(data.frontmatter, host.nodes), [data.frontmatter, host.nodes]);
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
            {attributes !== undefined && <AttributesPropertyRow attributes={attributes} busy={busy} onOpen={() => setSelection({ kind: 'attributes' })} />}
          </>
        )}
        {selection.kind === 'attributes' && attributes !== undefined && (
          <AttributesPropertyEditor
            attributes={attributes}
            data={data}
            busy={busy}
            save={save}
            onSelectNode={host.onSelectNode}
            onReplaceProps={host.onReplaceProps}
            onClose={() => setSelection({ kind: 'none' })}
          />
        )}
        <PropertySelectionEditor selection={selection} data={data} busy={busy} save={save} saveHost={saveHost} onClose={() => setSelection({ kind: 'none' })} />
      </>
    </>
  );
}

function PropertySelectionEditor({
  selection,
  data,
  busy,
  save,
  saveHost,
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
          // An existing prop saves as it is typed in, so a save must not disable the field being typed in.
          access={busy && selection.originalName === '' ? 'saving' : propertyIsEditable(selection.value, data) ? 'editable' : 'readonly'}
          onClose={onClose}
          onSave={async (change) => {
            if (await save(change)) {
              onClose();
            }
          }}
          saveHost={saveHost}
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
  // A prop nothing in the component reads is flagged at the row's end.
  const unused = useMemo(
    () =>
      unusedProps(
        data.source,
        data.properties.map((property) => property.name),
      ),
    [data.source, data.properties],
  );
  return (
    <div className="property-list list-field">
      {data.properties.length === 0 && <p className="property-help">No properties yet. Add a property to define what each instance can customize.</p>}
      {data.properties.map((property, index) => (
        <ListFieldRow
          key={property.name}
          className={`property-row ${reorder.rowClass(index)}`}
          rowProps={reorder.rowProps(index)}
          triggerClassName="property-row-main"
          icon={kindIcon(withListSettingType(property, listProps))}
          grip={<PropertyGrip label={property.name} index={index} count={data.properties.length} disabled={disabled} onMove={move} />}
          disabled={busy}
          removeDisabled={busy || !propertyIsRemovable(property, data)}
          removeLabel={`Delete ${property.name}`}
          onOpen={() => onSelect(property)}
          onRemove={() => void onChange({ kind: 'remove', name: property.name })}
          trailing={
            unused.has(property.name) ? (
              <span className="property-unused" title="Not used in this component" role="img" aria-label="Not used in this component">
                <WarningTriangleIcon size={14} />
              </span>
            ) : undefined
          }
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

function propertyIsRemovable(property: ComponentProperty, data: ComponentProperties): boolean {
  return property.editing ? property.editing.kind === 'editable' : !data.advanced;
}
