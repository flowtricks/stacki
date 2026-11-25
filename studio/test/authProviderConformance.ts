// Goal: one reusable check that ANY authentication provider (the built-in GitHub one, a fake, or a provider an instance
// owner wrote in studio/cloudflare/auth-provider.ts) behaves as core requires, so swapping providers cannot weaken sign-in.
// Method: run the provider through core's real sign-in flow (authRoutes.ts) with a signed-state cookie, and assert what
// core guarantees whatever the provider does: the provider's own cookies never reach the browser, the state is core's,
// the identity is in the provider's namespace, the session cookie is core's (fixed name and flags, verifiable only with
// the session secret), a wrong state never reaches the provider, and a callback works once.
// Use: `runAuthProviderConformance({ name, create, installed, acceptedCallback, expectedIdentity })` from a test file;
// docs/auth-providers.md ("Testing your provider") shows a full call.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthRuntime } from '../src/features/auth/authRuntime';
import { authRoutes } from '../src/features/auth/authRoutes';
import type { AuthProvider } from '../src/features/auth/authProvider';
import { validateAuthProvider } from '../src/features/auth/authProvider';
import { verifyPrincipal } from '../src/features/auth/principalSession';
import { verifySession } from '../src/features/auth/session';
import { loginAttemptFixture } from './loginAttemptFixture';

export const CONFORMANCE = {
  origin: 'https://studio.conformance.test',
  secret: 'conformance-secret-with-at-least-32-characters',
} as const;

export interface AuthProviderCase {
  readonly name: string;
  /** A fresh provider for each test. */
  readonly create: () => AuthProvider;
  readonly installed: 'built-in' | 'custom';
  /** A callback request the provider accepts for `state`, as the identity service would send the browser back. */
  readonly acceptedCallback: (state: string, callbackUrl: string) => Request;
  /** The identity that accepted callback must produce, such as `email:a@b.test`. */
  readonly expectedIdentity: string;
  /** A callback request the provider refuses (a bad code, a denied person), if there is one to try. */
  readonly refusedCallback?: (state: string, callbackUrl: string) => Request;
  /** `EDITOR_ACCESS` for providers without their own `canEdit`. */
  readonly editorAccess?: string;
  /** Mock the provider's network (a fetch stub, a clock) for one test; runs before the flow starts. */
  readonly prepare?: (context: TestContext) => void;
}

function runtimeFor(provider: AuthProvider, spec: AuthProviderCase) {
  return createAuthRuntime({ provider, installed: spec.installed, origin: CONFORMANCE.origin, secret: CONFORMANCE.secret, editorAccess: spec.editorAccess });
}

async function begin(runtime: ReturnType<typeof runtimeFor>, attempts: ReturnType<ReturnType<typeof loginAttemptFixture>['create']>) {
  const response = await authRoutes(new Request(CONFORMANCE.origin + '/studio/auth/login'), runtime, attempts);
  assert.ok(response, 'core answers /studio/auth/login');
  const cookieHeader = response.headers.getSetCookie();
  const stateCookie = cookieHeader.find((value) => value.startsWith('__Host-studio-state='));
  assert.ok(stateCookie, 'core sets the state cookie');
  const token = stateCookie.split(';')[0]?.slice('__Host-studio-state='.length) ?? '';
  const claims = await verifySession(token, CONFORMANCE.secret, 'login');
  assert.ok(claims, 'the state cookie is signed by core');
  return { response, cookies: cookieHeader, stateCookie: stateCookie.split(';')[0] ?? '', state: claims.login };
}

function withCookie(request: Request, cookie: string): Request {
  const headers = new Headers(request.headers);
  headers.set('Cookie', cookie);
  return new Request(request, { headers });
}

