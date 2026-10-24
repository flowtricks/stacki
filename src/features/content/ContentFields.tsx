import { ErrorToast } from '../../ui/ErrorToast';
import React, { useRef, useState } from 'react';
import type { Data, DataRecord } from '../../../shared/core/boundary';
import { data } from '../../../shared/core/boundary';
import type { WireValidationIssue } from '../../../shared/ipc/ipcResults';
import { assert } from '../../../shared/core/assert';
import { labelize, memberFor, fieldIssue, hintFor } from './contentSchema';
import type { FieldDescriptor } from './contentSchema';
import AssetField from '../../ui/AssetField';
import AutoTextarea from '../../ui/AutoTextarea';
import DateField from '../../ui/DateField';
import HtmlField from '../../ui/HtmlField';
import { containsHTML } from '../../ui/htmlFieldModel';
import { calendarValue } from '../../ui/dateFieldModel';
import ExprInput from '../../ui/ExprInput';
import { ChevronRightIcon, CloseIcon, DragIcon, PlusIcon, TrashIcon } from '../../ui/Icons';
import useListReorder from '../../ui/useListReorder';
import {
  NULL_DATA,
  isPlainObject,
  fieldKey,
  blankFor,
  omitField,
  useTargets,
} from './contentFieldData';
export { isPlainObject, blankFor, omitField } from './contentFieldData';

export interface FieldContext {
  readonly projectPath: string;
  readonly baseDir: string;
  readonly parsed: boolean;
  readonly parserNote: string | undefined;
  readonly expanded: ReadonlySet<string>;
  readonly expand: (key: string) => void;
  readonly inFile: (path: readonly (string | number)[]) => boolean;
  readonly issueAt: (path: readonly (string | number)[]) => string | undefined;
}

interface FieldProps {
  readonly field: FieldDescriptor;
  readonly value: Data;
  readonly context: FieldContext;
  readonly path: readonly (string | number)[];
  readonly onChange: (value: Data) => void;
}

function ReferenceField({ field, value, context, onChange }: FieldProps) {
  const targets = useTargets(context.projectPath, field.target);
  const selected = typeof value === 'string' ? value : '';
  const known = targets?.some((target) => target.id === selected);
  return (
    <div className="content-ref">
      <select
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          onChange(next === '' ? (field.nullable ? NULL_DATA : undefined) : next);
        }}
      >
        <option value="">{field.nullable ? 'None' : 'Choose an entry…'}</option>
        {(targets ?? []).map((target) => (
          <option key={target.id} value={target.id}>
            {target.title === target.id ? target.id : `${target.title} — ${target.id}`}
          </option>
        ))}
        {selected && targets && !known && <option value={selected}>{selected} (missing)</option>}
      </select>
      {selected && targets && !known && (
        <div className="content-warn">
          Nothing in {field.target} has the id “{selected}”.
        </div>
      )}
    </div>
  );
}

function ReferenceList({ field, value, context, onChange }: FieldProps) {
  const targets = useTargets(context.projectPath, field.target);
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const remaining = (targets ?? []).filter((target) => !values.includes(target.id));
  return (
    <div className="content-reflist">
      {values.map((id, index) => {
        const target = (targets ?? []).find((entry) => entry.id === id);
        return (
          <div key={`${id}-${index}`} className="content-chip">
            <span className={target ? '' : 'missing'}>
              {target ? target.title : `${id} (missing)`}
            </span>
            <button
              className="ghost"
              title="Remove"
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            >
              <CloseIcon size={9} />
            </button>
          </div>
        );
      })}
      <select
        value=""
        disabled={remaining.length === 0}
        onChange={(event) => {
          if (event.target.value) {
            onChange([...values, event.target.value]);
          }
        }}
      >
        <option value="">{remaining.length ? 'Add…' : 'Nothing left to add'}</option>
        {remaining.map((target) => (
          <option key={target.id} value={target.id}>
            {target.title === target.id ? target.id : `${target.title} — ${target.id}`}
          </option>
        ))}
      </select>
    </div>
  );
}

