// A content collection's settings, in the main view where its items show:
// its name, and its fields in order — dragged to reorder, clicked to open
// their settings in place (name, help text, minimum and maximum, required),
// deleted or duplicated, and new ones added. Changes are held in a copy until
// Save collection (settingsDraft.ts), which takes any field form still open and
// writes them to the content config, with the entries and code that depend on
// them (astroCollectionSettings.ts).
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { CollectionSettings, NewFieldKind, SettingsChange, SettingsField, SettingsFieldKind } from '../../../shared/properties/collectionSettings';
import { newFieldSettings, pointsAtCollection } from '../../../shared/properties/collectionSettings';
import { confirmDialog } from '../../ui/ConfirmDialog';
import Dropdown from '../../ui/Dropdown';
import { ElementImageIcon, ElementLinkIcon, ElementListDefaultIcon, ElementSelectIcon, ElementVideoIcon } from '../../ui/ElementIcons';
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
import { changeCollectionSettings, collectionSettings, remoteCollections } from '../../ipc/remoteSource';
import { applyDrafts, fieldSettingsOf, newFieldFormState, openFieldFormState, replayDrafts, type FieldFormState } from './settingsDraft';
import { FieldInputs } from './RemoteFieldSettings';

// Stages changes together, or none of them, and says whether it did.
type Change = (changes: readonly SettingsChange[]) => boolean;

// The two forms that can be open at once, and how each reports what it would save.
type FormSlot = 'adding' | 'open';
type FormReport = (slot: FormSlot, state: FieldFormState | undefined) => void;
type OpenForms = Readonly<Record<FormSlot, FieldFormState | undefined>>;

const NO_FORMS: OpenForms = { adding: undefined, open: undefined };

export function RemoteCollectionSettings(props: {
  readonly projectPath: string;
  readonly selection: RemoteCmsSelection;
  readonly onSelect: (selection: RemoteCmsSelection | undefined) => void;
  /** After a save that went through whole, before the items show again. */
  readonly onSaved: () => void;
}) {
  const { selection } = props;
  const editing = useSettingsDraft(props);
  const { draft, error } = editing;
  return (
    <div className="cms-detail remote-cms-settings">
      <div className="cms-detail-head remote-cms-toolbar">
        <button className="ghost cms-back" title="Back to the items" onClick={() => props.onSelect({ ...selection, mode: undefined })}>
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
        <button className="primary" disabled={!editing.dirty || editing.blocked || editing.saving} onClick={() => void editing.save()}>
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
              <FieldList key={editing.formRound} settings={draft} collections={editing.collections} onChange={editing.stage} onForm={editing.reportForm} />
              <div className="remote-cms-settings-danger">
                <button className="danger" disabled={editing.saving} onClick={() => void editing.remove()}>
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
  readonly onSaved: () => void;
}) {
  const { projectPath, selection } = props;
  const [saved, setSaved] = useState<CollectionSettings | undefined>(undefined);
  const [draft, setDraft] = useState<CollectionSettings | undefined>(undefined);
  const [changes, setChanges] = useState<readonly SettingsChange[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [forms, setForms] = useState<OpenForms>(NO_FORMS);
  // Moves on when Save takes the open forms' fields, which closes those forms:
  // left open, a field already staged would be staged again by the next Save.
  const [formRound, setFormRound] = useState(0);
  const collections = useCollectionNames(projectPath, selection.connection.id);
  const show = (settings: CollectionSettings) => {
    setSaved(settings);
    setDraft(settings);
    setChanges([]);
    setName(settings.name);
  };
  useEffect(() => {
    void collectionSettings(projectPath, selection.collection).then((read) => (read.ok ? show(read.value) : setError(read.message)));
  }, [projectPath, selection.collection]);
  const reportForm = useCallback<FormReport>((slot, state) => setForms((current) => ({ ...current, [slot]: state })), []);
  const stage: Change = (made) => {
    const next = draft === undefined ? undefined : applyDrafts(draft, made);
    if (next !== undefined && !next.ok) {
      setError(next.message);
    }
    if (next?.ok === true) {
      setError(undefined);
      setDraft(next.value);
      setChanges((staged) => [...staged, ...made]);
    }
    return next?.ok === true;
  };
  const renamed = saved !== undefined && name.trim() !== '' && name.trim() !== saved.name;
  const pending = [...readyChanges(forms.open), ...readyChanges(forms.adding)];
  const save = async () => {
    if (pending.length > 0) {
      if (!stage(pending)) {
        return;
      }
      setFormRound((round) => round + 1);
    }
    setSaving(true);
    const staged = [...changes, ...pending];
    const all = renamed ? [...staged, { kind: 'renameCollection' as const, to: name.trim() }] : staged;
    const result = await sendChanges(projectPath, selection.collection, all);
    setSaving(false);
    setError(result.error);
    if (result.settings === undefined) {
      return;
    }
    // Refused: what reached the config is shown as saved, and what did not stays
    // staged, the refused change with it, to be fixed and saved again. The
    // collection's rename goes last, so nothing is ever left after it, and its
    // typed name stays in its box.
    if (result.error !== undefined) {
      const kept = replayDrafts(result.settings, staged.slice(result.sent));
      setSaved(result.settings);
      setDraft(kept.value);
      setChanges(kept.changes);
      return;
    }
    // Saved whole: back to the items, which a field rename or delete may have
    // rewritten, so they are read again.
    show(result.settings);
    props.onSaved();
    props.onSelect({ ...selection, collection: result.settings.name, mode: undefined });
  };
  const cancel = () => (saved === undefined ? undefined : show(saved));
  const remove = () => deleteWholeCollection({ ...props, setError });
  const dirty = changes.length > 0 || renamed || pending.length > 0;
  // A form that cannot be saved holds Save back rather than being dropped by it.
  const blocked = forms.open?.kind === 'invalid' || forms.adding?.kind === 'invalid';
  return { draft, error, saving, dirty, blocked, name, setName, collections, stage, save, cancel, remove, reportForm, formRound };
}

function readyChanges(state: FieldFormState | undefined): readonly SettingsChange[] {
  return state?.kind === 'ready' ? state.changes : [];
}

function useCollectionNames(projectPath: string, connectionId: string): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([]);
  useEffect(() => {
    void remoteCollections(projectPath, connectionId).then((read) => setNames(read.ok ? read.value.map((each) => each.name) : []));
  }, [projectPath, connectionId]);
  return names;
}

