// The pin at the end of a collection table's header: a menu of the
// collection's fields, each checked while it shows as a column. The fields
// come from the collection's template (its fields with no values), read once
// when the menu first opens.
import { useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { CheckIcon, PinIcon } from '../../ui/Icons';
import { remoteTemplate } from '../../ipc/remoteSource';
import type { RemoteCmsSelection } from './remoteCmsShared';
import { columnFields, type RemoteColumn } from './remoteColumns';

type Fields =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly fields: readonly RemoteColumn[] }
  | { readonly kind: 'failed'; readonly message: string };

export function RemoteColumnPicker(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly columns: readonly RemoteColumn[];
  readonly onColumns: (columns: readonly RemoteColumn[]) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Fields | undefined>(undefined);
  const show = () => {
    setOpen(true);
    if (fields === undefined || fields.kind === 'failed') {
      setFields({ kind: 'loading' });
      const { connection, collection } = props.selection;
      void remoteTemplate(props.projectPath, connection.id, collection).then((template) =>
        setFields(
          template.ok
            ? { kind: 'ready', fields: columnFields(template.value.fields) }
            : { kind: 'failed', message: template.message },
        ),
      );
    }
  };
  const chosen = new Set(props.columns.map((column) => column.name));
  // Toggled in the order the fields come, so the columns keep the schema's order.
  const toggle = (field: RemoteColumn, all: readonly RemoteColumn[]) =>
    props.onColumns(
      all.filter((each) =>
        each.name === field.name ? !chosen.has(each.name) : chosen.has(each.name),
      ),
    );
  const rect = button.current?.getBoundingClientRect();
  return (
    <>
      <button
        ref={button}
        type="button"
        className="ghost remote-cms-pin"
        title="Choose columns"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          show();
        }}
      >
        <PinIcon size={13} />
      </button>
      {open && rect && (
        <Popup
          mode="popover"
          anchor={button.current ?? undefined}
          onClose={() => setOpen(false)}
          className="more-menu remote-cms-column-menu"
          role="menu"
          style={{ position: 'fixed', top: rect.bottom + 6, right: window.innerWidth - rect.right }}
        >
          <ColumnMenu fields={fields} chosen={chosen} onToggle={toggle} />
        </Popup>
      )}
    </>
  );
}

function ColumnMenu(props: {
  readonly fields: Fields | undefined;
  readonly chosen: ReadonlySet<string>;
  readonly onToggle: (field: RemoteColumn, all: readonly RemoteColumn[]) => void;
}) {
  const { fields } = props;
  if (fields === undefined || fields.kind === 'loading') {
    return <p className="remote-cms-note">Loading fields…</p>;
  }
  if (fields.kind === 'failed') {
    return <p className="remote-cms-note remote-cms-failure">{fields.message}</p>;
  }
  if (fields.fields.length === 0) {
    return <p className="remote-cms-note">No fields to show as columns.</p>;
  }
  return fields.fields.map((field) => (
    <button
      key={field.name}
      type="button"
      role="menuitemcheckbox"
      aria-checked={props.chosen.has(field.name)}
      className="more-menu-item"
      onClick={() => props.onToggle(field, fields.fields)}
    >
      {field.title}
      <span className="remote-cms-column-check">{props.chosen.has(field.name) && <CheckIcon size={12} />}</span>
    </button>
  ));
}
