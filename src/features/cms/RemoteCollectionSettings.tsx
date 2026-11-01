// A content collection's settings, in the main view where its items show:
// its name, and its fields in order — dragged to reorder, clicked to open
// their settings in place (name, help text, minimum and maximum, required),
// deleted or duplicated, and new ones added. Each change is written to the
// content config at once, with the entries and code that depend on it
// (astroCollectionSettings.ts), and the view shows the config as it then is.
import { useEffect, useState, type ReactElement } from 'react';
import type {
  CollectionSettings,
  NewFieldKind,
  SettingsChange,
  SettingsField,
  SettingsFieldKind,
} from '../../../shared/properties/collectionSettings';
import { pointsAtCollection } from '../../../shared/properties/collectionSettings';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import {
  ElementImageIcon,
  ElementLinkIcon,
  ElementListDefaultIcon,
  ElementSelectIcon,
  ElementVideoIcon,
} from '../../ui/ElementIcons';
import { ErrorToast } from '../../ui/ErrorToast';
import type { IconProps } from '../../ui/IconBase';
import {
  BracesIcon,
  CalendarIcon,
  ChevronLeftIcon,
  CollectionIcon,
  CopyIcon,
  DragIcon,
  DropletIcon,
  FieldNumberIcon,
  FieldSwitchIcon,
  MailIcon,
  ParagraphIcon,
  PaperclipIcon,
  PhoneIcon,
  PlusIcon,
  TagIcon,
  TextIcon,
  TrashIcon,
} from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import { labelize } from './cmsSchema';
import type { RemoteCmsSelection } from './remoteCmsShared';
import { changeCollectionSettings, collectionSettings, remoteCollections } from './remoteSource';
import { applyDraft } from './settingsDraft';
import { FieldInputs } from './RemoteFieldSettings';

type Change = (change: SettingsChange) => Promise<boolean>;

