// One field's settings, open in its row of a collection's settings: its name
// and help text, the checks its kind is most often given, the rest of them
// under Advanced validation, and whether it is required. Values are drafts:
// RemoteCollectionSettings.tsx saves them with the field.
import { useState } from 'react';
import { typedFieldName, type SettingsField } from '../../../shared/properties/collectionSettings';
import { checksFor, FIELD_CHECKS, type FieldCheckKey, type FieldChecks } from '../../../shared/properties/fieldChecks';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
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
  const translate = useTranslate();
  return (
    <div className="field-settings">
      <div className="field-settings-grid">
        <Labelled label={translate('cmsRemote.fieldSettings.name')} wide>
          <input
            autoFocus={props.autoFocusName === true}
            aria-invalid={nameProblem !== undefined}
            value={draft.name}
            onChange={(event) => onDraft({ ...draft, name: event.target.value })}
          />
          {nameProblem === undefined ? <SavedKey typed={draft.name} /> : <span className="remote-cms-problem">{nameProblem}</span>}
        </Labelled>
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
      {props.field.editable ? (
        <FieldRules draft={draft} onDraft={onDraft} />
      ) : (
        <p className="field-settings-note">{translate('cmsRemote.fieldSettings.methodNote')}</p>
      )}
    </div>
  );
}

// The key a typed label is saved as, when that is not what was typed.
function SavedKey(props: { readonly typed: string }) {
  const translate = useTranslate();
  const name = typedFieldName(props.typed);
  if (name.kind === 'key' && name.key !== props.typed.trim()) {
    return <span className="remote-cms-problem is-note">{translate('cmsRemote.fieldSettings.savedAs', { key: name.key })}</span>;
  }
  return undefined;
}

// The kind's common checks, the others behind a disclosure, then Required.
function FieldRules(props: { readonly draft: SettingsField; readonly onDraft: Draft }) {
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
      <label className="field-settings-required">
        <input type="checkbox" checked={draft.required} onChange={(event) => onDraft({ ...draft, required: event.target.checked })} />
        <span>{translate('cmsRemote.fieldSettings.required')}</span>
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

function Labelled(props: { readonly label: string; readonly wide?: boolean; readonly children: React.ReactNode }) {
  return (
    <label className={`field-settings-field ${props.wide === true ? 'is-wide' : ''}`}>
      <span className="field-settings-label">{props.label}</span>
      {props.children}
    </label>
  );
}
