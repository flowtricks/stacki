// Hosted Studio's Roles view: who may do what, and the way to invite people. It lists `.stacki/roles.json`'s roles and
// members, and for an admin offers Invite member, a role change and Remove. The invite form is the one for the site's own
// sign-in method (GitHub username, email for Access, Google and SSO, a handle for passkeys, or a custom provider's own
// identifier) and offers no other. Every write goes through Studio's metadata route, which refuses a non-admin, and the
// passkey commands go through the manager-only auth route; hiding a button here is never the protection.
// Stacki sends no email: an invite ends with the link to copy and what the person must do.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import {
  ADMIN_ROLE_ID,
  DEFAULT_PROJECT_ROLES,
  parseProjectRoles,
  parseProjectRolesSource,
  rolesClaimed,
  serializeProjectRoles,
  type ProjectRole,
  type ProjectRoles,
} from '../../../vendor/stacki/shared/properties/projectRoles';
import { identityKey } from '../../../vendor/stacki/shared/properties/memberIdentity';
import Dropdown, { type DropdownOption } from '../../../vendor/stacki/src/ui/Dropdown';
import { SkeletonRows } from '../../../vendor/stacki/src/ui/Skeleton';
import { CheckIcon, CloseIcon, CopyIcon, GitHubIcon, LockIcon, MailIcon, PlusIcon } from '../../../vendor/stacki/src/ui/Icons';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { readMetadata, writeMetadata } from '../settings/metadataClient';
import { addInvitedMember, inviteFormFor, parseInviteIdentifier, removeInvitedMember, signInLink, type InviteForm } from './memberInvite';
import { loadAuthInfo, loadPasskeys, parseInviteLink, sendPasskeyCommand, type AuthInfo, type PasskeyCommand, type PasskeyView } from './rolesApi';
import './rolesView.css';

/** What the view needs from the server; tests and the screenshot harness pass fakes. */
export interface RolesServices {
  readonly info: () => Promise<AuthInfo | undefined>;
  readonly file: () => Promise<string | undefined>;
  readonly save: (source: string, base: string | undefined) => Promise<string>;
  readonly passkeys: () => Promise<PasskeyView | undefined>;
  readonly command: (command: PasskeyCommand) => Promise<unknown>;
  readonly now: () => number;
}

export const REAL_SERVICES: RolesServices = {
  info: async () => {
    const loaded = await loadAuthInfo();
    return loaded.ok ? loaded.value : undefined;
  },
  file: async () => (await readMetadata('studio', 'roles')).source,
  save: async (source, base) => {
    const written = await writeMetadata('studio', { kind: 'roles', source, ...(base === undefined ? {} : { base }) });
    return written.source ?? source;
  },
  passkeys: async () => {
    const loaded = await loadPasskeys();
    return loaded.ok ? loaded.value : undefined;
  },
  command: async (command) => {
    const sent = await sendPasskeyCommand(command);
    if (!sent.ok) {
      throw new Error(sent.error);
    }
    return sent.value;
  },
  now: Date.now,
};

export type Outcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'link'; readonly link: string; readonly signIn: boolean; readonly accessReminder: boolean; readonly expiresAt: number | undefined };

export interface Loaded {
  readonly info: AuthInfo;
  readonly roles: ProjectRoles;
  readonly source: string | undefined;
  readonly passkeys: PasskeyView | undefined;
}

export function RolesView({ services = REAL_SERVICES }: { readonly services?: RolesServices }) {
  const translate = useTranslate();
  const [loaded, setLoaded] = useState<Loaded | 'failed' | undefined>(undefined);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const info = await services.info();
      const source = await services.file();
      if (info === undefined) {
        setLoaded('failed');
        return;
      }
      const roles = source === undefined ? undefined : parseProjectRolesSource(source);
      const passkeys = info.provider === 'passkey' && info.kind === 'built-in' && info.canManage ? await services.passkeys() : undefined;
      setLoaded({
        info,
        roles: roles ?? parseProjectRoles({ version: 1, roles: [{ id: ADMIN_ROLE_ID, name: 'Admin', members: [info.me] }] }),
        source,
        passkeys,
      });
    } catch {
      setLoaded('failed');
    }
  }, [services]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loaded === undefined) {
    return <SkeletonRows count={4} />;
  }
  if (loaded === 'failed') {
    return (
      <p className="roles-view-note" role="status">
        {translate('roles.studio.unavailable')}
      </p>
    );
  }
  return <RolesLayout loaded={loaded} services={services} reload={reload} />;
}

