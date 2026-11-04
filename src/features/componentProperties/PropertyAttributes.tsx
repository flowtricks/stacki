// The attributes prop in the Properties panel: a `{ }` row after the declared
// props, and its settings. The tooltip is the `@attributes` tag above
// `interface Props` (written through the panel's own save, as a frontmatter
// change); the defaults are the attributes before the spread on each
// connected element (attributesBinding.ts), written through the page editor
// so the canvas and undo see them; Connections lists the elements that spread
// it, and picking one selects it on the canvas.

import { useState } from 'react';
import type { ComponentProperties, PropertyChange } from '../../../shared/properties/propertyEditing';
import { boundAttributes } from '../../editor/attributesBinding';
import { attributeDefaultsProblem, withRestTooltip, type AttributeDefault } from '../../editor/propDeclaration';
import Popup from '../../ui/Popup';
import { ErrorToast } from '../../ui/ErrorToast';
import { BracesIcon, PlusIcon, TrashIcon, elementIcon } from '../../ui/Icons';
import type { Attr } from '../../../shared/page/pageNode';
import { defaultsAgree, sameDefaults, type AttributesProperty } from './attributesProperty';

/** What the panel can do to the page's elements, when the app provides it. */
export interface AttributesHost {
  readonly onSelectNode?: ((id: string) => void) | undefined;
  readonly onReplaceProps?: ((id: string, props: Readonly<Record<string, Attr>>) => void) | undefined;
}

/** The attributes prop's row in the property list. */
export function AttributesPropertyRow({
  attributes,
  busy,
  onOpen,
}: {
  readonly attributes: AttributesProperty;
  readonly busy: boolean;
  readonly onOpen: () => void;
}) {
  const count = attributes.connections.length;
  return (
    <div className="list-field-row property-row property-attributes-row">
      <span className="list-field-grip" aria-hidden="true" />
      <button
        type="button"
        className="list-field-text property-row-main"
        disabled={busy}
        title={attributes.tooltip || 'Attributes an instance adds to the connected elements'}
        onClick={onOpen}
      >
        <span className="list-field-icon" aria-hidden="true">
          <BracesIcon size={14} />
        </span>
        {attributes.local}
        <span className="property-row-kind">{count === 1 ? 'Attributes · 1 element' : `Attributes · ${count} elements`}</span>
      </button>
    </div>
  );
}

interface EditorProps extends AttributesHost {
  readonly attributes: AttributesProperty;
  readonly data: ComponentProperties;
  readonly busy: boolean;
  readonly save: (change: PropertyChange) => Promise<boolean>;
  readonly onClose: () => void;
}

/** The attributes prop's settings: name, tooltip, default attributes and connections. */
export function AttributesPropertyEditor(props: EditorProps) {
  const { attributes } = props;
  const first = attributes.connections[0];
  const [tooltip, setTooltip] = useState(attributes.tooltip);
  const [rows, setRows] = useState<readonly AttributeDefault[]>(first?.defaults ?? []);
  const [problem, setProblem] = useState('');
  const editableDefaults = props.onReplaceProps !== undefined && first !== undefined;
  const submit = async (): Promise<void> => {
    const defaults = rows.filter((row) => row.name.trim() !== '' || row.value !== '').map((row) => ({ name: row.name.trim(), value: row.value }));
    const defaultsProblem = attributeDefaultsProblem(defaults);
    if (defaultsProblem !== undefined) {
      setProblem(defaultsProblem);
      return;
    }
    if (tooltip.trim() !== attributes.tooltip) {
      const next = withRestTooltip(props.data.frontmatter, tooltip);
      if (!next.ok) {
        setProblem(next.error);
        return;
      }
      if (!(await props.save({ kind: 'source', frontmatter: next.value }))) {
        return;
      }
    }
    if (editableDefaults && props.onReplaceProps !== undefined) {
      for (const connection of attributes.connections) {
        // An element whose defaults already match keeps its source as written.
        if (!sameDefaults(connection.defaults, defaults)) {
          props.onReplaceProps(connection.id, boundAttributes(connection.props, attributes.local, defaults));
        }
      }
    }
    props.onClose();
  };
  return (
    <Popup mode="popover" portal={false} className="property-editor property-attributes-editor" onClose={props.onClose} dismissible={!props.busy}>
      {({ close }) => (
        <>
          <header>
            <div className="property-editor-title">
              <strong>Attributes property</strong>
            </div>
            <button aria-label="Close property settings" disabled={props.busy} onClick={close}>
              ×
            </button>
          </header>
          <fieldset disabled={props.busy}>
            <div className="property-attributes-name">
              <span>Name</span>
              <span className="property-chip">
                <BracesIcon size={11} />
                {attributes.local}
              </span>
            </div>
            <p className="property-help">
              Instances add their own attributes through {attributes.local}. Each element's own attributes, after the spread, still win.
            </p>
            <label>
              Tooltip
              <textarea
                value={tooltip}
                rows={3}
                aria-label="Tooltip"
                placeholder="Describe the attributes an instance may add…"
                onChange={(event) => {
                  setTooltip(event.target.value);
                  setProblem('');
                }}
              />
            </label>
            <AttributeDefaultRows
              rows={rows}
              editable={{ allowed: editableDefaults }}
              onChange={(next) => {
                setRows(next);
                setProblem('');
              }}
            />
            {!defaultsAgree(attributes.connections) && (
              <p className="property-help">The connected elements have different defaults; saving gives every one of them these.</p>
            )}
            <AttributeConnections attributes={attributes} onSelectNode={props.onSelectNode} />
            {problem && <ErrorToast message={problem} />}
            <div className="property-actions">
              <span />
              <button className="primary" onClick={() => void submit()}>
                Save property
              </button>
            </div>
          </fieldset>
        </>
      )}
    </Popup>
  );
}

