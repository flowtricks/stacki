// i18n-ignore-file: the error sentences are developer-facing diagnostics for provider authors and roles.json editors, not interface text.
// Provider-qualified identities: who a signed-in person is once Studio may sign people in
// through more than one authentication provider (studio/docs/auth-providers.md).
//
// An identity is `<provider>:<subject>`: `github:octocat`, `email:a@b.com`, `google:1234`.
// The provider part says WHO vouched for the person; the subject is that provider's own stable
// name for them. Two providers can never produce the same identity, because the prefix differs.
// A bare GitHub login in `.stacki/roles.json` (every file written before this module existed)
// still means `github:<login>`, so no roles file needs migrating.
//
// The brands are built only here, after the check, so an unchecked string can never pose as an
// identity (AGENTS.md §4).
import { err, ok, type Result } from '../core/result';
import type { Brand } from '../core/brand';

// The bounds live beside the parser that enforces them (AGENTS.md §10).
export const IDENTITY_LIMITS = {
  /** A provider id: `[a-z][a-z0-9-]*`. */
  providerCharsMax: 32,
  /** A provider's own name for a person: an email address, an OIDC `sub`, a GitHub login. */
  subjectCharsMax: 200,
  /** The whole `<provider>:<subject>` text. */
  identityCharsMax: 233,
} as const satisfies Record<string, number>;

/** The provider that ships with Studio. Only the built-in GitHub provider may produce `github:` identities. */
export const GITHUB_PROVIDER_ID = 'github';

export type ProviderId = Brand<string, 'ProviderId'>;
export type QualifiedIdentity = Brand<string, 'QualifiedIdentity'>;

export interface IdentityError {
  readonly code: 'not-text' | 'provider' | 'subject' | 'length' | 'shape';
  readonly message: string;
}

const PROVIDER_PATTERN = /^[a-z][a-z0-9-]*$/;
// Printable, no whitespace and no comma: the comma separates identities in a header (aliases), and
// whitespace or control characters would make two identities look alike in a log or a file.
const SUBJECT_PATTERN = /^[^\s,\u0000-\u001f\u007f]+$/u;

/** A provider id, or the reason it is not one. */
export function parseProviderId(input: unknown): Result<ProviderId, IdentityError> {
  if (typeof input !== 'string') {
    return err({ code: 'not-text', message: 'A provider id is text' });
  }
  if (input.length === 0 || input.length > IDENTITY_LIMITS.providerCharsMax) {
    return err({ code: 'length', message: `A provider id is 1 to ${IDENTITY_LIMITS.providerCharsMax} characters` });
  }
  if (!PROVIDER_PATTERN.test(input)) {
    return err({ code: 'provider', message: 'A provider id is lowercase letters, digits and hyphens, starting with a letter' });
  }
  return ok(input as ProviderId);
}

/** `<provider>:<subject>`, or the reason it is not one. */
export function parseQualifiedIdentity(input: unknown): Result<QualifiedIdentity, IdentityError> {
  if (typeof input !== 'string') {
    return err({ code: 'not-text', message: 'An identity is text' });
  }
  if (input.length === 0 || input.length > IDENTITY_LIMITS.identityCharsMax) {
    return err({ code: 'length', message: `An identity is 1 to ${IDENTITY_LIMITS.identityCharsMax} characters` });
  }
  const colon = input.indexOf(':');
  if (colon < 1) {
    return err({ code: 'shape', message: 'An identity is <provider>:<subject>' });
  }
  const provider = parseProviderId(input.slice(0, colon));
  if (!provider.ok) {
    return provider;
  }
  const subject = input.slice(colon + 1);
  if (subject.length === 0 || subject.length > IDENTITY_LIMITS.subjectCharsMax) {
    return err({ code: 'length', message: `An identity subject is 1 to ${IDENTITY_LIMITS.subjectCharsMax} characters` });
  }
  if (!SUBJECT_PATTERN.test(subject)) {
    return err({ code: 'subject', message: 'An identity subject has no spaces, commas or control characters' });
  }
  return ok(input as QualifiedIdentity);
}

/** The provider part of an identity. */
export function identityProvider(identity: QualifiedIdentity): ProviderId {
  const colon = identity.indexOf(':');
  const provider = parseProviderId(identity.slice(0, colon));
  if (!provider.ok) {
    throw new Error('Assertion failed: a qualified identity starts with a valid provider id');
  }
  return provider.value;
}

/** The subject part of an identity. */
export function identitySubject(identity: QualifiedIdentity): string {
  return identity.slice(identity.indexOf(':') + 1);
}

/** The identity a bare GitHub login stands for in `.stacki/roles.json`. */
export function githubIdentity(login: string): Result<QualifiedIdentity, IdentityError> {
  return parseQualifiedIdentity(`${GITHUB_PROVIDER_ID}:${login}`);
}

/**
 * The text two identities are compared by. A bare login (no colon) is a GitHub login. GitHub names are
 * case-insensitive, so they compare lowercase; every other provider's subject compares exactly, because
 * only that provider knows whether its subjects fold (an OIDC `sub` does not). Providers canonicalize
 * their own subjects before they hand them to Studio.
 */
export function identityKey(identityOrLogin: string): string {
  const colon = identityOrLogin.indexOf(':');
  if (colon < 0) {
    return `${GITHUB_PROVIDER_ID}:${identityOrLogin.toLowerCase()}`;
  }
  const provider = identityOrLogin.slice(0, colon);
  const subject = identityOrLogin.slice(colon + 1);
  return provider === GITHUB_PROVIDER_ID ? `${provider}:${subject.toLowerCase()}` : identityOrLogin;
}