// The changes, one by one and in order; the first refused stops the rest, and the
// settings as they then stand come back with why, and how many changes landed.
async function sendChanges(
  projectPath: string,
  collection: string,
  changes: readonly SettingsChange[],
): Promise<{
  readonly settings: CollectionSettings | undefined;
  readonly error: string | undefined;
  readonly sent: number;
}> {
  let name = collection;
  let settings: CollectionSettings | undefined;
  let sent = 0;
  for (const change of changes) {
    const changed = await changeCollectionSettings(projectPath, name, change);
    if (!changed.ok) {
      const read = await collectionSettings(projectPath, name);
      return { settings: read.ok ? read.value : settings, error: changed.message, sent };
    }
    settings = changed.value;
    name = changed.value.name;
    sent += 1;
  }
  return { settings, error: undefined, sent };
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

function CollectionName(props: { readonly settings: CollectionSettings; readonly name: string; readonly onName: (name: string) => void }) {
  return (
    <section className="remote-cms-settings-section">
      <label className="remote-cms-settings-label">
        Collection name
        <input value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <p className="remote-cms-settings-hint">
        Renaming updates the content config
        {props.settings.source ? `, ${props.settings.source}` : ''} and the code that reads this collection.
      </p>
    </section>
  );
}

function FieldList(props: {
  readonly settings: CollectionSettings;
  readonly collections: readonly string[];
  readonly onChange: Change;
  readonly onForm: FormReport;
}) {
  const { fields } = props.settings;
  const [open, setOpen] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const reorder = useListReorder({
    count: fields.length,
    disabled: open !== undefined,
    onMove: (from, to) => void props.onChange([{ kind: 'reorder', order: moved(fields, from, to) }]),
  });
  return (
    <section className="remote-cms-settings-section">
      <h3 className="remote-cms-settings-label">Fields</h3>
      <div className="remote-cms-settings-fields">
        {fields.map((field, index) =>
          field.name === open ? (
            <FieldEditor
              key={field.name}
              settings={props.settings}
              field={field}
              onChange={props.onChange}
              onForm={props.onForm}
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
        <AddField settings={props.settings} collections={props.collections} onChange={props.onChange} onForm={props.onForm} onClose={() => setAdding(false)} />
      ) : (
        <button className="remote-cms-settings-add" onClick={() => setAdding(true)}>
          <PlusIcon size={12} /> Add field
        </button>
      )}
    </section>
  );
}

// Tells the settings what an open form would save, for as long as the form is open.
function useFormReport(slot: FormSlot, state: FieldFormState, onForm: FormReport): void {
  useEffect(() => {
    onForm(slot, state);
    return () => onForm(slot, undefined);
  }, [slot, state, onForm]);
}

// One field's settings, open in its row: saved together, renamed first when its name changed.
function FieldEditor(props: {
  readonly settings: CollectionSettings;
  readonly field: SettingsField;
  readonly onChange: Change;
  readonly onForm: FormReport;
  readonly onClose: () => void;
}) {
  const { field, settings } = props;
  const [draft, setDraft] = useState(field);
  const state = useMemo(() => openFieldFormState(settings, field, draft), [settings, field, draft]);
  useFormReport('open', state, props.onForm);
  const save = () => {
    if (props.onChange(readyChanges(state))) {
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
        <button className="ghost remote-cms-settings-tool" title="Delete field" onClick={() => void removeField(props)}>
          <TrashIcon size={13} />
        </button>
        <button className="ghost remote-cms-settings-tool" title="Duplicate field" disabled={!duplicable(field.kind)} onClick={() => duplicateField(props)}>
          <CopyIcon size={13} />
        </button>
        <button onClick={props.onClose}>Cancel</button>
        <button className="primary" disabled={state.kind !== 'ready'} onClick={save}>
          Save field
        </button>
      </div>
      <FieldInputs field={field} draft={draft} nameProblem={state.kind === 'invalid' ? state.message : undefined} onDraft={setDraft} />
    </div>
  );
}

// Adding a field: first its kind, from a grid of every kind a collection can
// hold, then its name, for a reference the collection it points at, and the
// same settings an existing field opens with — written with the field at once.
function AddField(props: {
  readonly settings: CollectionSettings;
  readonly collections: readonly string[];
  readonly onChange: Change;
  readonly onForm: FormReport;
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
              <button key={option} type="button" className="remote-cms-settings-kind-tile" onClick={() => setKind(option)}>
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
  readonly settings: CollectionSettings;
  readonly kind: NewFieldKind;
  readonly collections: readonly string[];
  readonly onChange: Change;
  readonly onForm: FormReport;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const { settings, kind } = props;
  // The settings a new field of this kind is written with until they are changed.
  const [field] = useState<SettingsField>(() => ({
    name: '',
    kind,
    ...newFieldSettings(kind),
    editable: true,
  }));
  const [draft, setDraft] = useState(field);
  const pointing = pointsAtCollection(kind);
  // The collections may still be loading when the form opens, so an unchosen target follows them.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const target = chosen ?? props.collections[0] ?? '';
  const state = useMemo(() => newFieldFormState(settings, { draft, kind, target }), [settings, draft, kind, target]);
  useFormReport('adding', state, props.onForm);
  const add = () => {
    if (props.onChange(readyChanges(state))) {
      props.onClose();
    }
  };
  return (
    <div className="remote-cms-settings-editor">
      <div className="remote-cms-settings-editor-head">
        <KindIcon kind={kind} />
        <span className="remote-cms-settings-name">New {KIND_LABELS[kind].toLowerCase()} field</span>
        <span className="remote-cms-settings-spacer" />
        <button onClick={props.onBack}>Back</button>
        <button className="primary" disabled={state.kind !== 'ready'} onClick={add}>
          Add field
        </button>
      </div>
      {pointing && (
        <label className="remote-cms-settings-label">
          Collection
          <Dropdown
            value={target}
            livePreview={false}
            options={props.collections.map((each) => ({ value: each, label: labelize(each) }))}
            onChange={setChosen}
          />
        </label>
      )}
      <FieldInputs field={field} draft={draft} nameProblem={state.kind === 'invalid' ? state.message : undefined} onDraft={setDraft} autoFocusName />
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
    props.onChange([{ kind: 'removeField', name: props.field.name }]);
  }
}

// A copy: a new field of the same kind beside it, given the same settings.
function duplicateField(props: { readonly field: SettingsField; readonly onChange: Change }) {
  const { field } = props;
  if (!duplicable(field.kind)) {
    return;
  }
  props.onChange([{ kind: 'addField', name: `${field.name}-copy`, fieldKind: field.kind, target: undefined, settings: fieldSettingsOf(field) }]);
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
