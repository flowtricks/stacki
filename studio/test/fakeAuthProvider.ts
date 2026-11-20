// A small stand-in identity service for the tests: a callback carrying `?token=<name>` is "the identity service saying
// this is <name>". It is not shipped and not a model to copy for production (it has no secret); docs/auth-providers.md
// has the worked examples. People: alice (may edit and manage), bob (may edit), mallory (verified, but not allowed to edit).
import { err, ok } from '../vendor/stacki/shared/core/result';
import type { AuthProvider, ProviderPerson } from '../src/features/auth/authProvider';

export const FAKE_PROVIDER_ID = 'fake';

const PEOPLE: Readonly<Record<string, ProviderPerson>> = {
  alice: { identity: 'fake:alice', name: 'Alice Example', email: 'alice@example.test', avatarUrl: 'https://img.example.test/alice.png' },
  bob: { identity: 'fake:bob', name: 'Bob Example', email: 'bob@example.test' },
  mallory: { identity: 'fake:mallory', name: 'Mallory Example' },
};

export function createFakeProvider(): AuthProvider {
  return {
    id: FAKE_PROVIDER_ID,
    displayName: 'Fake Login',
    begin: (_request, flow) =>
      Promise.resolve(new Response(null, { status: 302, headers: { Location: `https://idp.example.test/authorize?state=${flow.state}` } })),
    identify: (request) => {
      const token = new URL(request.url).searchParams.get('token') ?? '';
      const person = PEOPLE[token];
      if (person !== undefined) {
        return Promise.resolve(ok(person));
      }
      return Promise.resolve(err(token === 'denied' ? { problem: 'access' as const } : { problem: 'expired' as const, reference: 'token-400' }));
    },
    canEdit: (principal) => Promise.resolve(principal.identity === 'fake:alice' || principal.identity === 'fake:bob'),
    canManage: (principal) => Promise.resolve(principal.identity === 'fake:alice'),
    memberKeys: (principal) => [`${principal.identity}-alias`],
  };
}
