// Goal: AUTH_PROVIDER selects the built-in provider at build and at runtime, and a wrong or incomplete choice fails loudly
// instead of falling back to GitHub; `astro-studio check-project` reports the same problems.
// Method: the slot generator is run against throwaway wrangler configs (as the build does); the runtime registry is called
// with environments for each provider (good, missing variables, unknown id, a build made for another provider); the
// check-project reader is run against a temporary site. The GitHub default is asserted untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { builtInSlotSource, readAuthProviderId } from '../scripts/authProviderSlot';
import { checkAuthProvider } from '../scripts/checkAuth';
import { activeAuthRuntime } from '../src/cloudflare/activeAuthRuntime';
import { BUILT_IN_PROVIDER_IDS } from '../src/features/auth/providers/authConfig';
import { builtInProviderSlot } from '../src/cloudflare/builtInProviderSlot';

const github = {
  STUDIO_ORIGIN: 'https://studio.test',
  SESSION_SECRET: 'a-session-secret-that-is-long-enough-0123456789',
  GITHUB_CLIENT_ID: 'id',
  GITHUB_CLIENT_SECRET: 'secret',
  EDITOR_GITHUB_IDS: '',
  EDITOR_ACCESS: 'repository',
  GITHUB_APP_ID: '1',
  GITHUB_INSTALLATION_ID: '2',
  GITHUB_PRIVATE_KEY: 'k',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_BRANCH: 'main',
};

async function site(vars: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-auth-site-'));
  await mkdir(path.join(root, 'cloudflare'), { recursive: true });
  await writeFile(path.join(root, 'cloudflare', 'wrangler.jsonc'), `{\n  // comment\n  "vars": ${JSON.stringify(vars)}\n}\n`);
  return root;
}

test('the order of providers is GitHub, Cloudflare Access, Google, SSO, passkeys', () => {
  assert.deepEqual([...BUILT_IN_PROVIDER_IDS], ['github', 'access', 'google', 'oidc', 'passkey']);
});

test('the slot imports only the chosen provider; GitHub imports nothing', () => {
  assert.match(builtInSlotSource('github'), /create: undefined/);
  assert.doesNotMatch(builtInSlotSource('github'), /import \{/);
  for (const [id, factory] of [
    ['access', 'createAccessProvider'],
    ['google', 'createGoogleProvider'],
    ['oidc', 'createOidcProvider'],
    ['passkey', 'createPasskeyProvider'],
  ] as const) {
    const source = builtInSlotSource(id);
    assert.match(source, new RegExp(`import \\{ ${factory} \\} from '../features/auth/providers/${id}'`));
    for (const other of ['access', 'google', 'oidc', 'passkey']) {
      if (other !== id) {
        assert.doesNotMatch(source, new RegExp(`providers/${other}'`), `${id} must not import ${other}`);
      }
    }
  }
  assert.equal(builtInProviderSlot.id, 'github', 'the committed slot is the GitHub default');
});

test('the build reads AUTH_PROVIDER from wrangler.jsonc: absent is GitHub, unknown stops the build', async () => {
  const roots: string[] = [];
  try {
    for (const [vars, expected] of [
      [{}, 'github'],
      [{ AUTH_PROVIDER: '' }, 'github'],
      [{ AUTH_PROVIDER: 'github' }, 'github'],
      [{ AUTH_PROVIDER: 'google' }, 'google'],
      [{ AUTH_PROVIDER: 'access' }, 'access'],
    ] as const) {
      const root = await site(vars);
      roots.push(root);
      assert.equal(await readAuthProviderId(root), expected);
    }
    const bad = await site({ AUTH_PROVIDER: 'saml' });
    roots.push(bad);
    await assert.rejects(readAuthProviderId(bad), /AUTH_PROVIDER "saml" is unknown/);
    const missing = await mkdtemp(path.join(tmpdir(), 'studio-auth-none-'));
    roots.push(missing);
    assert.equal(await readAuthProviderId(missing), 'github', 'no config file means the default');
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test('the runtime refuses unknown, mismatched and incomplete configuration instead of falling back to GitHub', () => {
  assert.equal(activeAuthRuntime({ ...github }).providerId, 'github', 'the default is untouched');
  assert.equal(activeAuthRuntime({ ...github, AUTH_PROVIDER: 'github' }).providerId, 'github');
  assert.throws(() => activeAuthRuntime({ ...github, AUTH_PROVIDER: 'saml' }), /unknown/);
  assert.throws(() => activeAuthRuntime({ ...github, AUTH_PROVIDER: 'google' }), /bundles "github"/);
});

test('check-project reports missing and invalid sign-in variables per provider', async () => {
  const roots: string[] = [];
  try {
    const run = async (vars: Record<string, string>) => {
      const root = await site(vars);
      roots.push(root);
      const studio = path.join(root, '..');
      void studio;
      // check-project reads <site>/studio/cloudflare/wrangler.jsonc.
      const wrapper = await mkdtemp(path.join(tmpdir(), 'studio-auth-wrap-'));
      roots.push(wrapper);
      await mkdir(path.join(wrapper, 'studio'), { recursive: true });
      await (await import('node:fs/promises')).cp(root, path.join(wrapper, 'studio'), { recursive: true });
      return checkAuthProvider(wrapper);
    };
    await run({});
    await run({ AUTH_PROVIDER: 'github' });
    await run({ AUTH_PROVIDER: 'google', GOOGLE_CLIENT_ID: 'id', AUTH_BOOTSTRAP_ADMIN: 'google:me@example.com' });
    await run({ AUTH_PROVIDER: 'passkey', AUTH_BOOTSTRAP_ADMIN: 'passkey:owner' });
    await run({
      AUTH_PROVIDER: 'access',
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'a'.repeat(32),
      AUTH_BOOTSTRAP_ADMIN: 'access:me@example.com',
    });
    await run({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'c', AUTH_BOOTSTRAP_ADMIN: 'oidc:me@example.com' });
    await assert.rejects(run({ AUTH_PROVIDER: 'google' }), /GOOGLE_CLIENT_ID[\s\S]*AUTH_BOOTSTRAP_ADMIN/);
    await assert.rejects(
      run({ AUTH_PROVIDER: 'oidc', OIDC_ISSUER: 'http://insecure.example.test', OIDC_CLIENT_ID: 'c', AUTH_BOOTSTRAP_ADMIN: 'oidc:me@example.com' }),
      /https/,
    );
    await assert.rejects(
      run({ AUTH_PROVIDER: 'access', ACCESS_TEAM_DOMAIN: 'evil.example.com', ACCESS_AUD: 'short', AUTH_BOOTSTRAP_ADMIN: 'access:me@example.com' }),
      /ACCESS_TEAM_DOMAIN[\s\S]*ACCESS_AUD/,
    );
    await assert.rejects(run({ AUTH_PROVIDER: 'passkey' }), /AUTH_BOOTSTRAP_ADMIN is required/);
    await assert.rejects(run({ AUTH_PROVIDER: 'ldap' }), /unknown/);
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});