export function RemoteCollectionSettings(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly onSelect: (selection: RemoteCmsSelection | undefined) => void;
}) {
  const { selection } = props;
  const editing = useSettingsDraft(props);
  const { draft, error } = editing;
  return (
    <div className="cms-detail remote-cms-settings">
      <div className="cms-detail-head remote-cms-toolbar">
        <button
          className="ghost cms-back"
          title="Back to the items"
          onClick={() => props.onSelect({ ...selection, mode: undefined })}
        >
          <ChevronLeftIcon size={13} />
        </button>
        <span className="cms-detail-title">{labelize(selection.collection)} settings</span>
        {/* Cancel drops any changes and leaves the settings, as a CMS's own does. */}
        <button
          disabled={editing.saving}
          onClick={() => {
            editing.cancel();
            props.onSelect({ ...selection, mode: undefined });
          }}
        >
          Cancel
        </button>
        <button
          className="primary"
          disabled={!editing.dirty || editing.saving}
          onClick={() => void editing.save()}
        >
          {editing.saving ? 'Saving…' : 'Save collection'}
        </button>
      </div>
      <div className="cms-detail-body">
        <div className="remote-cms-settings-body">
          {error && <ErrorToast message={error} />}
          {draft === undefined ? (
            !error && <p className="remote-cms-note">Loading…</p>
          ) : (
            <>
              <CollectionName settings={draft} name={editing.name} onName={editing.setName} />
              <FieldList
                settings={draft}
                collections={editing.collections}
                onChange={editing.stage}
              />
              <div className="remote-cms-settings-danger">
                <button
                  className="danger"
                  disabled={editing.saving}
                  onClick={() => void editing.remove()}
                >
                  <TrashIcon size={12} /> Delete collection
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// The settings as saved, the copy being edited and the changes made to it, in
// order; Save sends them one by one, Cancel drops them (settingsDraft.ts).
function useSettingsDraft(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly onSelect: (selection: RemoteCmsSelection | undefined) => void;
}) {
  const { projectPath, selection } = props;
  const [saved, setSaved] = useState<CollectionSettings | undefined>(undefined);
  const [draft, setDraft] = useState<CollectionSettings | undefined>(undefined);
  const [changes, setChanges] = useState<readonly SettingsChange[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const collections = useCollectionNames(projectPath, selection.connection.id);
  const show = (settings: CollectionSettings) => {
    setSaved(settings);
    setDraft(settings);
    setChanges([]);
    setName(settings.name);
  };
  useEffect(() => {
    void collectionSettings(projectPath, selection.collection).then((read) =>
      read.ok ? show(read.value) : setError(read.message),
    );
  }, [projectPath, selection.collection]);
  const stage: Change = async (change) => {
    const next = draft === undefined ? undefined : applyDraft(draft, change);
    if (next !== undefined && !next.ok) {
      setError(next.message);
    }
    if (next?.ok === true) {
      setError(undefined);
      setDraft(next.value);
      setChanges((made) => [...made, change]);
    }
    return Promise.resolve(next?.ok === true);
  };
  const renamed = saved !== undefined && name.trim() !== '' && name.trim() !== saved.name;
  const save = async () => {
    setSaving(true);
    const all = renamed
      ? [...changes, { kind: 'renameCollection' as const, to: name.trim() }]
      : changes;
    const result = await sendChanges(projectPath, selection.collection, all);
    setSaving(false);
    setError(result.error);
    if (result.settings !== undefined) {
      show(result.settings);
      if (result.settings.name !== selection.collection) {
        props.onSelect({ ...selection, collection: result.settings.name, mode: 'settings' });
      }
    }
  };
  const cancel = () => (saved === undefined ? undefined : show(saved));
  const remove = () => deleteWholeCollection({ ...props, setError });
  const dirty = changes.length > 0 || renamed;
  return { draft, error, saving, dirty, name, setName, collections, stage, save, cancel, remove };
}

function useCollectionNames(projectPath: string, connectionId: string): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([]);
  useEffect(() => {
    void remoteCollections(projectPath, connectionId).then((read) =>
      setNames(read.ok ? read.value.map((each) => each.name) : []),
    );
  }, [projectPath, connectionId]);
  return names;
}

// The changes, one by one and in order; the first refused stops the rest, and the
// settings as they then stand are shown, with why.
async function sendChanges(
  projectPath: string,
  collection: string,
  changes: readonly SettingsChange[],
): Promise<{
  readonly settings: CollectionSettings | undefined;
  readonly error: string | undefined;
}> {
  let name = collection;
  let settings: CollectionSettings | undefined;
  for (const change of changes) {
    const changed = await changeCollectionSettings(projectPath, name, change);
    if (!changed.ok) {
      const read = await collectionSettings(projectPath, name);
      return { settings: read.ok ? read.value : settings, error: changed.message };
    }
    settings = changed.value;
    name = changed.value.name;
  }
  return { settings, error: undefined };
}

async function deleteWholeCollection(context: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly onSelect: (selection: RemoteCmsSelection | undefined) => void;
  readonly setError: (message: string | undefined) => void;
}): Promise<void> {
  const { selection } = context;
  const confirmed = await confirmDialog({
    title: `Delete ${labelize(selection.collection)}?`,
    body:
      'Its entries move to the Trash, it leaves the content config, fields in other ' +
      'collections that point at it are removed, and code that reads it gets nothing to read.',
    confirmLabel: 'Delete collection',
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  const deleted = await changeCollectionSettings(context.projectPath, selection.collection, {
    kind: 'deleteCollection',
  });
  if (deleted.ok) {
    context.onSelect(undefined);
  } else {
    context.setError(deleted.message);
  }
}

function CollectionName(props: {
  readonly settings: CollectionSettings;
  readonly name: string;
  readonly onName: (name: string) => void;
}) {
  return (
    <section className="remote-cms-settings-section">
      <label className="remote-cms-settings-label">
        Collection name
        <input value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <p className="remote-cms-settings-hint">
        Renaming updates the content config
        {props.settings.source ? `, ${props.settings.source}` : ''} and the code that reads this
        collection.
      </p>
    </section>
  );
}

function FieldList(props: {
  readonly settings: CollectionSettings;
  readonly collections: readonly string[];
  readonly onChange: Change;
}) {
  const { fields } = props.settings;
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const reorder = useListReorder({
    count: fields.length,
    disabled: open !== undefined,
    onMove: (from, to) => void props.onChange({ kind: 'reorder', order: moved(fields, from, to) }),
  });
  return (
    <section className="remote-cms-settings-section">
      <h3 className="remote-cms-settings-label">Fields</h3>
      <div className="remote-cms-settings-fields">
        {fields.map((field, index) =>
          field.name === open ? (
            <FieldEditor
              key={field.name}
              field={field}
              onChange={props.onChange}
              onClose={() => setOpen(undefined)}
            />
          ) : (
            <div
              key={field.name}
              className={`remote-cms-settings-field ${reorder.rowClass(index)}`}
              {...reorder.rowProps(index)}
              onClick={() => setOpen(field.name)}
            >
              <span className="remote-cms-grip">
                <DragIcon size={12} />
              </span>
              <KindIcon kind={field.kind} />
              <span className="remote-cms-settings-name">{field.name}</span>
              <span className="remote-cms-settings-kind">({KIND_LABELS[field.kind]})</span>
              {field.required && <span className="remote-cms-settings-required">Required</span>}
            </div>
          ),
        )}
      </div>
      {adding ? (
        <AddField
          collections={props.collections}
          onChange={props.onChange}
          onClose={() => setAdding(false)}
        />
      ) : (
        <button className="remote-cms-settings-add" onClick={() => setAdding(true)}>
          <PlusIcon size={12} /> Add field
        </button>
      )}
    </section>
  );
}

// One field's settings, open in its row: saved together, renamed first when its name changed.
function FieldEditor(props: {
  readonly field: SettingsField;
  readonly onChange: Change;
  readonly onClose: () => void;
}) {
  const { field } = props;
  const [draft, setDraft] = useState(field);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const renamed =
      draft.name === field.name ||
      (await props.onChange({ kind: 'renameField', from: field.name, to: draft.name }));
    const update = { ...draft, description: draft.description?.trim() || undefined };
    const saved =
      renamed && (!field.editable || (await props.onChange({ kind: 'updateField', update })));
    setBusy(false);
    if (saved) {
      props.onClose();
    }
  };
  return (
    <div className="remote-cms-settings-editor">
      {/* The field keeps its row's icon, name and kind while it is open, with its actions. */}
      <div className="remote-cms-settings-editor-head">
        <KindIcon kind={field.kind} />
        <span className="remote-cms-settings-name">{field.name}</span>
        <span className="remote-cms-settings-kind">({KIND_LABELS[field.kind]})</span>
        <span className="remote-cms-settings-spacer" />
        <button
          className="ghost remote-cms-settings-tool"
          title="Delete field"
          disabled={busy}
          onClick={() => void removeField(props)}
        >
          <TrashIcon size={13} />
        </button>
        <button
          className="ghost remote-cms-settings-tool"
          title="Duplicate field"
          disabled={busy || !duplicable(field.kind)}
          onClick={() => void duplicateField(props)}
        >
          <CopyIcon size={13} />
        </button>
        <button disabled={busy} onClick={props.onClose}>
          Cancel
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save field'}
        </button>
      </div>
      <FieldInputs field={field} draft={draft} onDraft={setDraft} />
    </div>
  );
}

// Adding a field: first its kind, from a grid of every kind a collection can
// hold, then its name and, for a reference, the collection it points at.
function AddField(props: {
  readonly collections: readonly string[];
  readonly onChange: Change;
  readonly onClose: () => void;
}) {
  const [kind, setKind] = useState<NewFieldKind | undefined>(undefined);
  if (kind === undefined) {
    return (
      <div className="remote-cms-settings-picker">
        <div className="remote-cms-settings-editor-head">
          <span className="remote-cms-settings-name">Select field type</span>
          <span className="remote-cms-settings-spacer" />
          <button className="ghost" onClick={props.onClose}>
            Cancel
          </button>
        </div>
        <div className="remote-cms-settings-kinds">
          {NEW_KINDS.map((option) => {
            const Icon = KIND_ICONS[option];
            return (
              <button
                key={option}
                type="button"
                className="remote-cms-settings-kind-tile"
                onClick={() => setKind(option)}
              >
                <Icon size={22} />
                <span>{KIND_LABELS[option]}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
  return <NewFieldForm {...props} kind={kind} onBack={() => setKind(undefined)} />;
}

function NewFieldForm(props: {
  readonly kind: NewFieldKind;
  readonly collections: readonly string[];
  readonly onChange: Change;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState('');
  const pointing = pointsAtCollection(props.kind);
  const [target, setTarget] = useState(props.collections[0] ?? '');
  const add = async () => {
    const change = {
      kind: 'addField' as const,
      name: name.trim(),
      fieldKind: props.kind,
      target: pointing ? target : undefined,
    };
    if (await props.onChange(change)) {
      props.onClose();
    }
  };
  return (
    <div className="remote-cms-settings-editor">
      <div className="remote-cms-settings-editor-head">
        <KindIcon kind={props.kind} />
        <span className="remote-cms-settings-name">
          New {KIND_LABELS[props.kind].toLowerCase()} field
        </span>
        <span className="remote-cms-settings-spacer" />
        <button onClick={props.onBack}>Back</button>
        <button
          className="primary"
          disabled={name.trim() === '' || (pointing && target === '')}
          onClick={() => void add()}
        >
          Add field
        </button>
      </div>
      <label className="remote-cms-settings-label">
        Name
        <input autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      {pointing && (
        <label className="remote-cms-settings-label">
          Collection
          <Dropdown
            value={target}
            livePreview={false}
            options={props.collections.map((each) => ({ value: each, label: labelize(each) }))}
            onChange={setTarget}
          />
        </label>
      )}
    </div>
  );
}

async function removeField(props: { readonly field: SettingsField; readonly onChange: Change }) {
  const confirmed = await confirmDialog({
    title: `Delete the ${props.field.name} field?`,
    body: 'It is removed from the content config, and its value from every item.',
    confirmLabel: 'Delete field',
    danger: true,
  });
  if (confirmed) {
    await props.onChange({ kind: 'removeField', name: props.field.name });
  }
}

// A copy: a new field of the same kind beside it, given the same settings.
async function duplicateField(props: { readonly field: SettingsField; readonly onChange: Change }) {
  const { field } = props;
  if (!duplicable(field.kind)) {
    return;
  }
  const name = `${field.name}-copy`;
  if (await props.onChange({ kind: 'addField', name, fieldKind: field.kind, target: undefined })) {
    await props.onChange({ kind: 'updateField', update: { ...field, name } });
  }
}

// A reference is not duplicated: the collection it points at is not read back here.
function duplicable(kind: SettingsFieldKind): kind is NewFieldKind {
  return NEW_KINDS.some((option) => option === kind) && !pointsAtCollection(kind);
}

// The order after a drag: `from` lands before the row at `to`.
function moved(fields: readonly SettingsField[], from: number, to: number): readonly string[] {
  const names = fields.map((field) => field.name);
  const [name] = names.splice(from, 1);
  if (name === undefined) {
    return fields.map((field) => field.name);
  }
  names.splice(to > from ? to - 1 : to, 0, name);
  return names;
}

const NEW_KINDS: readonly NewFieldKind[] = [
  'text',
  'richText',
  'image',
  'multiImage',
  'videoLink',
  'link',
  'email',
  'phone',
  'number',
  'date',
  'switch',
  'color',
  'option',
  'file',
  'reference',
  'multiReference',
  'list',
  'group',
  'keyValue',
  'constant',
  'any',
];

const KIND_LABELS: Readonly<Record<SettingsFieldKind, string>> = {
  text: 'Plain text',
  richText: 'Rich text',
  image: 'Image',
  multiImage: 'Multi-image',
  videoLink: 'Video link',
  link: 'Link',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
  date: 'Date/Time',
  switch: 'Switch',
  color: 'Color',
  option: 'Option',
  file: 'File',
  reference: 'Reference',
  multiReference: 'Multi-reference',
  list: 'List',
  group: 'Group',
  keyValue: 'Key–value',
  constant: 'Constant',
  any: 'Any value',
  other: 'Custom',
};

const KIND_ICONS: Readonly<Record<SettingsFieldKind, (props: IconProps) => ReactElement>> = {
  text: TextIcon,
  richText: ParagraphIcon,
  image: ElementImageIcon,
  multiImage: ElementImageIcon,
  videoLink: ElementVideoIcon,
  link: ElementLinkIcon,
  email: MailIcon,
  phone: PhoneIcon,
  number: FieldNumberIcon,
  date: CalendarIcon,
  switch: FieldSwitchIcon,
  color: DropletIcon,
  option: ElementSelectIcon,
  file: PaperclipIcon,
  reference: CollectionIcon,
  multiReference: CollectionIcon,
  list: ElementListDefaultIcon,
  group: BracesIcon,
  keyValue: ElementListDefaultIcon,
  constant: TagIcon,
  any: BracesIcon,
  other: BracesIcon,
};

function KindIcon(props: { readonly kind: SettingsFieldKind }) {
  const Icon = KIND_ICONS[props.kind];
  return (
    <span className="remote-cms-settings-icon">
      <Icon size={12} />
    </span>
  );
}
