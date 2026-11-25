// Goal: who may edit and who may manage, for the Google, SSO and passkey providers, in one place with one precedence.
//   1. `.stacki/roles.json` is the authority: a member of any role may edit; a member of the admin role may manage.
//   2. Allow-lists (`AUTH_ALLOWED_EMAILS`, `AUTH_ALLOWED_DOMAINS`) only add people who are in no role: they may edit, and
//      the container gives them the file's default role. They never manage. `EDITOR_ACCESS=roles` switches them off.
//   3. `EDITOR_ACCESS=authenticated` admits every person the provider verified (not recommended for Google or SSO).
//   4. `AUTH_BOOTSTRAP_ADMIN` is admin (and editor) only while no valid roles file exists, so a new instance has an owner
//      and a roles file takes over completely the moment it lists someone.
// A roles file that does not parse grants nobody anything; the bootstrap admin can still fix it.
import { memberRole, ADMIN_ROLE_ID } from '../../../../vendor/stacki/shared/properties/projectRoles';
import type { Principal } from '../authProvider';
import type { PolicyConfig } from './authConfig';
import type { RolesSource, RolesState } from './rolesSource';

export interface EditorPolicy {
  readonly canEdit: (principal: Principal, freshness: 'cached' | 'fresh') => Promise<boolean>;
  readonly canManage: (principal: Principal) => Promise<boolean>;
}

export interface EditorPolicyInput {
  readonly policy: Pick<PolicyConfig, 'bootstrapAdmin' | 'editorAccess'> & Partial<Pick<PolicyConfig, 'allowedEmails' | 'allowedDomains'>>;
  readonly roles: RolesSource;
  /** An extra gate every request must pass first (the passkey provider's "this handle is not locked out"). */
  readonly active?: (principal: Principal) => Promise<boolean>;
}

export function createEditorPolicy(input: EditorPolicyInput): EditorPolicy {
  const { policy } = input;
  const allowedEmails = policy.allowedEmails ?? [];
  const allowedDomains = policy.allowedDomains ?? [];
  return {
    canEdit: async (principal, freshness) => {
      if (input.active !== undefined && !(await input.active(principal))) {
        return false;
      }
      if (policy.editorAccess === 'authenticated') {
        return true;
      }
      const state = await input.roles.read(freshness);
      if (state.kind === 'roles') {
        if (memberRole(state.roles, principal.identity) !== undefined) {
          return true;
        }
      } else if (principal.identity === policy.bootstrapAdmin) {
        return true;
      }
      return policy.editorAccess !== 'roles' && listed(principal.email, allowedEmails, allowedDomains);
    },
    canManage: async (principal) => {
      if (input.active !== undefined && !(await input.active(principal))) {
        return false;
      }
      const state = await input.roles.read('cached');
      return manages(state, principal, policy.bootstrapAdmin);
    },
  };
}

function manages(state: RolesState, principal: Principal, bootstrapAdmin: string): boolean {
  if (state.kind !== 'roles') {
    return principal.identity === bootstrapAdmin;
  }
  return memberRole(state.roles, principal.identity)?.id === ADMIN_ROLE_ID;
}

/** `email` is present on a principal only when the provider verified it. */
function listed(email: string | undefined, emails: readonly string[], domains: readonly string[]): boolean {
  if (email === undefined) {
    return false;
  }
  const lowered = email.toLowerCase();
  if (emails.includes(lowered)) {
    return true;
  }
  const domain = lowered.slice(lowered.lastIndexOf('@') + 1);
  return domains.includes(domain);
}
