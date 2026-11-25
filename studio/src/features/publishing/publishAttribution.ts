// Goal: say in the Git history who edited, when the person has no GitHub account. Publishing always commits as Stacki
// Studio through the GitHub App; for a person who signed in another way (Google, SSO, a passkey, Cloudflare Access) the
// commit message gains one footer line naming their qualified identity. A GitHub person's commits are unchanged.
// Safety: the identity reaches the message only after it parses as a qualified identity, and then only its printable
// ASCII characters, one line, at most `identityCharsMax` long: no newline can add a second trailer or forge a
// `Co-authored-by` line, and nothing can make the message unbounded.
import { GITHUB_PROVIDER_ID, IDENTITY_LIMITS, identityProvider, parseQualifiedIdentity } from '../../../vendor/stacki/shared/properties/memberIdentity';

export const PUBLISH_COMMIT_SUBJECT = 'Publish website from Stacki Studio';

export function publishCommitMessage(editor: string | undefined): string {
  if (editor === undefined) {
    return PUBLISH_COMMIT_SUBJECT;
  }
  const parsed = parseQualifiedIdentity(editor);
  if (!parsed.ok || identityProvider(parsed.value) === GITHUB_PROVIDER_ID) {
    return PUBLISH_COMMIT_SUBJECT;
  }
  const printable = parsed.value.replace(/[^\x21-\x7e]/g, '').slice(0, IDENTITY_LIMITS.identityCharsMax);
  return `${PUBLISH_COMMIT_SUBJECT}\n\nEdited by ${printable} via Stacki Studio`;
}