function TagsField({ value, onChange }: Pick<FieldProps, 'value' | 'onChange'>) {
  const values = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const [draft, setDraft] = useState('');
  const add = (): void => {
    const next = draft.trim();
    if (next) {
      onChange([...values, next]);
      setDraft('');
    }
  };
  return (
    <div className="content-tags">
      {values.map((tag, index) => (
        <span key={`${tag}-${index}`} className="content-chip">
          {tag}
          <button
            className="ghost"
            title="Remove"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
          >
            <CloseIcon size={9} />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder="Add…"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => handleTagKey(event, draft, values, add, onChange)}
      />
    </div>
  );
}

function handleTagKey(
  event: React.KeyboardEvent<HTMLInputElement>,
  draft: string,
  values: readonly string[],
  add: () => void,
  onChange: (value: Data) => void,
): void {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    add();
  } else if (event.key === 'Backspace' && !draft && values.length > 0) {
    onChange(values.slice(0, -1));
  }
}

function RecordField(props: FieldProps) {
  const values = isPlainObject(props.value) ? props.value : {};
  const [adding, setAdding] = useState('');
  const item = props.field.value;
  return (
    <div className="cms-group-box">
      {Object.entries(values).map(([key, value]) => (
        <div key={key} className="content-record-row">
          <div className="content-record-head">
            <input
              className="content-key"
              value={key}
              onChange={(event) => props.onChange(renameRecordKey(values, key, event.target.value))}
            />
            <button
              className="ghost danger"
              title="Remove"
              onClick={() => props.onChange(omitField(values, key))}
            >
              <TrashIcon size={11} />
            </button>
          </div>
          {item && (
            <FieldControl
              field={{ ...item, key }}
              value={value}
              context={props.context}
              path={[...props.path, key]}
              onChange={(next) => props.onChange({ ...values, [key]: next })}
            />
          )}
        </div>
      ))}
      <div className="content-record-add">
        <input
          value={adding}
          placeholder="New key…"
          onChange={(event) => setAdding(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              addRecordItem(values, item, adding, setAdding, props.onChange);
            }
          }}
        />
        <button
          className="cms-add"
          disabled={!adding.trim()}
          onClick={() => addRecordItem(values, item, adding, setAdding, props.onChange)}
        >
          <PlusIcon size={11} /> Add
        </button>
      </div>
    </div>
  );
}

function renameRecordKey(values: DataRecord, key: string, replacement: string): DataRecord {
  return Object.fromEntries(
    Object.entries(values).map(([entryKey, value]) => [
      entryKey === key ? replacement : entryKey,
      value,
    ]),
  );
}

function addRecordItem(
  values: DataRecord,
  item: FieldDescriptor | undefined,
  adding: string,
  setAdding: React.Dispatch<React.SetStateAction<string>>,
  onChange: (value: Data) => void,
): void {
  const key = adding.trim();
  if (key) {
    onChange({ ...values, [key]: blankFor(item) });
    setAdding('');
  }
}

