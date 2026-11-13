import Popup from '../../ui/Popup';
import React, { useState } from 'react';
import type { Collection, CmsField, FieldType } from './cmsSchema';
import type { DeclaredTypes } from './cmsTypes';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';
import { contentFieldsAt, fieldsAt, keyFor } from './cmsSchema';
import { withDeclaredTypes } from './cmsTypes';
import { readCmsUsage, deleteCms } from './cmsBridge';
import { cleanError } from '../../lib/cleanError';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { confirmDialog } from '../../ui/ConfirmDialog';
import useListReorder from '../../ui/useListReorder';
import { FIELD_TYPES } from './cmsFieldTypes';
import { PlusIcon, CloseIcon, ChevronLeftIcon, ChevronRightIcon, TrashIcon, DragIcon, CheckIcon } from '../../ui/Icons';

export interface SchemaOperations {
  readonly onAddField: (path: readonly string[], key: string, type: FieldType) => void;
  readonly onRenameField: (path: readonly string[], from: string, to: string) => boolean;
  readonly onRemoveField: (path: readonly string[], key: string) => void;
  readonly onReorderFields: (path: readonly string[], keys: readonly string[]) => void;
}
interface SchemaProps extends SchemaOperations {
  readonly items: readonly unknown[];
  readonly declared: DeclaredTypes;
  readonly path: readonly string[];
}
export interface CmsSettingsProps extends SchemaOperations {
  readonly collection: Collection;
  readonly items: readonly unknown[];
  readonly declared: DeclaredTypes;
  readonly saved: boolean;
  readonly project: { readonly path: string };
  readonly showToast: (message: string, kind: 'error') => void;
  readonly onDeleted?: (() => void) | undefined;
  readonly onDone?: (() => void) | undefined;
}

// The types you can choose for a new field.
const CREATABLE_TYPES = FIELD_TYPES.filter((entry) => entry.value !== 'code');

function typeInfo(type: FieldType): (typeof FIELD_TYPES)[number] {
  const found = FIELD_TYPES.find((entry) => entry.value === type);
  const fallback = FIELD_TYPES[0];
  assert(fallback !== undefined, 'CMS field types: the list is not empty');
  return found ?? fallback;
}

export default function CmsSettings({
  collection,
  items,
  declared,
  saved,
  project,
  showToast,
  onDeleted,
  onAddField,
  onRenameField,
  onRemoveField,
  onReorderFields,
  onDone,
}: CmsSettingsProps) {
  const translate = useTranslate();
  return (
    <div className="cms-settings">
      <div className="cms-detail-head">
        <button className="ghost cms-back" title={translate('cms.settings.back')} onClick={onDone}>
          <ChevronLeftIcon size={14} />
        </button>
        <span className="cms-detail-title">{translate('cms.settings.title', { name: collection.label })}</span>
        <span className={`cms-saved ${saved ? 'on' : ''}`}>
          <CheckIcon size={11} /> {translate('cms.saved')}
        </span>
        <span className="cms-detail-path">src/{collection.rel}</span>
        <button className="primary" onClick={onDone}>
          {translate('cms.settings.done')}
        </button>
      </div>

      <div className="cms-detail-body">
        <div className="cms-card">
          <h3>{translate('cms.settings.fieldsTitle')}</h3>
          <p className="cms-note">
            {collection.single ? translate('cms.settings.fieldsSingle') : translate('cms.settings.fieldsShared', { count: items.length })}
          </p>
          <FieldSchema
            items={items}
            declared={declared}
            path={[]}
            onAddField={onAddField}
            onRenameField={onRenameField}
            onRemoveField={onRemoveField}
            onReorderFields={onReorderFields}
          />
        </div>

        <DeleteCollectionCard collection={collection} project={project} showToast={showToast} onDeleted={onDeleted} />
      </div>
    </div>
  );
}

function DeleteCollectionCard({ collection, project, showToast, onDeleted }: Pick<CmsSettingsProps, 'collection' | 'project' | 'showToast' | 'onDeleted'>) {
  const translate = useTranslate();
  return (
    <div className="cms-card cms-danger">
      <h3>{translate('cms.settings.deleteCollection')}</h3>
      <p className="cms-note">{translate('cms.settings.deleteNote', { path: collection.rel })}</p>
      <button
        className="ghost danger"
        onClick={() => {
          void deleteCollection(collection, project, showToast, onDeleted, translate).catch((error: unknown) => showToast(cleanError(error), 'error'));
        }}
      >
        <TrashIcon size={12} /> {translate('cms.settings.deleteNamed', { name: collection.label })}
      </button>
    </div>
  );
}

