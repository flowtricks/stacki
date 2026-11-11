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
    /** Opens a project file, named project-relative: a shared type's file. */
    readonly onOpenFile?: ((path: string) => void) | undefined;
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
          host={{ nodes: props.nodes, onSelectNode: props.onSelectNode, onReplaceProps: props.onReplaceProps, onOpenFile: props.onOpenFile }}
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
type ContentHost = AttributesHost & {
  readonly nodes: readonly EditorNode[] | undefined;
  readonly onOpenFile: ((path: string) => void) | undefined;
};
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
            <SharedPropertyGroups
              data={data}
              busy={busy}
              onOpenFile={host.onOpenFile}
              onSelect={(value) => setSelection({ kind: 'property', originalName: value.name, value })}
            />
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
        <PropertySelectionEditor
          selection={selection}
          data={data}
          busy={busy}
          save={save}
          saveHost={saveHost}
          onOpenFile={host.onOpenFile}
          onClose={() => setSelection({ kind: 'none' })}
        />
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
  onOpenFile,
  onClose,
}: PropertyContentProps & {
  readonly selection: Selection;
  readonly onOpenFile: ((path: string) => void) | undefined;
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
          onSave={async (change, after) => {
            if (!(await save(change))) {
              return false;
            }
            // A new prop stays open on its own settings, which save themselves; anything else closes.
            if (after !== 'edit') {
              onClose();
            }
            return true;
          }}
          saveHost={saveHost}
          onOpenFile={onOpenFile}
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
// The component's own props, in their order. A shared type's are listed under it (SharedPropertyGroups).
function PropertyList({ data, busy, onSelect, onChange }: PropertyListProps) {
  const disabled = busy || data.advanced;
  const properties = useMemo(() => data.properties.filter((property) => property.shared === undefined), [data.properties]);
  const move = (source: number, gap: number): void => {
    const next = movePropertyItem(properties, source, gap);
    if (next !== properties) {
      void onChange({ kind: 'order', names: next.map((property) => property.name) });
    }
  };
  const reorder = useListReorder({ count: properties.length, onMove: move, disabled });
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
      {properties.map((property, index) => (
        <ListFieldRow
          key={property.name}
          className={`property-row ${reorder.rowClass(index)}`}
          rowProps={reorder.rowProps(index)}
          triggerClassName="property-row-main"
          icon={kindIcon(withListSettingType(property, listProps))}
          grip={<PropertyGrip label={property.name} index={index} count={properties.length} disabled={disabled} onMove={move} />}
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

// Each shared type's props under a heading naming the type and its file. Their
// order is the type's, and they are deleted there, so the rows have neither.
function SharedPropertyGroups({
  data,
  busy,
  onOpenFile,
  onSelect,
}: {
  readonly data: ComponentProperties;
  readonly busy: boolean;
  readonly onOpenFile: ((path: string) => void) | undefined;
  readonly onSelect: (property: ComponentProperty) => void;
}) {
  const groups = useMemo(() => sharedGroups(data.properties), [data.properties]);
  return groups.map((group) => (
    <section key={`${group.typeName} ${group.path}`} className="property-shared-group" aria-label={`From ${group.typeName}`}>
      <div className="property-shared-heading">
        <span>From {group.typeName}</span>
        <span aria-hidden="true">·</span>
        {onOpenFile === undefined ? (
          <span>{group.path}</span>
        ) : (
          <button type="button" className="property-shared-file" title={`Open ${group.path}`} onClick={() => onOpenFile(group.path)}>
            {group.path}
          </button>
        )}
      </div>
      <div className="property-list list-field">
        {group.properties.map((property) => (
          <ListFieldRow
            key={property.name}
            className="property-row"
            triggerClassName="property-row-main"
            // The type's file holds their order, so the rows have no grip.
            grip={<span className="list-field-grip" aria-hidden="true" />}
            icon={kindIcon(property)}
            disabled={busy}
            removeDisabled
            removeLabel={`${property.name} is deleted in ${group.path}`}
            onOpen={() => onSelect(property)}
            onRemove={() => undefined}
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
    </section>
  ));
}

interface SharedGroup {
  readonly typeName: string;
  readonly path: string;
  readonly properties: readonly ComponentProperty[];
}

function sharedGroups(properties: readonly ComponentProperty[]): readonly SharedGroup[] {
  const groups = new Map<string, { readonly typeName: string; readonly path: string; readonly properties: ComponentProperty[] }>();
  for (const property of properties) {
    const share = property.shared;
    if (share === undefined) {
      continue;
    }
    const key = `${share.path}#${share.typeName}`;
    const group = groups.get(key) ?? { typeName: share.typeName, path: share.path, properties: [] };
    group.properties.push(property);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function propertyIsRemovable(property: ComponentProperty, data: ComponentProperties): boolean {
  return property.editing ? property.editing.kind === 'editable' : !data.advanced;
}