/** The loaded view: members, the invite form and its outcome. Exported so the screenshot harness and tests can draw it with fake data. */
export function RolesLayout(props: {
  readonly loaded: Loaded;
  readonly services: RolesServices;
  readonly reload: () => Promise<void>;
  readonly initialInviting?: boolean;
  readonly initialOutcome?: Outcome;
}) {
  const translate = useTranslate();
  const { loaded, services, reload } = props;
  const [error, setError] = useState<string | undefined>(undefined);
  const [inviting, setInviting] = useState(props.initialInviting === true);
  const [outcome, setOutcome] = useState<Outcome>(props.initialOutcome ?? { kind: 'none' });
  const { info, roles, source } = loaded;
  const form = inviteFormFor(info.provider, info.kind === 'custom' ? { displayName: info.displayName, hint: info.inviteHint } : undefined);
  const mutate = async (change: (current: ProjectRoles) => ReturnType<typeof addInvitedMember>): Promise<boolean> => {
    const next = change(roles);
    if (!next.ok) {
      setError(next.error.message);
      return false;
    }
    try {
      await services.save(serializeProjectRoles(next.value), source);
      setError(undefined);
      await reload();
      return true;
    } catch {
      setError(translate('roles.studio.failed'));
      return false;
    }
  };
  const runCommand = async (command: PasskeyCommand): Promise<unknown> => {
    try {
      const answer = await services.command(command);
      await reload();
      return answer;
    } catch {
      setError(translate('roles.studio.failed'));
      return undefined;
    }
  };
  return (
    <div className="roles-view" data-roles-view="">
      <div className="roles-view-head">
        {!info.canManage && <p className="roles-view-note">{translate('roles.studio.readOnly')}</p>}
        {info.canManage && form !== undefined && !inviting && (
          <button type="button" className="ghost" onClick={() => setInviting(true)}>
            <PlusIcon size={12} /> {translate('roles.studio.invite')}
          </button>
        )}
      </div>
      {info.canManage && source === undefined && <p className="roles-view-note">{translate('roles.studio.noFile')}</p>}
      {error !== undefined && (
        <p className="roles-view-error" role="alert">
          {error}
        </p>
      )}
      {inviting && form !== undefined && info.canManage && (
        <InviteForm
          form={form}
          info={info}
          roles={roles}
          now={services.now}
          onCancel={() => setInviting(false)}
          onInvite={async (member, roleId, displayName) => {
            if (form.kind === 'passkey-handle') {
              const handle = member.slice('passkey:'.length);
              const answer = await runCommand({ action: 'invite', handle, ...(displayName === undefined ? {} : { displayName }) });
              const link = parseInviteLink(answer);
              if (!link.ok) {
                return;
              }
              // The member joins their role at once, so the invitee has access the moment they enrol.
              await mutate((current) => addInvitedMember(current, roleId, member));
              setOutcome({ kind: 'link', link: link.value.link, signIn: false, accessReminder: false, expiresAt: link.value.expiresAt });
              return;
            }
            if (await mutate((current) => addInvitedMember(current, roleId, member))) {
              setOutcome({ kind: 'link', link: signInLink(info.origin), signIn: true, accessReminder: info.provider === 'access', expiresAt: undefined });
            }
          }}
        />
      )}
      {outcome.kind === 'link' && <InviteOutcome outcome={outcome} info={info} now={services.now} onClose={() => setOutcome({ kind: 'none' })} />}
      {roles.roles.map((role) => (
        <RoleSection
          key={role.id}
          role={role}
          roles={roles}
          info={info}
          editable={info.canManage}
          onMove={(member, roleId) => mutate((current) => addInvitedMember(current, roleId, member))}
          onRemove={(member) => mutate((current) => removeInvitedMember(current, member))}
        />
      ))}
      {loaded.passkeys !== undefined && <PasskeyAdmin view={loaded.passkeys} now={services.now} onCommand={(command) => void runCommand(command)} />}
    </div>
  );
}

function roleOptions(roles: ProjectRoles): readonly DropdownOption[] {
  return roles.roles.map((role) => ({ value: role.id, label: role.name }));
}

/**
 * The role someone is invited into by default: the least-privileged non-admin role (the fewest features), or admin while
 * the file is unclaimed, since its first member must be an admin (projectRoles.ts `adminMembershipRefusal`).
 */
export function defaultInviteRole(roles: ProjectRoles): string {
  if (!rolesClaimed(roles)) {
    return ADMIN_ROLE_ID;
  }
  const others = roles.roles.filter((role) => role.id !== ADMIN_ROLE_ID);
  const least = [...others].sort((first, second) => first.access.length - second.access.length)[0];
  return least?.id ?? ADMIN_ROLE_ID;
}

