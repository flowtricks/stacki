// What a list field holds, in its settings form: the kind of each item (plain
// text by default, or a group of fields for a repeater such as team members),
// and, for a group, the fields of each item — added, renamed, made required,
// dragged to reorder and removed. A kept field's other checks stay as the
// content config has them; only its name and whether it is required change
// here (astroSchemaEdit.ts). Values are drafts: RemoteCollectionSettings.tsx
// saves them with the field.
import { useMemo } from 'react';
import {
  COLLECTION_SETTINGS_LIMITS,
  ITEM_KINDS,
  itemKindOf,
  listKindOf,
  MEMBER_KINDS,
  newFieldMembers,
  type ItemKind,
  type SettingsField,
  type SettingsMember,
} from '../../../shared/properties/collectionSettings';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import type { MessageKey } from '../../lib/i18n/localeContext';
import Dropdown from '../../ui/Dropdown';
import { DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import { resolvedMembers } from './settingsDraft';
import { KIND_LABELS } from './settingsKindLabels';

type Draft = (draft: SettingsField) => void;

const ITEM_LABELS: Readonly<Record<ItemKind, MessageKey>> = {
  text: 'cmsRemote.fieldType.plainText',
  number: 'cmsRemote.fieldType.number',
  link: 'cmsRemote.fieldType.link',
  email: 'cmsRemote.fieldType.email',
  switch: 'cmsRemote.fieldType.switch',
  date: 'cmsRemote.fieldType.dateTime',
  group: 'cmsRemote.items.group',
};

export function ListItems(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  const { draft, onDraft } = props;
  const translate = useTranslate();
  const item = itemKindOf(draft);
  if (item === undefined) {
    return undefined;
  }
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
      <span className="field-settings-label">{translate('cmsRemote.items.title')}</span>
      <p className="field-settings-note">{translate('cmsRemote.items.hint')}</p>
      {item === 'other' ? (
        <p className="field-settings-note">{translate('cmsRemote.items.byHand')}</p>
      ) : (
        <Dropdown
          value={item}
          livePreview={false}
          options={ITEM_KINDS.map((kind) => ({ value: kind, label: translate(ITEM_LABELS[kind]) }))}
          onChange={(next) => {
            const kind = ITEM_KINDS.find((candidate) => candidate === next);
            if (kind !== undefined) {
              choose(kind);
            }
          }}
        />
      )}
      {item === 'group' && <MemberRows draft={draft} onDraft={onDraft} />}
    </section>
  );
}

function MemberRows(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  const { draft, onDraft } = props;
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const members = useMemo(() => draft.members ?? [], [draft.members]);
  const problem = resolvedMembers(draft);
  const set = (next: readonly SettingsMember[]) => onDraft({ ...draft, members: next });
  const reorder = useListReorder({
    count: members.length,
    onMove: (from, to) => set(moved(members, from, to)),
  });
  const full = members.length >= COLLECTION_SETTINGS_LIMITS.membersMax;
  return (
    <div className="list-items-fields">
      <span className="field-settings-label">{translate('cmsRemote.items.fields')}</span>
      {members.map((member, index) => (
        <div key={member.from ?? `new-${index}`} className={`list-items-row ${reorder.rowClass(index)}`} {...reorder.rowProps(index)}>
          <span className="remote-cms-grip">
            <DragIcon size={12} />
          </span>
          <input
            aria-label={translate('cmsRemote.items.fieldName')}
            placeholder={translate('cmsRemote.items.fieldName')}
            disabled={!member.editable}
            value={member.name}
            onChange={(event) => set(members.map((each, position) => (position === index ? { ...each, name: event.target.value } : each)))}
          />
          {member.from === undefined ? (
            <Dropdown
              value={member.kind}
              livePreview={false}
              options={MEMBER_KINDS.map((kind) => ({ value: kind, label: translate(KIND_LABELS[kind]) }))}
              onChange={(next) => {
                const kind = MEMBER_KINDS.find((candidate) => candidate === next);
                if (kind !== undefined) {
                  set(members.map((each, position) => (position === index ? { ...each, kind } : each)));
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
              onChange={(event) => set(members.map((each, position) => (position === index ? { ...each, required: event.target.checked } : each)))}
            />
            <span>{translate('cmsRemote.settings.required')}</span>
          </label>
          <button
            type="button"
            className="ghost remote-cms-settings-tool"
            title={translate('cmsRemote.items.removeField')}
            onClick={() => set(members.filter((_, position) => position !== index))}
          >
            <TrashIcon size={13} />
          </button>
        </div>
      ))}
      {!problem.ok && <span className="remote-cms-problem">{translateDescribed(problem)}</span>}
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

// The fields after a drag: `from` lands before the row at `to`.
function moved(members: readonly SettingsMember[], from: number, to: number): readonly SettingsMember[] {
  const next = [...members];
  const [member] = next.splice(from, 1);
  if (member !== undefined) {
    next.splice(to > from ? to - 1 : to, 0, member);
  }
  return next;
}