function AttributeDefaultRows({
  rows,
  editable,
  onChange,
}: {
  readonly rows: readonly AttributeDefault[];
  readonly editable: { readonly allowed: boolean };
  readonly onChange: (rows: readonly AttributeDefault[]) => void;
}) {
  const edit = (index: number, entry: AttributeDefault): void => onChange(rows.map((row, at) => (at === index ? entry : row)));
  return (
    <div className="property-attribute-defaults" role="group" aria-label="Default attributes">
      <div className="property-attribute-defaults-title">
        <span>Default attributes</span>
        {editable.allowed && (
          <button
            type="button"
            className="ghost"
            aria-label="Add default attribute"
            title="Add default attribute"
            onClick={() => onChange([...rows, { name: '', value: '' }])}
          >
            <PlusIcon size={12} />
          </button>
        )}
      </div>
      {rows.length === 0 && <p className="property-help">None. An instance's attributes are all its own.</p>}
      {rows.map((row, index) => (
        <div className="property-attribute-default" key={index}>
          <input
            aria-label={`Default attribute ${index + 1} name`}
            placeholder="name"
            value={row.name}
            readOnly={!editable.allowed}
            spellCheck={false}
            onChange={(event) => edit(index, { ...row, name: event.target.value })}
          />
          <input
            aria-label={`Default attribute ${index + 1} value`}
            placeholder="value"
            value={row.value}
            readOnly={!editable.allowed}
            onChange={(event) => edit(index, { ...row, value: event.target.value })}
          />
          {editable.allowed && (
            <button
              type="button"
              className="ghost"
              aria-label={`Remove default attribute ${row.name || index + 1}`}
              title="Remove"
              onClick={() => onChange(rows.filter((_, at) => at !== index))}
            >
              <TrashIcon size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AttributeConnections({
  attributes,
  onSelectNode,
}: {
  readonly attributes: AttributesProperty;
  readonly onSelectNode: AttributesHost['onSelectNode'];
}) {
  const count = attributes.connections.length;
  return (
    <div className="property-connections" role="group" aria-label="Connections">
      <span>Connections: {count === 1 ? '1 element' : `${count} elements`}</span>
      {count === 0 && <p className="property-help">No element spreads {`{...${attributes.local}}`} yet. Connect one from its Attributes bind dot.</p>}
      {attributes.connections.map((connection) => (
        <button
          type="button"
          key={connection.id}
          className="property-connection"
          disabled={onSelectNode === undefined}
          title={onSelectNode === undefined ? connection.label : `Select ${connection.label}`}
          onClick={() => onSelectNode?.(connection.id)}
        >
          {elementIcon(connection.tag, 12)}
          {connection.label}
        </button>
      ))}
    </div>
  );
}