export function runAuthProviderConformance(spec: AuthProviderCase): void {
  const callbackUrl = `${CONFORMANCE.origin}/studio/auth/callback`;
  test(`${spec.name}: satisfies the provider interface`, () => {
    const checked = validateAuthProvider(spec.create(), spec.installed);
    assert.ok(checked.ok, checked.ok ? '' : checked.error);
    if (spec.installed === 'custom') {
      assert.notEqual(checked.value.id, 'github', 'only the built-in provider owns github identities');
    }
  });

  test(`${spec.name}: sign-in starts with core's state and no cookie of the provider's`, async (context) => {
    spec.prepare?.(context);
    const runtime = runtimeFor(spec.create(), spec);
    const started = await begin(runtime, loginAttemptFixture().create());
    assert.deepEqual(
      started.cookies.map((value) => value.split('=')[0]),
      ['__Host-studio-state'],
      'exactly one cookie: the state, set by core',
    );
    assert.equal(started.response.headers.get('Cache-Control'), 'no-store');
    const location = started.response.headers.get('Location');
    if (location !== null) {
      assert.ok(location.startsWith('https://') || location.startsWith('http://localhost'), 'a redirect goes to https');
    }
  });

  test(`${spec.name}: an accepted callback gets a core session for the provider's identity`, async (context) => {
    spec.prepare?.(context);
    const runtime = runtimeFor(spec.create(), spec);
    const attempts = loginAttemptFixture().create();
    const started = await begin(runtime, attempts);
    const response = await authRoutes(withCookie(spec.acceptedCallback(started.state, callbackUrl), started.stateCookie), runtime, attempts);
    assert.ok(response);
    assert.equal(response.status, 302, 'sign-in completes with a redirect');
    assert.equal(response.headers.get('Location'), `${CONFORMANCE.origin}/studio`);
    const session = response.headers.getSetCookie().find((value) => value.startsWith('__Host-studio='));
    assert.ok(session, 'core sets the studio session cookie');
    for (const flag of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=28800']) {
      assert.ok(session.includes(flag), `the session cookie carries ${flag}`);
    }
    const principal = await verifyPrincipal(session.split(';')[0]?.slice('__Host-studio='.length) ?? '', CONFORMANCE.secret, 'studio');
    assert.ok(principal, "the session verifies only with core's secret");
    assert.equal(principal.identity, spec.expectedIdentity);
    assert.equal(
      response.headers.getSetCookie().filter((value) => value.startsWith('__Host-studio=')).length,
      1,
      'one session cookie, whatever the provider sent',
    );
  });

  test(`${spec.name}: a wrong or missing state never reaches the provider`, async (context) => {
    spec.prepare?.(context);
    const provider = spec.create();
    let identifyCalls = 0;
    const watched: AuthProvider = {
      ...provider,
      identify: (request, flow) => {
        identifyCalls++;
        return provider.identify(request, flow);
      },
    };
    const runtime = runtimeFor(watched, spec);
    const attempts = loginAttemptFixture().create();
    const started = await begin(runtime, attempts);
    const forged = await authRoutes(
      withCookie(spec.acceptedCallback('00000000-0000-4000-8000-000000000000', callbackUrl), started.stateCookie),
      runtime,
      attempts,
    );
    assert.equal(forged?.status, 403);
    const stateless = await authRoutes(spec.acceptedCallback(started.state, callbackUrl), runtime, attempts);
    assert.equal(stateless?.status, 403, 'a callback without the browser that started it is refused');
    assert.equal(identifyCalls, 0, 'identify was never called');
    for (const response of [forged, stateless]) {
      assert.equal(
        response?.headers.getSetCookie().some((value) => value.startsWith('__Host-studio=') && !value.startsWith('__Host-studio-state')),
        false,
      );
    }
  });

  test(`${spec.name}: a finished callback cannot be replayed without the browser that started it`, async (context) => {
    spec.prepare?.(context);
    const runtime = runtimeFor(spec.create(), spec);
    const attempts = loginAttemptFixture().create();
    const started = await begin(runtime, attempts);
    const first = await authRoutes(withCookie(spec.acceptedCallback(started.state, callbackUrl), started.stateCookie), runtime, attempts);
    assert.equal(first?.status, 302);
    // Core clears the state cookie on every callback outcome, so a stolen or refreshed callback URL has nothing to match.
    assert.ok(
      first?.headers.getSetCookie().some((value) => value.startsWith('__Host-studio-state=;') || value.startsWith('__Host-studio-state=; ')),
      'the state cookie is cleared',
    );
    const replay = await authRoutes(spec.acceptedCallback(started.state, callbackUrl), runtime, attempts);
    assert.equal(replay?.status, 403);
    assert.equal(
      replay?.headers.getSetCookie().some((value) => /^__Host-studio=[^;]/.test(value)),
      false,
    );
  });

  const refused = spec.refusedCallback;
  if (refused !== undefined) {
    test(`${spec.name}: a refused callback creates no session`, async (context) => {
      spec.prepare?.(context);
      const runtime = runtimeFor(spec.create(), spec);
      const attempts = loginAttemptFixture().create();
      const started = await begin(runtime, attempts);
      const response = await authRoutes(withCookie(refused(started.state, callbackUrl), started.stateCookie), runtime, attempts);
      assert.ok(response);
      assert.ok(response.status >= 400, `refused with ${response.status}`);
      assert.equal(
        response.headers.getSetCookie().some((value) => /^__Host-studio=[^;]/.test(value)),
        false,
        'no session cookie',
      );
      assert.ok((await response.text()).includes('href="/studio/auth/login"'), 'the page offers a fresh sign-in');
    });
  }
}