export function UnionField(props: FieldProps) {
  const member = memberFor(props.field, props.value);
  const remembered = useRef(new Map<string, DataRecord>());
  const discriminator = props.field.discriminator;
  const current = isPlainObject(props.value) ? props.value : {};
  const switchTo = (next: string): void => {
    const target = props.field.members?.find((entry) => String(entry.value) === next);
    if (!target) {
      return;
    }
    remembered.current.set(String(discriminator ? current[discriminator] : ''), current);
    const previous = remembered.current.get(String(target.value)) ?? {};
    const kept = unionFields(target.fields, previous, current);
    props.onChange({
      ...(discriminator ? { [discriminator]: data(target.value) } : {}),
      ...kept,
    });
  };
  return (
    <div className="content-union">
      {discriminator && (
        <div className="content-union-head">
          <label>{labelize(discriminator)}</label>
          <select
            value={String(current[discriminator] ?? '')}
            onChange={(event) => switchTo(event.target.value)}
          >
            {(props.field.members ?? []).map((entry) => (
              <option key={String(entry.value)} value={String(entry.value)}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="cms-group-box">
        {(member?.fields ?? []).map((field) => {
          const key = fieldKey(field);
          return (
            <FieldRow
              key={key}
              field={field}
              value={current[key]}
              context={props.context}
              path={[...props.path, key]}
              onChange={(value) =>
                props.onChange(
                  value === undefined ? omitField(current, key) : { ...current, [key]: value },
                )
              }
            />
          );
        })}
      </div>
    </div>
  );
}

function unionFields(
  fields: readonly FieldDescriptor[],
  previous: DataRecord,
  current: DataRecord,
): DataRecord {
  const entries = fields.flatMap((field): readonly [string, Data][] => {
    const key = fieldKey(field);
    if (key in previous) {
      return [[key, previous[key]]];
    }
    if (key in current) {
      return [[key, current[key]]];
    }
    return field.required ? [[key, blankFor(field)]] : [];
  });
  return Object.fromEntries(entries);
}

function ListField(props: FieldProps) {
  const values = Array.isArray(props.value) ? props.value : [];
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const item = props.field.item;
  const minimum = props.field.constraints.minItems ?? 0;
  const maximum = props.field.constraints.maxItems ?? Number.MAX_SAFE_INTEGER;
  const move = (from: number, to: number): void => {
    if (from === to) {
      return;
    }
    const next = [...values];
    const moved = next[from];
    assert(moved !== undefined, 'List reorder source must exist');
    next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    props.onChange(next);
  };
  const reorder = useListReorder({ count: values.length, onMove: move });
  const complex = item?.control === 'object' || item?.control === 'union';
  if (!complex) {
    return (
      <SimpleList {...props} values={values} item={item} minimum={minimum} maximum={maximum} />
    );
  }
  return (
    <ComplexList
      {...props}
      values={values}
      item={item}
      minimum={minimum}
      maximum={maximum}
      openIndex={openIndex}
      setOpenIndex={setOpenIndex}
      reorder={reorder}
    />
  );
}

interface ListProps extends FieldProps {
  readonly values: readonly Data[];
  readonly item: FieldDescriptor | undefined;
  readonly minimum: number;
  readonly maximum: number;
}

function SimpleList(props: ListProps) {
  return (
    <div className="content-simple-list">
      {props.values.map((value, index) => (
        <div key={index} className="content-simple-row">
          {props.item && (
            <FieldControl
              field={props.item}
              value={value}
              context={props.context}
              path={[...props.path, index]}
              onChange={(next) =>
                props.onChange(
                  props.values.map((old, itemIndex) => (itemIndex === index ? next : old)),
                )
              }
            />
          )}
          <button
            className="ghost danger"
            title="Remove"
            disabled={props.values.length <= props.minimum}
            onClick={() =>
              props.onChange(props.values.filter((_, itemIndex) => itemIndex !== index))
            }
          >
            <TrashIcon size={11} />
          </button>
        </div>
      ))}
      <AddListButton {...props} />
    </div>
  );
}

interface ComplexListProps extends ListProps {
  readonly openIndex: number | undefined;
  readonly setOpenIndex: React.Dispatch<React.SetStateAction<number | undefined>>;
  readonly reorder: ReturnType<typeof useListReorder>;
}

function ComplexList(props: ComplexListProps) {
  const openValue = props.openIndex === undefined ? undefined : props.values[props.openIndex];
  return (
    <div className="cms-repeater">
      {props.values.map((value, index) => (
        <div
          key={index}
          className={`cms-repeat-row ${props.reorder.rowClass(index)}`}
          {...props.reorder.rowProps(index)}
          onClick={() => props.setOpenIndex(index === props.openIndex ? undefined : index)}
        >
          <span className="cms-repeat-grip">
            <DragIcon size={11} />
          </span>
          <span className="cms-repeat-title">{listTitle(props.item, value, index)}</span>
          <button
            className="ghost"
            title="Remove"
            disabled={props.values.length <= props.minimum}
            onClick={(event) => {
              event.stopPropagation();
              props.onChange(props.values.filter((_, itemIndex) => itemIndex !== index));
              props.setOpenIndex(undefined);
            }}
          >
            <CloseIcon size={10} />
          </button>
          <ChevronRightIcon size={10} />
        </div>
      ))}
      {props.item && openValue !== undefined && props.openIndex !== undefined && (
        <div className="content-open-item">
          <FieldControl
            field={props.item}
            value={openValue}
            context={props.context}
            path={[...props.path, props.openIndex]}
            onChange={(next) =>
              props.onChange(
                props.values.map((old, itemIndex) => (itemIndex === props.openIndex ? next : old)),
              )
            }
          />
        </div>
      )}
      <AddListButton {...props} onAdded={(index) => props.setOpenIndex(index)} />
    </div>
  );
}

function AddListButton(props: ListProps & { readonly onAdded?: (index: number) => void }) {
  return (
    <button
      className="cms-add"
      disabled={props.values.length >= props.maximum}
      onClick={() => {
        props.onChange([...props.values, blankFor(props.item)]);
        props.onAdded?.(props.values.length);
      }}
    >
      <PlusIcon size={11} /> Add{' '}
      {props.field.label ? props.field.label.replace(/s$/, '').toLowerCase() : 'item'}
    </button>
  );
}

function listTitle(item: FieldDescriptor | undefined, value: Data, index: number): string {
  if (!isPlainObject(value)) {
    return String(value ?? `Item ${index + 1}`);
  }
  if (item?.control === 'union' && item.discriminator) {
    const member = item.members?.find((entry) => entry.value === value[item.discriminator ?? '']);
    const label = member?.label ?? value[item.discriminator];
    const name = value['heading'] ?? value['title'] ?? value['label'] ?? value['id'];
    return name ? `${String(label)} — ${String(name)}` : String(label);
  }
  for (const key of ['title', 'name', 'label', 'heading', 'question', 'status']) {
    if (value[key]) {
      return String(value[key]);
    }
  }
  return `Item ${index + 1}`;
}

function ScalarControl(props: FieldProps) {
  const { field, value, onChange } = props;
  switch (field.control) {
    case 'boolean':
      return (
        <button
          type="button"
          className={`cms-toggle ${value ? 'on' : ''}`}
          onClick={() => onChange(!value)}
        >
          <span className="cms-toggle-knob" />
          <span className="cms-toggle-label">{value ? 'On' : 'Off'}</span>
        </button>
      );
    case 'number':
      return <NumberField {...props} />;
    case 'enum':
      return <EnumField {...props} />;
    case 'date':
      return (
        <DateField
          label={field.label}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next || undefined)}
        />
      );
    case 'const':
      return <input value={String(field.const)} readOnly />;
    case 'unknown':
    case 'image':
    case 'reference':
    case 'references':
    case 'tags':
    case 'list':
    case 'record':
    case 'object':
    case 'union':
    case 'markdown':
    case 'code':
    case 'url':
    case 'email':
    case 'longtext':
    case 'text':
      return <TextField {...props} />;
  }
}

function NumberField({ field, value, onChange }: FieldProps) {
  return (
    <input
      type="number"
      step={field.constraints.integer ? 1 : 'any'}
      min={field.constraints.min}
      max={field.constraints.max}
      value={typeof value === 'number' ? value : ''}
      placeholder={'default' in field ? String(field.default) : ''}
      onChange={(event) =>
        onChange(event.target.value === '' ? undefined : Number(event.target.value))
      }
    />
  );
}

function EnumField({ field, value, onChange }: FieldProps) {
  return (
    <select
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(event) => onChange(event.target.value || undefined)}
    >
      {!field.required && <option value="">Not set</option>}
      {(field.options ?? []).map((option) => (
        <option key={String(option)} value={String(option)}>
          {labelize(String(option))}
        </option>
      ))}
    </select>
  );
}

function TextField({ field, value, onChange }: FieldProps) {
  return (
    <input
      value={value === null || value === undefined ? '' : String(value)}
      placeholder={'default' in field ? String(field.default) : ''}
      spellCheck={field.control !== 'text'}
      onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

export function FieldControl(props: FieldProps) {
  const text = typeof props.value === 'string' ? props.value : '';
  if (['text', 'longtext', 'unknown'].includes(props.field.control)) {
    if (containsHTML(text)) {
      return <HtmlField value={text} label={props.field.label} onChange={props.onChange} />;
    }
    if (calendarValue(text)) {
      return (
        <DateField
          value={text}
          label={props.field.label}
          onChange={(next) => props.onChange(next || undefined)}
        />
      );
    }
  }
  return <TypedFieldControl {...props} />;
}

function TypedFieldControl(props: FieldProps) {
  const text = typeof props.value === 'string' ? props.value : '';
  switch (props.field.control) {
    case 'image':
      return (
        <AssetField
          value={text}
          mediaKind="image"
          projectPath={props.context.projectPath}
          baseDir={props.context.baseDir}
          onChange={(value) => props.onChange(value || undefined)}
        />
      );
    case 'reference':
      return <ReferenceField {...props} />;
    case 'references':
      return <ReferenceList {...props} />;
    case 'tags':
      return <TagsField value={props.value} onChange={props.onChange} />;
    case 'markdown':
    case 'longtext':
      return (
        <AutoTextarea
          value={text}
          minRows={props.field.control === 'markdown' ? 3 : 2}
          onChange={(event) => props.onChange(event.target.value)}
        />
      );
    case 'code':
      return (
        <ExprInput
          value={text}
          syncValue={text}
          onChange={props.onChange}
          onCommit={(value) => {
            if (value !== props.value) {
              props.onChange(value);
            }
          }}
        />
      );
    case 'object':
      return <ObjectField {...props} />;
    case 'record':
      return <RecordField {...props} />;
    case 'union':
      return <UnionField {...props} />;
    case 'list':
      return <ListField {...props} />;
    case 'number':
    case 'boolean':
    case 'unknown':
    case 'date':
    case 'enum':
    case 'const':
    case 'url':
    case 'email':
    case 'text':
      return <ScalarControl {...props} />;
  }
}

function ObjectField(props: FieldProps) {
  const values = isPlainObject(props.value) ? props.value : {};
  return (
    <div className="cms-group-box">
      {(props.field.fields ?? []).map((field) => {
        const key = fieldKey(field);
        return (
          <FieldRow
            key={key}
            field={field}
            value={values[key]}
            context={props.context}
            path={[...props.path, key]}
            onChange={(value) =>
              props.onChange(
                value === undefined ? omitField(values, key) : { ...values, [key]: value },
              )
            }
          />
        );
      })}
    </div>
  );
}

export function FieldRow(props: FieldProps) {
  const present = props.value !== undefined;
  const issue =
    props.context.issueAt(props.path) ??
    (present
      ? fieldIssue(props.field, props.value)
      : props.field.required
        ? 'Required'
        : undefined);
  const hint = hintFor(props.field);
  const synthesized = props.context.parsed && !props.context.inFile(props.path);
  const pathKey = props.path.join('.');
  if (!present && !props.field.required && !props.context.expanded.has(pathKey)) {
    return <AddOptionalField {...props} pathKey={pathKey} />;
  }
  return (
    <div className={`cms-field ${props.field.control} ${issue ? 'has-issue' : ''}`}>
      <FieldHeader {...props} present={present} synthesized={synthesized} />
      {props.value === null ? (
        <div className="content-null">None</div>
      ) : (
        <FieldControl {...props} />
      )}
      {issue ? (
        <ErrorToast message={issue} />
      ) : hint ? (
        <div className="content-hint">{hint}</div>
      ) : undefined}
    </div>
  );
}

function AddOptionalField(props: FieldProps & { readonly pathKey: string }) {
  return (
    <div className="content-add-field">
      <button className="ghost" onClick={() => props.context.expand(props.pathKey)}>
        <PlusIcon size={10} /> {props.field.label}
      </button>
      {'default' in props.field && (
        <span className="content-default">defaults to {JSON.stringify(props.field.default)}</span>
      )}
    </div>
  );
}

function FieldHeader(
  props: FieldProps & { readonly present: boolean; readonly synthesized: boolean },
) {
  return (
    <div className="cms-field-head">
      <label>
        {props.field.label}
        {props.field.required && (
          <span className="content-required" title="Required">
            {' '}
            *
          </span>
        )}
      </label>
      {props.field.nullable && (
        <button
          className={`content-none ${props.value === null ? 'on' : ''}`}
          title="Write null — the key stays, with no value"
          onClick={() => props.onChange(props.value === null ? blankFor(props.field) : NULL_DATA)}
        >
          None
        </button>
      )}
      {!props.field.required && props.present && (
        <button
          className="ghost content-clear"
          title="Remove this field"
          onClick={() => props.onChange(undefined)}
        >
          <CloseIcon size={9} />
        </button>
      )}
      {props.synthesized && (
        <span className="content-note" title={props.context.parserNote}>
          from the parser
        </span>
      )}
    </div>
  );
}

export function issueMessageAt(
  issues: readonly WireValidationIssue[],
  path: readonly (string | number)[],
): string | undefined {
  const found = issues.find(
    (issue) =>
      issue.path.length === path.length &&
      issue.path.every((part, index) => String(part) === String(path[index])),
  );
  return found?.message;
}
