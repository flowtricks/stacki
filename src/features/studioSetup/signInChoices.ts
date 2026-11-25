// The sign-in choices as the Desktop dialog draws them: which fields each one asks for, in order,
// and the message keys for its words. The rules (what is valid, which variables follow) are the
// shared module's; this file only says what to show.
import { STUDIO_AUTH_KINDS, type StudioAuthDraft, type StudioAuthField, type StudioAuthKind } from '../../../shared/ipc/studioAuth';

export { STUDIO_AUTH_KINDS };

/** The text fields of a draft that a person types into, per kind. `teamDomain` adds its own confirmation box. */
export const SIGN_IN_FIELDS: Readonly<Record<StudioAuthKind, readonly StudioAuthField[]>> = {
  github: [],
  access: ['teamDomain', 'aud', 'admin'],
  google: ['clientId', 'allowedDomains', 'allowedEmails', 'admin'],
  oidc: ['issuer', 'clientId', 'name', 'allowedDomains', 'allowedEmails', 'admin'],
  passkey: ['admin'],
};

/** Fields that may stay empty. */
export const SIGN_IN_OPTIONAL: ReadonlySet<StudioAuthField> = new Set<StudioAuthField>(['name', 'allowedDomains', 'allowedEmails']);

export function draftFieldValue(draft: StudioAuthDraft, field: StudioAuthField): string {
  return draft[field];
}