async function deleteCollection(
  collection: Collection,
  project: CmsSettingsProps['project'],
  showToast: CmsSettingsProps['showToast'],
  onDeleted: CmsSettingsProps['onDeleted'],
  translate: Translator,
) {
  const usage = await readCmsUsage(project.path, collection.rel);
  if (!usage.ok) {
    showToast(usage.error, 'error');
    return;
  }
  const used = usage.value.files;
  const shown = used.slice(0, 3).join(', ');
  const files = used.length > 3 ? translate('cms.settings.usageMore', { files: shown, count: used.length - 3 }) : shown;
  const where = used.length === 0 ? translate('cms.settings.usageNone') : translate('cms.settings.usagePages', { count: used.length, files });
  if (
    !(await confirmDialog({
      title: translate('cms.settings.deleteConfirmTitle', { name: collection.label }),
      body: where,
      confirmLabel: translate('cms.settings.deleteCollection'),
      danger: true,
    }))
  ) {
    return;
  }
  const result = await deleteCms(project.path, collection.rel);
  if (!result.ok) {
    showToast(result.error, 'error');
    return;
  }
  onDeleted?.();
}

function FieldSchema({ items, declared, path, ...operations }: SchemaProps) {
  const translate = useTranslate();
  assert(path.length <= BOUNDARY_LIMITS.depthMax, 'CMS schema: nesting limit exceeded');
  const fields = withDeclaredTypes(contentFieldsAt(items, path), declared, path);
  const move = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const keys = fields.map((field) => field.key);
    const [moved] = keys.splice(from, 1);
    assert(moved !== undefined, 'CMS schema: moved field must exist');
    assert(to >= 0, 'CMS schema: target must be nonnegative');
    assert(to <= fields.length, 'CMS schema: target exceeds field count');
    keys.splice(to > from ? to - 1 : to, 0, moved);
    const visible = new Set(keys);
    let next = 0;
    const allKeys = fieldsAt(items, path).map((field) => {
      if (!visible.has(field.key)) {
        return field.key;
      }
      const key = keys[next];
      assert(key !== undefined, 'Visible CMS field order must be complete');
      next += 1;
      return key;
    });
    operations.onReorderFields(path, allKeys);
  };
  const reorder = useListReorder({ count: fields.length, onMove: move });
  return (
    <div className="cms-schema">
      {fields.map((field, index) => (
        <SchemaRow key={field.key} field={field} index={index} reorder={reorder} items={items} declared={declared} path={path} {...operations} />
      ))}
      {fields.length === 0 && <div className="cms-empty-inline">{translate('cms.settings.noFields')}</div>}
      <AddFieldRow compact={path.length > 0} onAdd={(key, type) => operations.onAddField(path, key, type)} />
    </div>
  );
}
interface SchemaRowProps extends SchemaProps {
  readonly field: CmsField;
  readonly index: number;
  readonly reorder: ReturnType<typeof useListReorder>;
}
function SchemaRow({ field, index, reorder, ...props }: SchemaRowProps) {
  const translate = useTranslate();
  // Each keyed row owns one expansion flag; deleted fields cannot accumulate
  // stale keys in a collection-wide set.
  const [open, setOpen] = useState(false);
  const nested = field.type === 'objects' || field.type === 'object';
  const info = typeInfo(field.type);
  const Icon = info.Icon;
  return (
    <div className="cms-schema-group">
      <div className={`cms-schema-row ${reorder.rowClass(index)}`} {...reorder.rowProps(index)}>
        <span className="cms-schema-grip">
          <DragIcon size={11} />
        </span>
        {nested ? (
          <button
            className="ghost cms-schema-expand"
            title={open ? translate('cms.settings.hideFields') : translate('cms.settings.showFields')}
            onClick={() => setOpen(!open)}
          >
            <ChevronRightIcon size={10} className={open ? 'rotated' : ''} />
          </button>
        ) : (
          <span className="cms-schema-expand" />
        )}
        <SchemaName field={field} path={props.path} onRenameField={props.onRenameField} />
        <span className="cms-schema-type" title={translate('cms.settings.typeFixed')}>
          <Icon size={13} />
          {translate(info.label)}
        </span>
        <SchemaDelete field={field} path={props.path} onRemoveField={props.onRemoveField} />
      </div>
      {nested && open && (
        <div className="cms-schema-nested">
          <FieldSchema {...props} path={[...props.path, field.key]} />
        </div>
      )}
    </div>
  );
}
function SchemaName({ field, path, onRenameField }: Pick<SchemaRowProps, 'field' | 'path' | 'onRenameField'>) {
  return (
    <input
      key={field.key}
      className="cms-schema-name"
      defaultValue={field.label}
      spellCheck={false}
      maxLength={BOUNDARY_LIMITS.pathLengthMax}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setInputText(event.currentTarget, field.label);
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = keyFor(event.target.value);
        if (!next || !onRenameField(path, field.key, next)) {
          setInputText(event.target, field.label);
        }
      }}
    />
  );
}
// An uncontrolled input's text is the element's own state, set in place.
function setInputText(inputElement: HTMLInputElement, text: string): void {
  inputElement.value = text;
}

