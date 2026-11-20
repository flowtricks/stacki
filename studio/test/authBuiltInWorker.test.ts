// Goal: a built-in provider bundled into the real Worker (workerd) is selected by AUTH_PROVIDER, guards every route, and a
// wrong or incomplete configuration answers 503 rather than signing anyone in another way.
// Method: the Worker bundled as `npm run build` bundles it for Google, with sessions minted by core's own signing function
// (the sign-in routes themselves run in the Durable Object and are covered through authRoutes in the provider tests).
// Cases: a google person reaches the container with a qualified identity and no GitHub headers; a GitHub session from before
// the switch is refused; a person who may not edit is refused; unknown, mismatched and incomplete AUTH_PROVIDER values stop
// the request with 503; the passkey admin and auth-info routes refuse non-managers. No network: EDITOR_ACCESS is
// `authenticated`, so GitHub is never asked for roles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startWorkerRuntime, studioCookie, WORKER_TEST, WORKER_RUNTIME_LIMITS } from './workerRuntime';
import { signPrincipal } from '../src/features/auth/principalSession';
import { parsePerson, parseProviderId } from '../src/features/auth/authProvider';

async function cookieFor(provider: string, subject: string): Promise<string> {
  const id = parseProviderId(provider);
  assert.ok(id.ok);
  const person = parsePerson({ identity: `${provider}:${subject}`, name: subject, email: subject.includes('@') ? subject : undefined }, id.value);
  assert.ok(person.ok);
  const token = await signPrincipal(person.value, 'studio', Date.now() + 60_000, WORKER_TEST.sessionSecret);
  assert.ok(token.ok);
  return `__Host-studio=${token.value}`;
}

const google = {
  AUTH_PROVIDER: 'google',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  AUTH_BOOTSTRAP_ADMIN: 'google:me@example.com',
  EDITOR_ACCESS: 'authenticated',
};

test(
  'a Google person reaches the container as google:<email>; other sessions and managers-only routes are refused',
  { timeout: WORKER_RUNTIME_LIMITS.testFileMs },
  async (context) => {
    const runtime = await startWorkerRuntime({ builtInProvider: 'google', vars: google });
    context.after(() => runtime.dispose());
    const response = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', {
      headers: { cookie: await cookieFor('google', 'ann@corp.test'), 'x-studio-user': 'owner' },
    });
    assert.equal(response.headers.get('x-stub-preview'), 'reached');
    const echo = JSON.parse(await response.text()) as Record<string, unknown>;
    assert.equal(echo['identity'], 'google:ann@corp.test');
    assert.equal(echo['user'], null, 'no GitHub login for a Google person, whatever the client sent');
    const leftover = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', { headers: { cookie: await studioCookie(60_000) } });
    assert.equal(leftover.status, 401, 'a GitHub session from before the switch proves nothing');
    const otherProvider = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', {
      headers: { cookie: await cookieFor('oidc', 'ann@corp.test') },
    });
    assert.equal(otherProvider.status, 401);
    const info = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/auth/info', { headers: { cookie: await cookieFor('google', 'ann@corp.test') } });
    const view = JSON.parse(await info.text()) as Record<string, unknown>;
    assert.equal(view['provider'], 'google', JSON.stringify(view) + info.status);
    assert.equal(view['canManage'], false);
    const passkeys = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/auth/passkeys', {
      headers: { cookie: await cookieFor('google', 'ann@corp.test') },
    });
    assert.equal(passkeys.status, 404, 'passkey administration exists only for the passkey provider');
    assert.deepEqual(runtime.unexpectedLogs([/Studio request failed/, /GitHub|fetch|private key|PEM|sign/i]), []);
  },
);

test('a missing variable, an unknown AUTH_PROVIDER and a mismatched build answer 503', { timeout: WORKER_RUNTIME_LIMITS.testFileMs }, async (context) => {
  const cases = [
    { label: 'missing GOOGLE_CLIENT_ID', vars: { ...google, GOOGLE_CLIENT_ID: '' } },
    { label: 'unknown provider', vars: { ...google, AUTH_PROVIDER: 'saml' } },
    { label: 'a build for google run with AUTH_PROVIDER=oidc', vars: { ...google, AUTH_PROVIDER: 'oidc' } },
  ];
  for (const { label, vars } of cases) {
    const runtime = await startWorkerRuntime({ builtInProvider: 'google', vars });
    context.after(() => runtime.dispose());
    const response = await runtime.fetch(WORKER_TEST.studioOrigin + '/studio/api/project', { headers: { cookie: await cookieFor('google', 'ann@corp.test') } });
    assert.equal(response.status, 503, label);
    assert.notEqual(response.headers.get('x-stub-preview'), 'reached', label);
  }
});
