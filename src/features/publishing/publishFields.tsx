// The small fields the publish settings are built from.
import { useState, type ReactNode } from 'react';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import InfoHint from '../../ui/InfoHint';
import { PlusIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';

export function FieldLabel({ label, hint }: { readonly label: string; readonly hint?: string | undefined }) {
  return (
    <span className="publish-label publish-label-info">
      {label}
      {hint !== undefined && <InfoHint text={hint} />}
    </span>
  );
}

export function TextField(props: {
  readonly label: string;
  readonly value: string;
  readonly change: (value: string) => void;
  readonly maxLength?: number;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly invalid?: boolean;
}) {
  return (
    <div className="publish-field">
      <FieldLabel label={props.label} hint={props.hint} />
      <input
        aria-label={props.label}
        aria-invalid={props.invalid === true ? true : undefined}
        value={props.value}
        maxLength={props.maxLength ?? 256}
        placeholder={props.placeholder}
        spellCheck={false}
        onChange={(event) => props.change(event.target.value)}
      />
    </div>
  );
}

/** Script names typed as a comma-separated list. */
export function ScriptListField({
  label,
  values,
  change,
  hint,
}: {
  readonly label: string;
  readonly values: readonly string[];
  readonly change: (values: readonly string[]) => void;
  readonly hint?: string;
}) {
  const [draft, setDraft] = useState(values.join(', '));
  return (
    <div className="publish-field">
      <FieldLabel label={label} hint={hint} />
      <input
        aria-label={label}
        value={draft}
        maxLength={808}
        spellCheck={false}
        onChange={(event) => {
          const value = event.target.value;
          setDraft(value);
          change(
            value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          );
        }}
      />
    </div>
  );
}

/** One package.json script, chosen from the project's own list. A saved name no longer listed stays shown. */
export function ScriptDropdown(props: {
  readonly label: string;
  readonly value: string;
  /** Absent while the project's scripts are being read. */
  readonly scripts: readonly string[] | undefined;
  readonly change: (script: string) => void;
  readonly placeholder: string;
  readonly hint?: string;
  readonly invalid?: boolean;
}) {
  const translate = useTranslate();
  const listed = props.scripts ?? [];
  const names = props.value === '' || listed.includes(props.value) ? listed : [...listed, props.value];
  const empty = props.scripts === undefined ? translate('publish.common.loading') : translate('publish.custom.noScripts');
  return (
    <div className="publish-field">
      <FieldLabel label={props.label} hint={props.hint} />
      <Dropdown<string>
        ariaLabel={props.label}
        value={props.value}
        options={names.map((name) => ({ value: name, label: name }))}
        placeholder={names.length === 0 ? empty : props.placeholder}
        disabled={names.length === 0}
        invalid={props.invalid === true}
        onChange={props.change}
        menuClassName="publish-dropdown"
        livePreview={false}
        searchable={names.length > 8}
      />
    </div>
  );
}

/** The value of a list's own "Add …" row. No account, repository, project or Worker name can hold a plus sign. */
export const ADD_OPTION = '+add';

/**
 * The first row of a publishing list: adds what the list holds. Its mark sits where an account's picture does. A search
 * keeps it listed; alone in a list it is not pinned, so the list does not also say that nothing matched.
 */
export function withAddOption<Option extends DropdownOption<string>>(label: string, options: readonly Option[]): readonly DropdownOption<string>[] {
  const mark = (
    <span className="publish-avatar" aria-hidden="true">
      <PlusIcon size={12} />
    </span>
  );
  return [{ value: ADD_OPTION, label, icon: mark, pinned: options.length > 0 }, ...options];
}

/** Extras that stay out of the way until asked for. */
export function MoreOptions({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <details className="publish-advanced publish-more">
      <summary>{title}</summary>
      <div className="publish-advanced-fields">{children}</div>
    </details>
  );
}
