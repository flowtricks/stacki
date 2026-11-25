// One field's settings, open in its row of a collection's settings: its name
// and help text, the checks its kind is most often given, the rest of them
// under Advanced validation, and whether it is required. Values are drafts:
// RemoteCollectionSettings.tsx saves them with the field.
import { useMemo, useState } from 'react';
import {
  COLLECTION_SETTINGS_LIMITS,
  fieldAsMember,
  ITEM_KINDS,
  itemKindOf,
  listKindOf,
  MEMBER_KINDS,
  memberAsField,
  newFieldMembers,
  newFieldSettings,
  typedFieldName,
  type ItemKind,
  type SettingsField,
  type SettingsFieldKind,
  type SettingsMember,
} from '../../../shared/properties/collectionSettings';
import { checksFor, FIELD_CHECKS, type FieldCheckKey, type FieldChecks } from '../../../shared/properties/fieldChecks';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import Dropdown from '../../ui/Dropdown';
import { ErrorToast } from '../../ui/ErrorToast';
import InfoHint from '../../ui/InfoHint';
import { ChevronDownIcon, ChevronRightIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import { checkLabel, choicesFor, typedValue, withCheck } from './fieldCheckInputs';
import { resolvedMembers } from './settingsDraft';
import { KIND_ICONS, KindIcon, kindOptions } from './settingsKindIcons';
import { KIND_LABELS } from './settingsKindLabels';

type Draft = (draft: SettingsField) => void;

export function FieldInputs(props: {
  readonly field: SettingsField;
  readonly draft: SettingsField;
  /** A new field's form starts in its name; an open field's does not move focus. */
  readonly autoFocusName?: boolean;
  /** Why the name cannot be saved, said in a toast; the box is tinted. The text stays as typed. */
  readonly nameProblem: string | undefined;
  readonly onDraft: Draft;
  /**
   * The form of one field of a group, opened in its row: the row has the name and the required box, so the form
   * leaves them out. `depth` counts the groups above the field, which bounds how deep groups nest.
   */
  readonly member?: { readonly depth: number; readonly itemsLocked: boolean } | undefined;
}) {
  const { draft, onDraft, nameProblem } = props;
  const translate = useTranslate();
  const depth = props.member?.depth ?? 0;
  return (
    <div className="field-settings">
      <div className="field-settings-grid">
        {props.member === undefined && (
          <Labelled
            label={translate('cmsRemote.fieldSettings.name')}
            wide
            hint={props.field.editable ? savedKeyHint(draft.name, translate) : translate('cmsRemote.fieldSettings.methodNote')}
          >
            <input
              autoFocus={props.autoFocusName === true}
              aria-invalid={nameProblem !== undefined}
              value={draft.name}
              onChange={(event) => onDraft({ ...draft, name: event.target.value })}
            />
            <ErrorToast message={nameProblem} />
          </Labelled>
        )}
        {props.field.editable && (
          <Labelled label={translate('cmsRemote.fieldSettings.helpText')} wide>
            <textarea
              rows={2}
              placeholder={translate('cmsRemote.fieldSettings.helpPlaceholder')}
              value={draft.description ?? ''}
              onChange={(event) => onDraft({ ...draft, description: event.target.value })}
            />
          </Labelled>
        )}
        {props.field.editable && draft.kind === 'option' && <OptionValues draft={draft} onDraft={onDraft} />}
      </div>
      {props.field.editable && draft.kind === 'group' && <MembersEditor draft={draft} onDraft={onDraft} depth={depth} title="cmsRemote.group.fields" />}
      {props.field.editable && <ListItems draft={draft} onDraft={onDraft} depth={depth} locked={props.member?.itemsLocked === true} />}
      {props.field.editable ? (
        <FieldRules draft={draft} onDraft={onDraft} requiredBox={props.member === undefined} />
      ) : (
        props.member !== undefined && (
          <span className="field-settings-label">
            <InfoHint text={translate('cmsRemote.fieldSettings.methodNote')} />
          </span>
        )
      )}
    </div>
  );
}

// The key a typed label is saved as, when that is not what was typed: the name label's `?` tip says so.
function savedKeyHint(typed: string, translate: Translator): string | undefined {
  const name = typedFieldName(typed);
  if (name.kind === 'key' && name.key !== typed.trim()) {
    return translate('cmsRemote.fieldSettings.savedAs', { key: name.key });
  }
  return undefined;
}

// The kind's common checks, the others behind a disclosure, then Required.
function FieldRules(props: { readonly draft: SettingsField; readonly onDraft: Draft; readonly requiredBox: boolean }) {
  const { draft, onDraft } = props;
  const translate = useTranslate();
  const [advanced, setAdvanced] = useState(false);
  const all = checksFor(draft.kind);
  const common = all.filter((key) => COMMON_CHECKS.includes(key));
  const more = all.filter((key) => !COMMON_CHECKS.includes(key));
  const setCheck = (key: FieldCheckKey, value: FieldChecks[FieldCheckKey]) => onDraft({ ...draft, checks: withCheck(draft.checks, key, value) });
  return (
    <>
      {common.length > 0 && <CheckGroup keys={common} draft={draft} onCheck={setCheck} />}
      <button type="button" className="field-settings-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
        {advanced ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        {translate('cmsRemote.fieldSettings.advanced')}
      </button>
      {advanced && (
        <div className="field-settings-advanced">
          <CheckGroup keys={more} draft={draft} onCheck={setCheck} />
          <div className="field-settings-grid">
            <DefaultInput draft={draft} onDraft={onDraft} />
          </div>
        </div>
      )}
      {props.requiredBox && (
        <label className="field-settings-required">
          <input type="checkbox" checked={draft.required} onChange={(event) => onDraft({ ...draft, required: event.target.checked })} />
          <span>{translate('cmsRemote.fieldSettings.required')}</span>
        </label>
      )}
    </>
  );
}

const COMMON_CHECKS: readonly FieldCheckKey[] = ['min', 'max', 'integer', 'minDate', 'maxDate', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'];

// Checks laid out by what they take: values two to a row, switches together under them.
function CheckGroup(props: {
  readonly keys: readonly FieldCheckKey[];
  readonly draft: SettingsField;
  readonly onCheck: (key: FieldCheckKey, value: FieldChecks[FieldCheckKey]) => void;
}) {
  const valued = props.keys.filter((key) => FIELD_CHECKS[key] !== 'flag');
  const flags = props.keys.filter((key) => FIELD_CHECKS[key] === 'flag');
  return (
    <>
      {valued.length > 0 && (
        <div className="field-settings-grid">
          {valued.map((key) => (
            <CheckInput key={key} name={key} draft={props.draft} onCheck={props.onCheck} />
          ))}
        </div>
      )}
      {flags.length > 0 && (
        <div className="field-settings-flags">
          {flags.map((key) => (
            <label key={key} className="field-settings-flag">
              <input type="checkbox" checked={props.draft.checks[key] === true} onChange={(event) => props.onCheck(key, event.target.checked || undefined)} />
              <span>{checkLabel(key, props.draft.kind)}</span>
            </label>
          ))}
        </div>
      )}
    </>
  );
}

// One check that takes a value: a number, a date, a line of text, or a choice.
function CheckInput(props: {
  readonly name: FieldCheckKey;
  readonly draft: SettingsField;
  readonly onCheck: (key: FieldCheckKey, value: FieldChecks[FieldCheckKey]) => void;
}) {
  const { name, draft } = props;
  const translate = useTranslate();
  const value = draft.checks[name];
  const label = checkLabel(name, draft.kind);
  const type = FIELD_CHECKS[name];
  switch (type) {
    case 'sign':
    case 'case':
      return (
        <Labelled label={label}>
          <Dropdown
            value={typeof value === 'string' ? value : ''}
            livePreview={false}
            options={choicesFor(type)}
            onChange={(next) => props.onCheck(name, next === '' ? undefined : next)}
          />
        </Labelled>
      );
    case 'number':
    case 'date':
    case 'text':
      return (
        <Labelled label={label} wide={name === 'pattern'}>
          <input
            type={type === 'text' ? 'text' : type}
            placeholder={exampleText(name, translate)}
            value={value === undefined || typeof value === 'boolean' ? '' : value}
            onChange={(event) => props.onCheck(name, typedValue(type, event.target.value))}
          />
        </Labelled>
      );
    case 'flag':
      return undefined;
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

// The sample value each check's box hints at; the "E.g." in front is the language's own.
const EXAMPLES: { readonly [K in FieldCheckKey]?: string } = {
  min: '20',
  max: '140',
  length: '6',
  gt: '0',
  lt: '100',
  multipleOf: '5',
  pattern: '^[a-z0-9-]+$',
  startsWith: 'https://',
  endsWith: '.pdf',
  includes: '@',
  minWidth: '800',
  maxWidth: '2400',
  minHeight: '600',
  maxHeight: '1600',
};

function exampleText(key: FieldCheckKey, translate: Translator): string | undefined {
  const value = EXAMPLES[key];
  return value === undefined ? undefined : translate('cmsRemote.fieldSettings.example', { value });
}

function OptionValues(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  const translate = useTranslate();
  return (
    <Labelled label={translate('cmsRemote.fieldSettings.options')} wide>
      <textarea
        rows={4}
        placeholder={translate('cmsRemote.fieldSettings.optionsPlaceholder')}
        defaultValue={(props.draft.options ?? []).join('\n')}
        onChange={(event) => {
          const options = event.target.value
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '');
          props.onDraft({ ...props.draft, options: options.length > 0 ? options : undefined });
        }}
      />
    </Labelled>
  );
}

// The value an entry gets when it leaves the field out, as the field's kind holds one.
function DefaultInput(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  const { draft } = props;
  const translate = useTranslate();
  const set = (defaultValue: SettingsField['defaultValue']) => props.onDraft({ ...draft, defaultValue });
  const current = draft.defaultValue === undefined ? '' : String(draft.defaultValue);
  if (draft.kind === 'switch' || draft.kind === 'option') {
    const values = draft.kind === 'switch' ? ['true', 'false'] : (draft.options ?? []);
    const named = (each: string) => (each === 'true' ? translate('cmsRemote.common.on') : each === 'false' ? translate('cmsRemote.common.off') : each);
    return (
      <Labelled label={translate('cmsRemote.fieldSettings.default')}>
        <Dropdown
          value={current}
          livePreview={false}
          options={[{ value: '', label: translate('cmsRemote.common.none') }, ...values.map((each) => ({ value: each, label: named(each) }))]}
          onChange={(next) => set(next === '' ? undefined : draft.kind === 'switch' ? next === 'true' : next)}
        />
      </Labelled>
    );
  }
  if (!TYPED_DEFAULTS.includes(draft.kind)) {
    return undefined;
  }
  const number = draft.kind === 'number';
  return (
    <Labelled label={translate('cmsRemote.fieldSettings.default')}>
      <input
        type={number ? 'number' : 'text'}
        placeholder={translate('cmsRemote.fieldSettings.defaultPlaceholder')}
        value={current}
        onChange={(event) => {
          const typed = event.target.value;
          set(typed === '' ? undefined : number ? Number(typed) : typed);
        }}
      />
    </Labelled>
  );
}

const TYPED_DEFAULTS: readonly SettingsField['kind'][] = ['text', 'richText', 'link', 'videoLink', 'email', 'phone', 'color', 'file', 'number'];

function Labelled(props: { readonly label: string; readonly wide?: boolean; readonly hint?: string | undefined; readonly children: React.ReactNode }) {
  return (
    <label className={`field-settings-field ${props.wide === true ? 'is-wide' : ''}`}>
      <span className="field-settings-label">
        {props.label}
        {props.hint !== undefined && <InfoHint text={props.hint} />}
      </span>
      {props.children}
    </label>
  );
}

// --- What a group and a list hold -------------------------------------------------------------------------

const ITEM_LABELS: Readonly<Record<ItemKind, MessageKey>> = {
  text: 'cmsRemote.fieldType.plainText',
  number: 'cmsRemote.fieldType.number',
  link: 'cmsRemote.fieldType.link',
  email: 'cmsRemote.fieldType.email',
  switch: 'cmsRemote.fieldType.switch',
  date: 'cmsRemote.fieldType.dateTime',
  group: 'cmsRemote.items.group',
};

// A list item's kind as the field kind whose icon it wears.
const ITEM_ICON_KINDS: Readonly<Record<ItemKind, SettingsFieldKind>> = {
  text: 'text',
  number: 'number',
  link: 'link',
  email: 'email',
  switch: 'switch',
  date: 'date',
  group: 'group',
};

/**
 * What a list field holds: the kind of each item (plain text by default, or a group of fields for a repeater such
 * as team members), and, for a group, the fields of each item, edited with the editor a group field uses.
 * `locked` shows the kind without a choice: an item kind that is already in a group's saved field is not rewritten
 * from here.
 */
export function ListItems(props: { readonly draft: SettingsField; readonly onDraft: Draft; readonly depth: number; readonly locked: boolean }) {
  const { draft, onDraft } = props;
  const translate = useTranslate();
  const item = itemKindOf(draft);
  if (item === undefined) {
    return undefined;
  }
  const kinds = ITEM_KINDS.filter((kind) => kind !== 'group' || props.depth < COLLECTION_SETTINGS_LIMITS.memberDepthMax);
  // Another kind of item rewrites the list's items; a group starts with a title field.
  const choose = (next: ItemKind) =>
    onDraft({
      ...draft,
      kind: listKindOf(next),
      itemKind: next === 'group' ? undefined : next,
      members: next === 'group' ? (draft.members ?? newFieldMembers('repeater')) : undefined,
    });
  return (
    <section className="list-items">
      <span className="field-settings-label">
        {translate('cmsRemote.items.title')}
        <InfoHint text={item === 'other' ? `${translate('cmsRemote.items.hint')} ${translate('cmsRemote.items.byHand')}` : translate('cmsRemote.items.hint')} />
      </span>
      {item === 'other' ? undefined : props.locked ? (
        <span className="list-items-kind">
          <KindIcon kind={ITEM_ICON_KINDS[item]} /> {translate(ITEM_LABELS[item])}
        </span>
      ) : (
        <Dropdown
          value={item}
          livePreview={false}
          ariaLabel={translate('cmsRemote.items.title')}
          options={kinds.map((kind) => {
            const Icon = KIND_ICONS[ITEM_ICON_KINDS[kind]];
            return { value: kind, label: translate(ITEM_LABELS[kind]), icon: <Icon size={14} /> };
          })}
          onChange={(next) => {
            const kind = ITEM_KINDS.find((candidate) => candidate === next);
            if (kind !== undefined) {
              choose(kind);
            }
          }}
        />
      )}
      {item === 'group' && <MembersEditor draft={draft} onDraft={onDraft} depth={props.depth} title="cmsRemote.items.fields" />}
    </section>
  );
}

// The kinds a field of a group may be chosen as: no repeater (a list of groups is made from a list), and no group
// where the next level would nest past the bound.
function memberKinds(depth: number): readonly SettingsFieldKind[] {
  const nests = depth + 1 < COLLECTION_SETTINGS_LIMITS.memberDepthMax;
  return MEMBER_KINDS.filter((kind) => kind !== 'repeater' && (nests || kind !== 'group'));
}

/**
 * A group's fields (a group field's own, or each item's of a list of groups): added, named, typed from the same
 * kinds and icons as a collection's field picker, made required, dragged to reorder, removed, and opened to the
 * very form a collection's fields have (help text, checks, options, a default, and the fields of a group inside).
 * A kept field's checks stay as the content config has them until its form changes them (astroSchemaEdit.ts).
 * Values are drafts: RemoteCollectionSettings.tsx saves them with the field.
 */
export function MembersEditor(props: { readonly draft: SettingsField; readonly onDraft: Draft; readonly depth: number; readonly title: MessageKey }) {
  const { draft, onDraft, depth } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const members = useMemo(() => draft.members ?? [], [draft.members]);
  const problem = resolvedMembers(draft, depth);
  const set = (next: readonly SettingsMember[]) => onDraft({ ...draft, members: next });
  const change = (index: number, next: SettingsMember) => set(members.map((each, position) => (position === index ? next : each)));
  const reorder = useListReorder({
    count: members.length,
    onMove: (from, to) => set(moved(members, from, to)),
  });
  const full = members.length >= COLLECTION_SETTINGS_LIMITS.membersMax;
  const kinds = memberKinds(depth);
  return (
    <div className="list-items-fields">
      <span className="field-settings-label">{translate(props.title)}</span>
      {members.map((member, index) => (
        <MemberRow
          key={member.from ?? `new-${index}`}
          member={member}
          kinds={kinds}
          depth={depth}
          rowClass={reorder.rowClass(index)}
          rowProps={reorder.rowProps(index)}
          onChange={(next) => change(index, next)}
          onRemove={() => set(members.filter((_, position) => position !== index))}
        />
      ))}
      <ErrorToast message={problem.ok ? undefined : translateDescribed(problem)} />
      <button
        type="button"
        className="remote-cms-settings-add"
        disabled={full}
        onClick={() => set([...members, { name: '', kind: 'text', required: false, from: undefined, editable: true }])}
      >
        <PlusIcon size={12} /> {translate('cmsRemote.settings.addField')}
      </button>
    </div>
  );
}

type RowProps = ReturnType<ReturnType<typeof useListReorder>['rowProps']>;

function MemberRow(props: {
  readonly member: SettingsMember;
  readonly kinds: readonly SettingsFieldKind[];
  readonly depth: number;
  readonly rowClass: string;
  readonly rowProps: RowProps;
  readonly onChange: (member: SettingsMember) => void;
  readonly onRemove: () => void;
}) {
  const { member, onChange } = props;
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const fresh = member.from === undefined;
  // A new field's kind is chosen here, and starts from that kind's own settings.
  const pickKind = (kind: SettingsFieldKind) => {
    const starting = newFieldSettings(kind === 'other' ? 'any' : kind);
    onChange({
      ...member,
      kind,
      checks: starting.checks,
      options: starting.options,
      defaultValue: undefined,
      members: newFieldMembers(kind),
      itemKind: kind === 'list' ? 'text' : undefined,
    });
  };
  const configurable = member.editable && member.kind !== 'other';
  return (
    <div className="list-items-member">
      <div className={`list-items-row ${props.rowClass}`} {...props.rowProps}>
        <span className="remote-cms-grip">
          <DragIcon size={12} />
        </span>
        <KindIcon kind={member.kind} />
        <input
          aria-label={translate('cmsRemote.items.fieldName')}
          placeholder={translate('cmsRemote.items.fieldName')}
          disabled={!member.editable}
          value={member.name}
          onChange={(event) => onChange({ ...member, name: event.target.value })}
        />
        {fresh ? (
          <Dropdown
            value={member.kind}
            livePreview={false}
            ariaLabel={translate('cmsRemote.items.fieldType')}
            options={kindOptions(props.kinds, translate)}
            onChange={(next) => {
              const kind = props.kinds.find((candidate) => candidate === next);
              if (kind !== undefined) {
                pickKind(kind);
              }
            }}
          />
        ) : (
          <span className="list-items-kind">{translate(KIND_LABELS[member.kind])}</span>
        )}
        <label className="field-settings-flag">
          <input
            type="checkbox"
            disabled={!member.editable}
            checked={member.required}
            onChange={(event) => onChange({ ...member, required: event.target.checked })}
          />
          <span>{translate('cmsRemote.settings.required')}</span>
        </label>
        <button
          type="button"
          className="ghost remote-cms-settings-tool"
          aria-expanded={open}
          aria-label={translate('cmsRemote.items.fieldSettings')}
          title={translate('cmsRemote.items.fieldSettings')}
          disabled={!configurable}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDownIcon size={13} /> : <ChevronRightIcon size={13} />}
        </button>
        <button type="button" className="ghost remote-cms-settings-tool" title={translate('cmsRemote.items.removeField')} onClick={props.onRemove}>
          <TrashIcon size={13} />
        </button>
      </div>
      {open && configurable && (
        <div className="list-items-member-settings">
          <FieldInputs
            field={memberAsField(member)}
            draft={memberAsField(member)}
            nameProblem={undefined}
            member={{ depth: props.depth + 1, itemsLocked: !fresh }}
            onDraft={(next) => onChange(fieldAsMember({ ...next, name: member.name, required: member.required }, member))}
          />
        </div>
      )}
    </div>
  );
}

// The fields after a drag: `from` lands before the row at `to`.
function moved(members: readonly SettingsMember[], from: number, to: number): readonly SettingsMember[] {
  const next = [...members];
  const [member] = next.splice(from, 1);
  if (member !== undefined) {
    next.splice(to > from ? to - 1 : to, 0, member);
  }
  return next;
}
