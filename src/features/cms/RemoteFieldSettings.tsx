// One field's settings, open in its row of a collection's settings: its name
// and help text, the checks its kind is most often given, the rest of them
// under Advanced validation, and whether it is required. Values are drafts:
// RemoteCollectionSettings.tsx saves them with the field.
import { useState } from 'react';
import { typedFieldName, type SettingsField } from '../../../shared/properties/collectionSettings';
import { checksFor, FIELD_CHECKS, type FieldCheckKey, type FieldChecks } from '../../../shared/properties/fieldChecks';
import Dropdown from '../../ui/Dropdown';
import { ChevronDownIcon, ChevronRightIcon } from '../../ui/Icons';
import { checkLabel, choicesFor, typedValue, withCheck } from './fieldCheckInputs';

type Draft = (draft: SettingsField) => void;

export function FieldInputs(props: {
  readonly field: SettingsField;
  readonly draft: SettingsField;
  /** A new field's form starts in its name; an open field's does not move focus. */
  readonly autoFocusName?: boolean;
  /** Why the name cannot be saved, said under it. The text stays as typed. */
  readonly nameProblem: string | undefined;
  readonly onDraft: Draft;
}) {
  const { draft, onDraft, nameProblem } = props;
  return (
    <div className="field-settings">
      <div className="field-settings-grid">
        <Labelled label="Name" wide>
          <input
            autoFocus={props.autoFocusName === true}
            aria-invalid={nameProblem !== undefined}
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
          {nameProblem === undefined ? <SavedKey typed={draft.name} /> : <span className="remote-cms-problem">{nameProblem}</span>}
        </Labelled>
        {props.field.editable && (
          <Labelled label="Help text" wide>
            <textarea
              rows={2}
              placeholder="Shown under the field’s name to guide whoever edits it"
              value={draft.description ?? ''}
              onChange={(event) => onDraft({ ...draft, description: event.target.value })}
            />
          </Labelled>
        )}
        {props.field.editable && draft.kind === 'option' && <OptionValues draft={draft} onDraft={onDraft} />}
      </div>
      {props.field.editable ? (
        <FieldRules draft={draft} onDraft={onDraft} />
      ) : (
        <p className="field-settings-note">This field is written as a method in the content config: only its name, place and removal change here.</p>
      )}
    </div>
  );
}

// The key a typed label is saved as, when that is not what was typed.
function SavedKey(props: { readonly typed: string }) {
  const name = typedFieldName(props.typed);
  if (name.kind === 'key' && name.key !== props.typed.trim()) {
    return <span className="remote-cms-problem is-note">Saved as {name.key}</span>;
  }
  return undefined;
}

// The kind's common checks, the others behind a disclosure, then Required.
function FieldRules(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  const { draft, onDraft } = props;
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
        Advanced validation
      </button>
      {advanced && (
        <div className="field-settings-advanced">
          <CheckGroup keys={more} draft={draft} onCheck={setCheck} />
          <div className="field-settings-grid">
            <DefaultInput draft={draft} onDraft={onDraft} />
          </div>
        </div>
      )}
      <label className="field-settings-required">
        <input type="checkbox" checked={draft.required} onChange={(event) => onDraft({ ...draft, required: event.target.checked })} />
        <span>This field is required</span>
      </label>
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
            placeholder={PLACEHOLDERS[name]}
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

const PLACEHOLDERS: { readonly [K in FieldCheckKey]?: string } = {
  min: 'E.g. 20',
  max: 'E.g. 140',
  length: 'E.g. 6',
  gt: 'E.g. 0',
  lt: 'E.g. 100',
  multipleOf: 'E.g. 5',
  pattern: 'E.g. ^[a-z0-9-]+$',
  startsWith: 'E.g. https://',
  endsWith: 'E.g. .pdf',
  includes: 'E.g. @',
  minWidth: 'E.g. 800',
  maxWidth: 'E.g. 2400',
  minHeight: 'E.g. 600',
  maxHeight: 'E.g. 1600',
};

function OptionValues(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
  return (
    <Labelled label="Options" wide>
      <textarea
        rows={4}
        placeholder="One option per line"
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
  const set = (defaultValue: SettingsField['defaultValue']) => props.onDraft({ ...draft, defaultValue });
  const current = draft.defaultValue === undefined ? '' : String(draft.defaultValue);
  if (draft.kind === 'switch' || draft.kind === 'option') {
    const values = draft.kind === 'switch' ? ['true', 'false'] : (draft.options ?? []);
    const named = (each: string) => (each === 'true' ? 'On' : each === 'false' ? 'Off' : each);
    return (
      <Labelled label="Default">
        <Dropdown
          value={current}
          livePreview={false}
          options={[{ value: '', label: 'None' }, ...values.map((each) => ({ value: each, label: named(each) }))]}
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
    <Labelled label="Default">
      <input
        type={number ? 'number' : 'text'}
        placeholder="Used when an entry leaves it out"
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

function Labelled(props: { readonly label: string; readonly wide?: boolean; readonly children: React.ReactNode }) {
  return (
    <label className={`field-settings-field ${props.wide === true ? 'is-wide' : ''}`}>
      <span className="field-settings-label">{props.label}</span>
      {props.children}
    </label>
  );
}
