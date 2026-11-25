import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  PASSKEY_ADMIN_DEFAULT,
  buildStudioAuth,
  emptyStudioAuthDraft,
  studioAuthGuideFor,
  type StudioAuthConfig,
  type StudioAuthDraft,
  type StudioAuthField,
  type StudioAuthKind,
  type StudioAuthProblem,
} from '../../../shared/ipc/studioAuth';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import TipAnchor from '../../ui/TipAnchor';
import { CheckIcon, CopyIcon } from '../../ui/Icons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { SignInProviderIcon } from './signInProviderIcons';
import { SIGN_IN_FIELDS, STUDIO_AUTH_KINDS, draftFieldValue } from './signInChoices';
import { useCopyText } from './useCopyText';
import './studioAuth.css';

const FIELD_LABEL = {
  teamDomain: 'studioSetup.auth.field.teamDomain',
  aud: 'studioSetup.auth.field.aud',
  clientId: 'studioSetup.auth.field.clientId',
  issuer: 'studioSetup.auth.field.issuer',
  name: 'studioSetup.auth.field.name',
  allowedDomains: 'studioSetup.auth.field.allowedDomains',
  allowedEmails: 'studioSetup.auth.field.allowedEmails',
  admin: 'studioSetup.auth.field.adminEmail',
} as const satisfies Record<StudioAuthField, string>;

/** The form's state: a draft of typed text, and whether the person has tried to submit (problems show after that). */
export function useSignInForm(initial: StudioAuthKind) {
  const [draft, setDraft] = useState<StudioAuthDraft>(emptyStudioAuthDraft(initial));
  const [attempted, setAttempted] = useState(false);
  const built = buildStudioAuth(draft);
  const problems: readonly StudioAuthProblem[] = built.ok ? [] : built.error;
  return {
    draft,
    problems,
    attempted,
    setKind: (kind: StudioAuthKind) => setDraft(emptyStudioAuthDraft(kind)),
    setField: (field: StudioAuthField, value: string) => setDraft((previous) => ({ ...previous, [field]: value })),
    setCustomDomain: (confirmed: boolean) => setDraft((previous) => ({ ...previous, teamDomainCheck: confirmed ? 'custom' : 'strict' })),
    /** The checked choice, or undefined while a field is wrong (and the form then shows why). */
    submit: (): StudioAuthConfig | undefined => {
      setAttempted(true);
      return built.ok ? built.value : undefined;
    },
  };
}

export type SignInForm = ReturnType<typeof useSignInForm>;

export default function SignInFormView({ form }: { readonly form: SignInForm }) {
  const translate = useTranslate();
  return (
    <div className="studio-auth">
      <div role="radiogroup" aria-label={translate('studioSetup.auth.groupLabel')} className="studio-auth-options">
        {STUDIO_AUTH_KINDS.map((kind) => (
          <KindRow key={kind} kind={kind} selected={form.draft.kind === kind} onSelect={() => form.setKind(kind)} />
        ))}
      </div>
      <KindFields form={form} />
      <KindNotes kind={form.draft.kind} />
    </div>
  );
}

function KindRow({ kind, selected, onSelect }: { readonly kind: StudioAuthKind; readonly selected: boolean; readonly onSelect: () => void }) {
  const translate = useTranslate();
  return (
    <label className="studio-auth-option" data-selected={selected}>
      <input type="radio" name="studio-auth-kind" value={kind} checked={selected} onChange={onSelect} />
      <span className="studio-auth-option-icon" aria-hidden="true">
        <SignInProviderIcon provider={kind} size={16} />
      </span>
      <span className="studio-auth-option-text">
        <strong>{translate(`studioSetup.auth.kind.${kind}.label`)}</strong>
        <span>{translate(`studioSetup.auth.kind.${kind}.hint`)}</span>
      </span>
    </label>
  );
}

function KindFields({ form }: { readonly form: SignInForm }) {
  const translate = useTranslate();
  const fields = SIGN_IN_FIELDS[form.draft.kind];
  if (fields.length === 0) {
    return undefined;
  }
  return (
    <div className="studio-auth-fields">
      {fields.map((field) => (
        <FieldRow key={`${form.draft.kind}-${field}`} form={form} field={field} />
      ))}
      {form.draft.kind === 'access' && form.problems.some((problem) => problem.code === 'customDomain') && (
        <label className="studio-auth-confirm">
          <input type="checkbox" checked={form.draft.teamDomainCheck === 'custom'} onChange={(event) => form.setCustomDomain(event.currentTarget.checked)} />
          {translate('studioSetup.auth.field.customDomain')}
        </label>
      )}
    </div>
  );
}