/** How a member is shown: a provider icon and the plain login, email or handle. A bare name is a GitHub login. */
export function friendlyMember(member: string): { readonly provider: string; readonly label: string } {
  const key = identityKey(member);
  const colon = key.indexOf(':');
  const provider = key.slice(0, colon);
  return {
    provider,
    label: provider === 'github' ? (member.includes(':') ? member.slice(member.indexOf(':') + 1) : member) : member.slice(member.indexOf(':') + 1),
  };
}

function ProviderIcon({ provider }: { readonly provider: string }) {
  if (provider === 'github') {
    return <GitHubIcon size={14} />;
  }
  return provider === 'passkey' ? <LockIcon size={14} /> : <MailIcon size={14} />;
}

function RoleSection(props: {
  readonly role: ProjectRole;
  readonly roles: ProjectRoles;
  readonly info: AuthInfo;
  readonly editable: boolean;
  readonly onMove: (member: string, roleId: string) => Promise<boolean>;
  readonly onRemove: (member: string) => Promise<boolean>;
}) {
  const translate = useTranslate();
  const { role, roles, info, editable } = props;
  return (
    <section className="roles-view-role" aria-label={role.name}>
      <h4>{role.name}</h4>
      {role.members.length === 0 && <p className="roles-view-note">{translate('roles.studio.empty')}</p>}
      {role.members.map((member) => {
        const shown = friendlyMember(member);
        return (
          <div key={member} className="roles-view-member">
            <span className="roles-view-who" title={member}>
              <ProviderIcon provider={shown.provider} />
              <span>{shown.label}</span>
              {identityKey(member) === identityKey(info.me) && <span className="roles-view-you">{translate('roles.studio.you')}</span>}
            </span>
            {editable && (
              <>
                <Dropdown
                  ariaLabel={translate('roles.studio.changeRole', { name: shown.label })}
                  value={role.id}
                  options={roleOptions(roles)}
                  onChange={(roleId) => void props.onMove(member, roleId)}
                />
                <button
                  type="button"
                  className="ghost"
                  title={translate('roles.studio.remove', { name: shown.label })}
                  aria-label={translate('roles.studio.remove', { name: shown.label })}
                  onClick={() => void props.onRemove(member)}
                >
                  <CloseIcon size={10} />
                </button>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function fieldLabelKey(form: InviteForm): 'roles.studio.field.github' | 'roles.studio.field.email' | 'roles.studio.field.handle' | 'roles.studio.field.custom' {
  switch (form.kind) {
    case 'github-login':
      return 'roles.studio.field.github';
    case 'email':
      return 'roles.studio.field.email';
    case 'passkey-handle':
      return 'roles.studio.field.handle';
    case 'custom':
      return 'roles.studio.field.custom';
  }
}

function InviteForm(props: {
  readonly form: InviteForm;
  readonly info: AuthInfo;
  readonly roles: ProjectRoles;
  readonly now: () => number;
  readonly onCancel: () => void;
  readonly onInvite: (member: string, roleId: string, displayName: string | undefined) => Promise<void>;
}) {
  const translate = useTranslate();
  const { form, roles } = props;
  const [identifier, setIdentifier] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [roleId, setRoleId] = useState(() => defaultInviteRole(roles));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const label = translate(fieldLabelKey(form), { name: form.kind === 'custom' ? form.displayName : '' });
  const submit = async (): Promise<void> => {
    const parsed = parseInviteIdentifier(form, identifier);
    if (!parsed.ok) {
      setProblem(parsed.error.message);
      return;
    }
    const duplicate = roles.roles.find((role) => role.members.some((member) => identityKey(member) === identityKey(parsed.value)));
    if (duplicate !== undefined && duplicate.id === roleId) {
      setProblem(translate('roles.error.memberListed', { login: parsed.value, role: duplicate.name }));
      return;
    }
    setProblem(undefined);
    await props.onInvite(parsed.value, roleId, displayName.trim() === '' ? undefined : displayName.trim());
    props.onCancel();
  };
  return (
    <form
      className="roles-view-form"
      aria-label={translate('roles.studio.inviteTitle')}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label>
        {label}
        <input
          value={identifier}
          onChange={(event) => setIdentifier(event.target.value)}
          maxLength={233}
          placeholder={form.kind === 'custom' ? form.hint : undefined}
          autoFocus
        />
      </label>
      {form.kind === 'passkey-handle' && (
        <label>
          {translate('roles.studio.field.displayName')}
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />
        </label>
      )}
      <label>
        {translate('roles.studio.role')}
        <Dropdown ariaLabel={translate('roles.studio.role')} value={roleId} options={roleOptions(roles)} onChange={setRoleId} />
      </label>
      {problem !== undefined && (
        <p className="roles-view-error" role="alert">
          {problem}
        </p>
      )}
      <div className="roles-view-actions">
        <button type="button" className="ghost" onClick={props.onCancel}>
          {translate('roles.studio.cancel')}
        </button>
        <button type="submit" className="primary">
          {translate('roles.studio.submit')}
        </button>
      </div>
    </form>
  );
}

function InviteOutcome(props: {
  readonly outcome: Extract<Outcome, { kind: 'link' }>;
  readonly info: AuthInfo;
  readonly now: () => number;
  readonly onClose: () => void;
}) {
  const translate = useTranslate();
  const [copied, setCopied] = useState(false);
  const { outcome, info } = props;
  const date = useMemo(() => (outcome.expiresAt === undefined ? '' : new Date(outcome.expiresAt).toLocaleDateString()), [outcome.expiresAt]);
  assert(outcome.link.startsWith('https://') || outcome.link.startsWith('http://localhost'), 'An invite link is an https address');
  return (
    <div className="roles-view-form" role="status">
      <p className="roles-view-note">{translate('roles.studio.noEmail')}</p>
      <p className="roles-view-note">
        {outcome.signIn
          ? translate('roles.studio.signIn', { link: outcome.link, provider: info.displayName })
          : translate('roles.studio.passkeyLink', { date })}
      </p>
      <div className="roles-view-link">
        <code>{outcome.link}</code>
        <button
          type="button"
          className="ghost"
          onClick={() => {
            void navigator.clipboard.writeText(outcome.link).then(() => setCopied(true));
          }}
        >
          {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />} {translate(copied ? 'roles.studio.copied' : 'roles.studio.copy')}
        </button>
      </div>
      {outcome.accessReminder && <p className="roles-view-reminder">{translate('roles.studio.accessReminder')}</p>}
      <div className="roles-view-actions">
        <button type="button" className="ghost" onClick={props.onClose}>
          {translate('roles.studio.close')}
        </button>
      </div>
    </div>
  );
}

function PasskeyAdmin(props: { readonly view: PasskeyView; readonly now: () => number; readonly onCommand: (command: PasskeyCommand) => void }) {
  const translate = useTranslate();
  const { view } = props;
  return (
    <>
      {view.invites.length > 0 && (
        <section className="roles-view-role" aria-label={translate('roles.studio.pending')}>
          <h4>{translate('roles.studio.pending')}</h4>
          {view.invites.map((invite) => (
            <div key={invite.hash} className="roles-view-member">
              <span className="roles-view-who">
                <LockIcon size={14} />
                <span>
                  {translate('roles.studio.pendingBy', {
                    handle: invite.displayName ?? invite.handle,
                    name: invite.createdBy,
                    date: new Date(invite.expiresAt).toLocaleDateString(),
                  })}
                </span>
              </span>
              <button type="button" className="ghost" onClick={() => props.onCommand({ action: 'revokeInvite', hash: invite.hash })}>
                {translate('roles.studio.revoke')}
              </button>
            </div>
          ))}
        </section>
      )}
      {view.people.length > 0 && (
        <section className="roles-view-role" aria-label={translate('roles.studio.passkeys')}>
          <h4>{translate('roles.studio.passkeys')}</h4>
          {view.people.map((person) => (
            <div key={person.handle}>
              <div className="roles-view-member">
                <span className="roles-view-who">
                  <LockIcon size={14} />
                  <span>{person.displayName ?? person.handle}</span>
                </span>
                <button
                  type="button"
                  className="ghost"
                  title={translate('roles.studio.lockHint')}
                  onClick={() => props.onCommand({ action: 'lock', handle: person.handle })}
                >
                  {translate('roles.studio.lock')}
                </button>
              </div>
              {person.passkeys.map((key) => (
                <div key={key.id} className="roles-view-member">
                  <span className="roles-view-who">
                    <span>{`${key.label}, ${new Date(key.createdAt).toLocaleDateString()}`}</span>
                  </span>
                  <button type="button" className="ghost" onClick={() => props.onCommand({ action: 'removeCredential', id: key.id })}>
                    {translate('roles.studio.removePasskey')}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </section>
      )}
    </>
  );
}

export { DEFAULT_PROJECT_ROLES };
