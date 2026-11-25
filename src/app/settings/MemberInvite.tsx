// How a person is added to a role in Desktop's Members view, chosen by the project's sign-in method (authProvider.ts):
// github shows the username field with suggestions (MemberPicker); access, google and oidc show one email field, written as
// `<provider>:<email>`; passkey shows a note, because its one-time invite links are created in Studio. The validation and
// the written form come from memberInvite.ts, the same module hosted Studio uses, so both hosts agree on what a member is.
// While the provider is being read nothing is drawn, so the wrong form never flashes.
import { useState } from 'react';
import { inviteFormFor, parseInviteIdentifier } from '../../features/roles/memberInvite';
import type { ProjectRole } from '../../../shared/properties/projectRoles';
import { useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { reportErrorToast } from '../../ui/errorNotices';
import { PlusIcon } from '../../ui/Icons';
import { useAuthProvider } from './authProvider';
import { MemberPicker } from './MemberPicker';

export function MemberInvite(props: {
  readonly role: ProjectRole;
  readonly projectPath: string | undefined;
  readonly addMember: (login: string) => boolean;
  readonly addInvited: (member: string) => boolean;
}) {
  const translate = useTranslate();
  const state = useAuthProvider(props.projectPath);
  if (state.kind === 'loading') {
    return undefined;
  }
  const form = inviteFormFor(state.provider, undefined);
  if (form?.kind === 'github-login') {
    return <MemberPicker roleName={props.role.name} members={props.role.members} projectPath={props.projectPath} addMember={props.addMember} />;
  }
  if (form?.kind === 'email') {
    return <EmailInvite role={props.role} provider={form.provider} addInvited={props.addInvited} />;
  }
  if (form?.kind === 'passkey-handle') {
    return <p className="app-role-detail-empty">{translate('settings.roles.invite.passkeyNote')}</p>;
  }
  return undefined;
}

function EmailInvite(props: { readonly role: ProjectRole; readonly provider: 'access' | 'google' | 'oidc'; readonly addInvited: (member: string) => boolean }) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const [typed, setTyped] = useState('');
  // The address was refused: the field takes the error look until it is edited; the reason was said once, as a toast.
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    const parsed = parseInviteIdentifier({ kind: 'email', provider: props.provider }, typed);
    if (!parsed.ok) {
      setInvalid(true);
      reportErrorToast(translateDescribed(parsed.error));
      return;
    }
    setInvalid(false);
    // A refusal (listed, last admin, bound) is shown by the card's notice; the field keeps its text then.
    if (props.addInvited(parsed.value)) {
      setTyped('');
    }
  };
  return (
    <>
      <form
        className="app-role-add"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="app-role-member-field">
          <PlusIcon size={14} />
          <input
            aria-label={translate('settings.roles.invite.email.label', { name: props.role.name })}
            placeholder={translate('settings.roles.invite.email.placeholder')}
            spellCheck={false}
            value={typed}
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => {
              setTyped(event.target.value);
              setInvalid(false);
            }}
          />
          <button type="submit" className="app-role-add-button" disabled={typed.trim() === ''}>
            {translate('settings.roles.members.add.button')}
          </button>
        </div>
      </form>
    </>
  );
}