function FieldRow({ form, field }: { readonly form: SignInForm; readonly field: StudioAuthField }) {
  const translate = useTranslate();
  const labelKey = field === 'admin' && form.draft.kind === 'passkey' ? 'studioSetup.auth.field.adminHandle' : FIELD_LABEL[field];
  const problem = form.problems.find((candidate) => candidate.field === field);
  const shown = form.attempted || problem?.code === 'customDomain';
  const list = field === 'allowedDomains' || field === 'allowedEmails';
  const input = (
    <input
      type="text"
      value={draftFieldValue(form.draft, field)}
      placeholder={placeholder(form.draft.kind, field)}
      spellCheck={false}
      autoCapitalize="off"
      autoComplete="off"
      aria-invalid={shown && problem !== undefined}
      onChange={(event) => form.setField(field, event.currentTarget.value)}
    />
  );
  return (
    <div className="studio-auth-field" data-invalid={shown && problem !== undefined}>
      <label>
        <span>{translate(labelKey)}</span>
        {list ? <TipAnchor text={translate('studioSetup.auth.field.listHint')}>{input}</TipAnchor> : input}
      </label>
      <ErrorToast message={shown && problem !== undefined ? problemText(problem, translate) : undefined} />
    </div>
  );
}

function problemText(problem: StudioAuthProblem, translate: Translator): string {
  return translate(`studioSetup.auth.problem.${problem.code}`);
}

// Example values are not translatable words: addresses and identifiers.
function placeholder(kind: StudioAuthKind, field: StudioAuthField): string {
  if (field === 'teamDomain') {
    return 'myteam.cloudflareaccess.com'; // i18n-ignore: an example address.
  }
  if (field === 'issuer') {
    return 'https://login.example.com'; // i18n-ignore: an example address.
  }
  if (field === 'allowedDomains') {
    return 'example.com'; // i18n-ignore: an example address.
  }
  if (field === 'admin') {
    return kind === 'passkey' ? PASSKEY_ADMIN_DEFAULT : 'you@example.com'; // i18n-ignore: an example address.
  }
  return '';
}

function KindNotes({ kind }: { readonly kind: StudioAuthKind }) {
  const translate = useTranslate();
  const guide = studioAuthGuideFor(kind);
  const text = guide.secretLines.join('\n');
  const redirect = guide.redirectPath === undefined ? undefined : `https://<your-site>${guide.redirectPath}`; // i18n-ignore: a URL pattern shown as code.
  return (
    <div className="studio-auth-notes">
      <p>{translate(`studioSetup.auth.steps.${kind}`)}</p>
      {guide.secretLines.length > 0 && (
        <section aria-label={translate('studioSetup.auth.secrets.title')}>
          <h4>{translate('studioSetup.auth.secrets.title')}</h4>
          <p>{translate('studioSetup.auth.secrets.intro')}</p>
          <CopyRow text={text} label={translate('studioSetup.auth.secrets.copy')}>
            <CodeBlock text={text} language="shell" label={translate('studioSetup.auth.secrets.title')} />
          </CopyRow>
        </section>
      )}
      {redirect !== undefined && (
        <section aria-label={translate('studioSetup.auth.redirect.title')}>
          <h4>{translate('studioSetup.auth.redirect.title')}</h4>
          <CopyRow text={redirect} label={translate('studioSetup.auth.redirect.copy')}>
            <CodeInline text={redirect} language="shell" />
          </CopyRow>
          <p>{translate('studioSetup.auth.redirect.note')}</p>
        </section>
      )}
    </div>
  );
}

function CopyRow({ text, label, children }: { readonly text: string; readonly label: string; readonly children: ReactNode }) {
  const translate = useTranslate();
  const clipboard = useCopyText(text);
  return (
    <div className="studio-auth-copy">
      {children}
      <button type="button" disabled={clipboard.status === 'copying'} onClick={() => void clipboard.copy()}>
        {clipboard.status === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        {clipboard.status === 'copied' ? translate('studioSetup.auth.secrets.copied') : label}
      </button>
      {clipboard.status === 'failed' && <ErrorToast message={translate('studioSetup.auth.secrets.copyFailed')} />}
    </div>
  );
}