function SchemaDelete({ field, path, onRemoveField }: Pick<SchemaRowProps, 'field' | 'path' | 'onRemoveField'>) {
  const translate = useTranslate();
  return (
    <button
      className="ghost danger"
      title={translate('cms.settings.deleteField')}
      onClick={() => {
        // The confirm dialog answers yes or no; it never rejects.
        void confirmDialog({
          title: translate('cms.settings.deleteFieldTitle', { name: field.label }),
          body: translate('cms.settings.deleteFieldBody'),
          confirmLabel: translate('cms.settings.deleteField'),
          danger: true,
        }).then((confirmed) => {
          if (confirmed) {
            onRemoveField(path, field.key);
          }
        });
      }}
    >
      <TrashIcon size={12} />
    </button>
  );
}

type AddField = (key: string, type: FieldType) => void;
function AddFieldRow({ onAdd, compact }: { readonly onAdd: AddField; readonly compact: boolean }) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`cms-add ${compact ? 'compact' : ''}`} onClick={() => setOpen(true)}>
        <PlusIcon size={11} /> {translate('cms.addField')}
      </button>
      {open && (
        <NewFieldDialog
          onAdd={(key, type) => {
            onAdd(key, type);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
interface NewFieldProps {
  readonly onAdd: AddField;
  readonly onClose: () => void;
}
function NewFieldDialog({ onAdd, onClose }: NewFieldProps) {
  const [type, setType] = useState<FieldType | undefined>();
  const [name, setName] = useState('');
  const translate = useTranslate();
  const info = type === undefined ? undefined : typeInfo(type);
  return (
    <Popup className="modal cms-modal cms-type-modal" onClose={onClose} dismissible={true}>
      {({ close }) => (
        <>
          <div className="modal-header cms-modal-header">
            {type && (
              <button className="ghost" title={translate('cms.settings.backToTypes')} onClick={() => setType(undefined)}>
                <ChevronLeftIcon size={13} />
              </button>
            )}
            <span>{info ? translate('cms.settings.newField', { type: translate(info.label) }) : translate('cms.settings.chooseType')}</span>
            <button className="ghost" title={translate('ui.close')} onClick={close}>
              <CloseIcon size={12} />
            </button>
          </div>
          {type === undefined ? (
            <div className="cms-type-grid">
              {CREATABLE_TYPES.map(({ value, label, Icon, hint }) => (
                <button key={value} className="cms-type-tile" onClick={() => setType(value)}>
                  <Icon size={18} />
                  <span className="cms-type-name">{translate(label)}</span>
                  <span className="cms-type-hint">{translate(hint)}</span>
                </button>
              ))}
            </div>
          ) : (
            <NewFieldName type={type} name={name} setName={setName} onAdd={onAdd} onClose={close} />
          )}
        </>
      )}
    </Popup>
  );
}
interface NewFieldNameProps extends NewFieldProps {
  readonly type: FieldType;
  readonly name: string;
  readonly setName: (name: string) => void;
}
function NewFieldName({ type, name, setName, onAdd, onClose }: NewFieldNameProps) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const info = typeInfo(type);
  const submit = () => {
    const key = keyFor(name);
    if (key) {
      onAdd(key, type);
    }
  };
  return (
    <>
      <div className="modal-body">
        <div>
          <label>{translate('cms.settings.nameLabel')}</label>
          <input
            autoFocus
            value={name}
            maxLength={BOUNDARY_LIMITS.pathLengthMax}
            placeholder={translate('cms.settings.nameExample', {
              name: info.value === 'text' ? translate('cms.settings.nameExampleText') : translate(info.label),
            })}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
          />
        </div>
        {keyFor(name) && (
          <div className="cms-note" style={{ margin: 0 }}>
            {translateRich('cms.settings.codeKey', { key: <code>{keyFor(name)}</code> })}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="ghost" onClick={onClose}>
          {translate('ui.cancel')}
        </button>
        <button className="primary" onClick={submit} disabled={!keyFor(name)}>
          {translate('cms.addField')}
        </button>
      </div>
    </>
  );
}
