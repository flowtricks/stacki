// The Git panel's optional commit type: a type picker beside the message, a
// scope field and a breaking toggle once a type is picked, and the subject the
// commit will carry. With no type (the default) nothing is added to what the
// person types, and the preview stays hidden because it would only repeat it.
import { useState } from 'react';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { CodeInline } from '../../ui/CodeBlock';
import { assert } from '../../../shared/core/assert';
import {
  COMMIT_CONVENTION_NONE,
  COMMIT_SCOPE_LENGTH_MAX,
  COMMIT_TYPE_DESCRIPTIONS,
  COMMIT_TYPES,
  parseCommitScope,
  type CommitConvention,
  type CommitTypeName,
} from './commitType';
import { commitTypeProjectKey, loadCommitType, saveCommitType } from './commitTypePreference';

const NO_TYPE = 'none';

// Words people search for that the one-line descriptions leave out, so "bug"
// finds fix and "css" finds style.
const COMMIT_TYPE_KEYWORDS = {
  feat: 'add new page section component',
  fix: 'bug broken repair',
  content: 'text copy words image photo data cms',
  style: 'css design colour color layout spacing font',
  refactor: 'cleanup reorganise reorganize tidy',
  perf: 'performance speed slow fast size',
  docs: 'readme documentation',
  chore: 'maintenance housekeeping',
  build: 'dependency dependencies package npm astro config',
  ci: 'github actions workflow pipeline deploy',
  test: 'tests testing spec',
  revert: 'undo rollback',
} as const satisfies Record<CommitTypeName, string>;
type CommitTypeChoice = CommitTypeName | typeof NO_TYPE;

const TYPE_OPTIONS: readonly DropdownOption<CommitTypeChoice>[] = [
  // Pinned, so a search that matches no type still leaves the way back to none.
  { value: NO_TYPE, label: 'No type', description: 'the message as typed', dim: true, pinned: true },
  ...COMMIT_TYPES.map((type) => ({
    value: type,
    label: type,
    description: COMMIT_TYPE_DESCRIPTIONS[type],
    keywords: `${COMMIT_TYPE_DESCRIPTIONS[type]} ${COMMIT_TYPE_KEYWORDS[type]}`,
  })),
];

/** The person's choice, parsed: the convention to build with, or the reason the scope can't be used. */
export type CommitTypeState = { readonly kind: 'ready'; readonly convention: CommitConvention } | { readonly kind: 'invalid'; readonly error: string };

export interface CommitTypeControl {
  readonly type: CommitTypeName | undefined;
  readonly scopeText: string;
  readonly breaking: boolean;
  readonly state: CommitTypeState;
  readonly setType: (type: CommitTypeName | undefined) => void;
  readonly setScopeText: (text: string) => void;
  readonly setBreaking: (breaking: boolean) => void;
  /** After a commit: the scope and breaking mark described that commit, the type is the habit. */
  readonly resetForNextCommit: () => void;
}

/** The commit type for one project, starting from the type this person last picked there. */
export function useCommitType(project: { readonly path: string; readonly name: string }): CommitTypeControl {
  const projectKey = commitTypeProjectKey(project);
  const [choice, setChoice] = useState(() => ({ projectKey, type: loadCommitType(projectKey) }));
  const [scopeText, setScopeText] = useState('');
  const [breaking, setBreaking] = useState(false);
  // Another project's choice is never carried over: the stored one is read again.
  const type = choice.projectKey === projectKey ? choice.type : loadCommitType(projectKey);
  if (choice.projectKey !== projectKey) {
    setChoice({ projectKey, type });
  }
  return {
    type,
    scopeText,
    breaking,
    state: commitTypeState({ type, scopeText, breaking }),
    setType: (next) => {
      setChoice({ projectKey, type: next });
      saveCommitType(projectKey, next);
      if (next === undefined) {
        setScopeText('');
        setBreaking(false);
      }
    },
    setScopeText,
    setBreaking,
    resetForNextCommit: () => {
      setScopeText('');
      setBreaking(false);
    },
  };
}

/** The parsed choice. The scope is checked here, where it is typed, so a bad one is said before Commit. */
export function commitTypeState({
  type,
  scopeText,
  breaking,
}: {
  readonly type: CommitTypeName | undefined;
  readonly scopeText: string;
  readonly breaking: boolean;
}): CommitTypeState {
  if (type === undefined) {
    return { kind: 'ready', convention: COMMIT_CONVENTION_NONE };
  }
  const scope = parseCommitScope(scopeText);
  if (scope.ok) {
    return { kind: 'ready', convention: { kind: 'typed', type, scope: scope.value, breaking } };
  }
  return { kind: 'invalid', error: scope.error };
}

/**
 * The convention a commit made away from the panel's fields uses (the branch
 * switch dialog's "Commit first"). A scope still being fixed is left out
 * rather than blocking the switch; the dialog previews the subject, so what is
 * committed is still shown before it happens.
 */
export function commitTypeConvention(control: Pick<CommitTypeControl, 'type' | 'state' | 'breaking'>): CommitConvention {
  if (control.state.kind === 'ready') {
    return control.state.convention;
  }
  assert(control.type !== undefined, 'Commit type: only a typed choice has a scope to reject');
  return { kind: 'typed', type: control.type, scope: undefined, breaking: control.breaking };
}

export function CommitTypeSelect({ control, disabled }: { readonly control: CommitTypeControl; readonly disabled: boolean }) {
  return (
    <Dropdown<CommitTypeChoice>
      className="git-commit-type"
      ariaLabel="Commit type"
      disabled={disabled}
      value={control.type ?? NO_TYPE}
      options={TYPE_OPTIONS}
      optionLayout="stacked"
      menuWidthMin={240}
      searchable={true}
      searchPlaceholder="Search types"
      livePreview={false}
      onChange={(value) => control.setType(value === NO_TYPE ? undefined : value)}
    />
  );
}

/** The scope and breaking toggle, beside the type, shown only once a type is picked. */
export function CommitTypeDetails({ control, disabled }: { readonly control: CommitTypeControl; readonly disabled: boolean }) {
  if (control.type === undefined) {
    return undefined;
  }
  const invalid = control.state.kind === 'invalid';
  return (
    <>
      <input
        className="git-commit-scope"
        placeholder="Scope, e.g. nav"
        aria-label="Commit scope"
        aria-invalid={invalid ? true : undefined}
        maxLength={COMMIT_SCOPE_LENGTH_MAX + 1}
        disabled={disabled}
        value={control.scopeText}
        onChange={(event) => control.setScopeText(event.target.value)}
      />
      <label className="check-row" title="Adds ! to mark a change that breaks something people rely on">
        <input type="checkbox" checked={control.breaking} disabled={disabled} onChange={(event) => control.setBreaking(event.target.checked)} />
        Breaking
      </label>
    </>
  );
}

/** Why the typed scope can't be used, under the row that holds it. */
export function CommitTypeScopeError({ control }: { readonly control: CommitTypeControl }) {
  if (control.state.kind === 'ready') {
    return undefined;
  }
  return (
    <p className="hint-text git-commit-scope-error" role="alert">
      {control.state.error}
    </p>
  );
}

/** The subject the commit will carry, dim and monospaced. Hidden with no type: it would only echo the field. */
export function CommitSubjectPreview({ subject, convention }: { readonly subject: string | undefined; readonly convention: CommitConvention | undefined }) {
  if (subject === undefined || convention === undefined || convention.kind === 'none') {
    return undefined;
  }
  assert(subject.length > 0, 'Commit preview: a subject is never empty');
  return <CodeInline className="git-commit-preview" text={subject} language="commit" />;
}
