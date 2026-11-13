// The attributes prop in the Properties panel: a `{ }` row after the declared
// props, and its settings. A rest prop has no JSDoc an editor would show, so it
// has no tooltip here. Its defaults are the attributes before the spread on each
// connected element (attributesBinding.ts), shown only when there are some and
// written through the page editor as each row is left, so the canvas and undo
// see each change; Connections lists the elements that spread it, and picking
// one selects it on the canvas. Nothing waits for a Save button.

import { useState } from 'react';
import type { ComponentProperties, PropertyChange } from '../../../shared/properties/propertyEditing';
import { boundAttributes } from '../../editor/attributesBinding';
import { attributeDefaultsProblem, type AttributeDefault } from '../../editor/propDeclaration';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import { CodeInline } from '../../ui/CodeBlock';
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
  const translate = useTranslate();
  const count = attributes.connections.length;
  return (
    <div className="list-field-row property-row property-attributes-row">
      <span className="list-field-grip" aria-hidden="true" />
      <button
        type="button"
        className="list-field-text property-row-main"
        disabled={busy}
        title={attributes.tooltip || translate('componentProps.attributes.tooltipDefault')}
        onClick={onOpen}
      >
        <span className="list-field-icon" aria-hidden="true">
          <BracesIcon size={14} />
        </span>
        {attributes.local}
        <span className="property-row-kind">{translate('componentProps.attributes.rowKind', { count })}</span>
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

/** The attributes prop's settings: its name, its connections, and its defaults when it has any. */
export function AttributesPropertyEditor(props: EditorProps) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const { attributes } = props;
  const first = attributes.connections[0];
  const [rows, setRows] = useState<readonly AttributeDefault[]>(first?.defaults ?? []);
  const [problem, setProblem] = useState('');
  const editableDefaults = props.onReplaceProps !== undefined && first !== undefined;
  // Each change lands as it is made: a row when it is left, a removal at once.
  const commit = (next: readonly AttributeDefault[]): void => {
    const defaults = next.filter((row) => row.name.trim() !== '' || row.value !== '').map((row) => ({ name: row.name.trim(), value: row.value }));
    const defaultsProblem = attributeDefaultsProblem(defaults, translate);
    if (defaultsProblem !== undefined) {
      setProblem(defaultsProblem);
      return;
    }
    setProblem('');
    if (!editableDefaults || props.onReplaceProps === undefined) {
      return;
    }
    for (const connection of attributes.connections) {
      // An element whose defaults already match keeps its source as written.
      if (!sameDefaults(connection.defaults, defaults)) {
        props.onReplaceProps(connection.id, boundAttributes(connection.props, attributes.local, defaults));
      }
    }
  };
  return (
    <Popup mode="popover" portal={false} className="property-editor property-attributes-editor" onClose={props.onClose} dismissible={!props.busy}>
      {({ close }) => (
        <>
          <header>
            <div className="property-editor-title">
              <strong>{translate('componentProps.attributes.title')}</strong>
            </div>
            <button aria-label={translate('componentProps.dialog.close')} disabled={props.busy} onClick={close}>
              ×
            </button>
          </header>
          <fieldset disabled={props.busy}>
            <div className="property-attributes-name">
              <span>{translate('componentProps.attributes.name')}</span>
              <span className="property-chip">
                <BracesIcon size={11} />
                {attributes.local}
              </span>
            </div>
            <p className="property-help">
              {translateRich('componentProps.attributes.passThrough', { spread: <CodeInline text={`{...${attributes.local}}`} language="typescript" /> })}
            </p>
            <AttributeConnections attributes={attributes} onSelectNode={props.onSelectNode} />
            {rows.length > 0 && (
              <AttributeDefaultRows
                rows={rows}
                editable={{ allowed: editableDefaults }}
                onChange={(next, pace) => {
                  setRows(next);
                  if (pace === 'at-once') {
                    commit(next);
                  }
                }}
                onLeave={() => commit(rows)}
              />
            )}
            {rows.length > 0 && !defaultsAgree(attributes.connections) && (
              <p className="property-help">{translate('componentProps.attributes.defaultsDiffer')}</p>
            )}
            {problem && <ErrorToast message={problem} />}
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
  onLeave,
}: {
  readonly rows: readonly AttributeDefault[];
  readonly editable: { readonly allowed: boolean };
  readonly onChange: (rows: readonly AttributeDefault[], pace: 'typing' | 'at-once') => void;
  /** A row was left: what was typed in it is written. */
  readonly onLeave: () => void;
}) {
  const translate = useTranslate();
  const edit = (index: number, entry: AttributeDefault): void =>
    onChange(
      rows.map((row, at) => (at === index ? entry : row)),
      'typing',
    );
  return (
    <div className="property-attribute-defaults" role="group" aria-label={translate('componentProps.attributes.defaults')}>
      <div className="property-attribute-defaults-title">
        <span>{translate('componentProps.attributes.defaults')}</span>
        {editable.allowed && (
          <button
            type="button"
            className="ghost"
            aria-label={translate('componentProps.attributes.addDefault')}
            title={translate('componentProps.attributes.addDefault')}
            onClick={() => onChange([...rows, { name: '', value: '' }], 'typing')}
          >
            <PlusIcon size={12} />
          </button>
        )}
      </div>
      {rows.map((row, index) => (
        <div className="property-attribute-default" key={index}>
          <input
            aria-label={translate('componentProps.attributes.defaultName', { number: index + 1 })}
            placeholder={translate('componentProps.attributes.namePlaceholder')}
            value={row.name}
            readOnly={!editable.allowed}
            spellCheck={false}
            onBlur={onLeave}
            onChange={(event) => edit(index, { ...row, name: event.target.value })}
          />
          <input
            aria-label={translate('componentProps.attributes.defaultValue', { number: index + 1 })}
            placeholder={translate('componentProps.attributes.valuePlaceholder')}
            value={row.value}
            readOnly={!editable.allowed}
            onBlur={onLeave}
            onChange={(event) => edit(index, { ...row, value: event.target.value })}
          />
          {editable.allowed && (
            <button
              type="button"
              className="ghost"
              aria-label={translate('componentProps.attributes.removeDefault', { name: row.name || String(index + 1) })}
              title={translate('ui.remove')}
              onClick={() =>
                onChange(
                  rows.filter((_, at) => at !== index),
                  'at-once',
                )
              }
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
  const translate = useTranslate();
  const count = attributes.connections.length;
  return (
    <div className="property-connections" role="group" aria-label={translate('componentProps.attributes.connections')}>
      <span>{translate('componentProps.attributes.connectionsCount', { count })}</span>
      {count === 0 && <p className="property-help">{translate('componentProps.attributes.noSpread', { spread: `{...${attributes.local}}` })}</p>}
      {attributes.connections.map((connection) => (
        <button
          type="button"
          key={connection.id}
          className="property-connection"
          disabled={onSelectNode === undefined}
          title={onSelectNode === undefined ? connection.label : translate('componentProps.attributes.select', { name: connection.label })}
          onClick={() => onSelectNode?.(connection.id)}
        >
          {elementIcon(connection.tag, 12)}
          {connection.label}
        </button>
      ))}
    </div>
  );
}
