// Goal: "Invite member" for the Roles panel, as pure functions: which identifier a site's sign-in method needs, how it is
// normalised into the qualified identity written to `.stacki/roles.json`, how it is added (duplicates, other roles, the
// member bound) and removed (never the last admin), and the audit sentence for the Git commit of that change.
// One form per provider, chosen by the site's AUTH_PROVIDER and never offering a method the site is not configured for:
//   github   a username   -> the bare login (every existing file's form, so older Studio versions and avatars keep working)
//   access   an email     -> access:<email>      (and Cloudflare Zero Trust must also allow the person)
//   google   an email     -> google:<email>
//   oidc     an email     -> oidc:<email>        (a sub-based member is written by editing the file)
//   passkey  a handle     -> passkey:<handle>    (the one-time invite link comes from the passkey admin route)
//   custom   an identifier, shaped by the provider's own `parseInviteIdentifier`, -> <id>:<subject>
// No email is sent: Stacki has no email sender. The result is the sign-in link and the instruction to use that account.
import { err, ok, type Result } from '../../../shared/core/result';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';
import { IDENTITY_LIMITS, identityKey, parseProviderId, parseQualifiedIdentity } from '../../../shared/properties/memberIdentity';
import { ADMIN_ROLE_ID, ROLE_LIMITS, parseGitHubLogin, type ProjectRole, type ProjectRoles } from '../../../shared/properties/projectRoles';

export type InviteForm =
  | { readonly kind: 'github-login' }
  | { readonly kind: 'email'; readonly provider: 'access' | 'google' | 'oidc' }
  | { readonly kind: 'passkey-handle' }
  | { readonly kind: 'custom'; readonly provider: string; readonly displayName: string; readonly hint: string | undefined };

/** The form for the site's provider id (`/studio/api/auth/info`), or undefined when the id is not a valid provider id. */
export function inviteFormFor(
  provider: string,
  custom: { readonly displayName: string; readonly hint: string | undefined } | undefined,
): InviteForm | undefined {
  if (custom !== undefined) {
    return parseProviderId(provider).ok ? { kind: 'custom', provider, displayName: custom.displayName, hint: custom.hint } : undefined;
  }
  switch (provider) {
    case 'github':
      return { kind: 'github-login' };
    case 'access':
    case 'google':
    case 'oidc':
      return { kind: 'email', provider };
    case 'passkey':
      return { kind: 'passkey-handle' };
    default:
      return undefined;
  }
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const HANDLE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EMAIL_CHARS_MAX = 200;

export type InviteIdentifierError = Described;

/** What an admin typed, as the member text for `roles.json`, or why it is not one. Bounded, trimmed and lowercased where the provider compares exactly. */
export function parseInviteIdentifier(
  form: InviteForm,
  input: string,
  customParser?: (input: string) => string | undefined,
): Result<string, InviteIdentifierError> {
  const typed = input.trim();
  if (typed.length === 0 || typed.length > IDENTITY_LIMITS.identityCharsMax) {
    return err(described('roles.invite.error.identifier'));
  }
  switch (form.kind) {
    case 'github-login': {
      try {
        return ok(parseGitHubLogin(typed.replace(/^@/, '')));
      } catch {
        return err(described('roles.invite.error.login'));
      }
    }
    case 'email': {
      const email = typed.toLowerCase();
      return email.length <= EMAIL_CHARS_MAX && EMAIL.test(email) ? ok(`${form.provider}:${email}`) : err(described('roles.invite.error.email'));
    }
    case 'passkey-handle': {
      const handle = typed.toLowerCase();
      return HANDLE.test(handle) ? ok(`passkey:${handle}`) : err(described('roles.invite.error.handle'));
    }
    case 'custom': {
      const subject = customParser === undefined ? typed : customParser(typed);
      const identity = subject === undefined ? undefined : parseQualifiedIdentity(`${form.provider}:${subject}`);
      return identity?.ok === true ? ok(identity.value) : err(described('roles.invite.error.identifier'));
    }
  }
}

/** Adds `member` to role `roleId`. Someone already in another role moves (a person belongs to one role); a duplicate in the same role is refused. */
export function addInvitedMember(roles: ProjectRoles, roleId: string, member: string): Result<ProjectRoles, Described> {
  const target = roles.roles.find((role) => role.id === roleId);
  if (target === undefined) {
    return err(described('roles.invite.error.role'));
  }
  const key = identityKey(member);
  if (target.members.some((existing) => identityKey(existing) === key)) {
    return err(described('roles.error.memberListed', { login: member, role: target.name }));
  }
  if (target.members.length >= ROLE_LIMITS.membersMax) {
    return err(described('roles.error.membersMax', { count: ROLE_LIMITS.membersMax }));
  }
  const without = roles.roles.map((role) => ({ ...role, members: role.members.filter((existing) => identityKey(existing) !== key) }));
  const previous = roles.roles.find((role) => role.members.some((existing) => identityKey(existing) === key));
  if (previous?.id === ADMIN_ROLE_ID && (without.find((role) => role.id === ADMIN_ROLE_ID)?.members.length ?? 0) === 0) {
    return err(described('roles.error.lastAdmin'));
  }
  return ok({ ...roles, roles: without.map((role) => (role.id === roleId ? { ...role, members: [...role.members, member] } : role)) });
}

/** Removes a member from whatever role holds them. The last admin cannot be removed. */
export function removeInvitedMember(roles: ProjectRoles, member: string): Result<ProjectRoles, Described> {
  const key = identityKey(member);
  const holder: ProjectRole | undefined = roles.roles.find((role) => role.members.some((existing) => identityKey(existing) === key));
  if (holder === undefined) {
    return err(described('roles.invite.error.notMember'));
  }
  if (holder.id === ADMIN_ROLE_ID && holder.members.length === 1) {
    return err(described('roles.error.lastAdmin'));
  }
  return ok({
    ...roles,
    roles: roles.roles.map((role) => (role.id === holder.id ? { ...role, members: role.members.filter((existing) => identityKey(existing) !== key) } : role)),
  });
}

export type RolesChange =
  | { readonly kind: 'invite'; readonly member: string; readonly role: string }
  | { readonly kind: 'remove'; readonly member: string }
  | { readonly kind: 'move'; readonly member: string; readonly role: string };

/** The Git commit message of a roles change, for the audit trail: "Invite google:a@b.com as Editor". One bounded line. */
export function rolesChangeMessage(change: RolesChange): string {
  const clean = (text: string) => text.replace(/[^\x20-\x7e]/g, '').slice(0, 100);
  switch (change.kind) {
    case 'invite':
      return `Invite ${clean(change.member)} as ${clean(change.role)}`;
    case 'move':
      return `Move ${clean(change.member)} to ${clean(change.role)}`;
    case 'remove':
      return `Remove ${clean(change.member)} from roles`;
  }
}

/** What the person sees after Invite: where to sign in, and for Access the reminder that Cloudflare must allow them too. */
export type InviteResult =
  | {
      readonly kind: 'sign-in-link';
      readonly link: string;
      readonly provider: 'github' | 'google' | 'oidc' | 'access' | 'custom';
      readonly accessReminder: boolean;
    }
  | { readonly kind: 'passkey-link'; readonly link: string; readonly expiresAt: number };

export function signInLink(origin: string): string {
  return `${origin.replace(/\/$/, '')}/studio`;
}
