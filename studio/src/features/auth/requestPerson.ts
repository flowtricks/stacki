// Goal: who the Cloudflare Worker says is asking, as the container reads it. The Worker verifies the session and the
// provider's policy, then forwards the person in headers that the container trusts only together with the matching
// `x-studio-token` (checked before anything here runs). The container never signs in or verifies a provider itself.
//
// `x-studio-identity` is the provider-qualified identity roles.json members are matched on. A Worker that predates
// providers sent only `x-studio-user` (a GitHub login), which still means `github:<login>`. A missing or invalid
// identity throws, so a gated route fails closed (serverAccess.ts).
import {
  IDENTITY_LIMITS,
  parseQualifiedIdentity,
  identityProvider,
  identitySubject,
  GITHUB_PROVIDER_ID,
} from '../../../vendor/stacki/shared/properties/memberIdentity';
import type { QualifiedIdentity } from '../../../vendor/stacki/shared/properties/memberIdentity';
import { parseGitHubLogin, ROLE_LIMITS } from '../../../vendor/stacki/shared/properties/projectRoles';
import type { IncomingMessage } from 'node:http';

export interface RequestPerson {
  readonly identity: QualifiedIdentity;
  /** Other identities of the same person, in the same provider's namespace, at most ROLE_LIMITS.aliasesMax. */
  readonly aliases: readonly QualifiedIdentity[];
  /** The display name the provider gave, for presence and app people. Plain text, bounded. */
  readonly name: string;
}

const NAME_CHARS_MAX = 100;

export function requestPerson(request: Pick<IncomingMessage, 'headers'>): RequestPerson {
  const identityHeader = header(request, 'x-studio-identity');
  if (identityHeader === undefined) {
    // The GitHub-only form every earlier Worker sent.
    const login = parseGitHubLogin(header(request, 'x-studio-user') ?? '');
    const identity = parseQualifiedIdentity(`${GITHUB_PROVIDER_ID}:${login}`);
    if (!identity.ok) {
      throw new Error(identity.error.message);
    }
    return { identity: identity.value, aliases: [], name: login };
  }
  if (identityHeader.length > IDENTITY_LIMITS.identityCharsMax) {
    throw new Error('The studio identity is too long');
  }
  const identity = parseQualifiedIdentity(identityHeader);
  if (!identity.ok) {
    throw new Error(identity.error.message);
  }
  if (identityProvider(identity.value) === GITHUB_PROVIDER_ID) {
    // A github identity must still be a valid GitHub login: nothing else may reach a GitHub-only lookup.
    parseGitHubLogin(identitySubject(identity.value));
  }
  return {
    identity: identity.value,
    aliases: parseAliases(header(request, 'x-studio-aliases')),
    name: parseName(header(request, 'x-studio-name'), identity.value),
  };
}

function header(request: Pick<IncomingMessage, 'headers'>, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseAliases(value: string | undefined): readonly QualifiedIdentity[] {
  if (value === undefined) {
    return [];
  }
  const aliases: QualifiedIdentity[] = [];
  // Bounded: at most aliasesMax entries are read, whatever the header holds.
  for (const part of value.split(',').slice(0, ROLE_LIMITS.aliasesMax)) {
    const alias = parseQualifiedIdentity(part);
    if (alias.ok) {
      aliases.push(alias.value);
    }
  }
  return aliases;
}

function parseName(value: string | undefined, identity: QualifiedIdentity): string {
  if (value === undefined) {
    return identitySubject(identity);
  }
  try {
    const name = decodeURIComponent(value).trim();
    return name.length > 0 && name.length <= NAME_CHARS_MAX && !/[\u0000-\u001f\u007f]/u.test(name) ? name : identitySubject(identity);
  } catch {
    return identitySubject(identity);
  }
}
