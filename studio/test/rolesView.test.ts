// Goal: hosted Studio's Roles view draws the right thing for each sign-in method and each person.
// Method: the real view is bundled with esbuild (stylesheets emptied) and rendered to static markup with fake data: for
// every provider (GitHub, Cloudflare Access, Google, SSO, passkeys, and a custom one) the invite form is open and must show
// that provider's identifier field and no other; a non-admin sees the list read-only with no Invite and no Remove; the
// outcome panel shows the sign-in link (with the Access reminder), or the one-time passkey link with Copy. The server-call
// parsers are tested separately with hostile answers. Click behaviour is the pure model's (memberInvite.test.ts).
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { build } from 'esbuild';
import { parseAuthInfo, parseInviteLink, parsePasskeyView } from '../src/features/roles/rolesApi';

const studio = path.resolve(import.meta.dirname, '..');

async function bundle(): Promise<(props: Record<string, unknown>) => string> {
  const outDir = path.join(studio, 'node_modules/.studio-test');
  mkdirSync(outDir, { recursive: true });
  const outfile = path.join(outDir, 'roles-view.mjs');
  await build({
    stdin: {
      contents: [
        "import { renderToStaticMarkup } from 'react-dom/server';",
        "import { createElement } from 'react';",
        "import { RolesLayout } from './src/features/roles/RolesView';",
        'export const draw = (props) => renderToStaticMarkup(createElement(RolesLayout, props));',
      ].join('\n'),
      resolveDir: studio,
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty' },
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const loaded: unknown = await import(pathToFileURL(outfile).href + '?v=' + String(Math.random()));
  assert.ok(typeof loaded === 'object' && loaded !== null);
  const draw: unknown = Reflect.get(loaded, 'draw');
  assert.ok(typeof draw === 'function');
  return (props) => {
    const html: unknown = Reflect.apply(draw, undefined, [props]);
    assert.ok(typeof html === 'string');
    return html;
  };
}

const roles = (members: Record<string, readonly string[]>) => ({
  version: 1,
  roles: [
    { id: 'admin', name: 'Admin', members: members['admin'] ?? [] },
    { id: 'client', name: 'Client', members: members['client'] ?? [] },
  ],
});

async function layout(
  draw: (props: Record<string, unknown>) => string,
  provider: string,
  options: {
    canManage?: boolean;
    kind?: 'built-in' | 'custom';
    members?: Record<string, readonly string[]>;
    me?: string;
    inviting?: boolean;
    outcome?: unknown;
  } = {},
) {
  const { parseProjectRoles } = await import('../vendor/stacki/shared/properties/projectRoles');
  const info = {
    provider,
    displayName: options.kind === 'custom' ? 'Acme SSO' : provider,
    kind: options.kind ?? 'built-in',
    canManage: options.canManage ?? true,
    origin: 'https://studio.example.com',
    me: options.me ?? 'owner',
    inviteHint: options.kind === 'custom' ? 'employee number' : undefined,
  };
  return draw({
    loaded: { info, roles: parseProjectRoles(roles(options.members ?? { admin: [options.me ?? 'owner'] })), source: '{}', passkeys: undefined },
    services: { now: () => 0 },
    reload: () => Promise.resolve(),
    initialInviting: options.inviting ?? true,
    ...(options.outcome === undefined ? {} : { initialOutcome: options.outcome }),
  });
}

test('each sign-in method gets its own invite form and no other', async () => {
  const draw = await bundle();
  const forms: readonly (readonly [string, RegExp, readonly RegExp[]])[] = [
    ['github', /GitHub username/, [/Email address/, />Handle</]],
    ['access', /Email address/, [/GitHub username/, />Handle</]],
    ['google', /Email address/, [/GitHub username/, />Handle</]],
    ['oidc', /Email address/, [/GitHub username/, />Handle</]],
    ['passkey', />Handle</, [/GitHub username/, /Email address/]],
  ];
  for (const [provider, expected, forbidden] of forms) {
    const html = await layout(draw, provider);
    assert.match(html, expected, provider);
    for (const pattern of forbidden) {
      assert.doesNotMatch(html, pattern, `${provider} must not offer ${String(pattern)}`);
    }
    assert.match(html, /<form[^>]*aria-label="Invite member"/, `${provider} form`);
    assert.match(html, /Role/, 'the role picker');
    assert.doesNotMatch(html, /<select/, 'never a native select');
  }
  assert.match(await layout(draw, 'passkey'), /Display name \(optional\)/);
  assert.doesNotMatch(await layout(draw, 'google'), /Display name/);
  const custom = await layout(draw, 'acme', { kind: 'custom' });
  assert.match(custom, /Acme SSO identifier/);
  assert.match(custom, /placeholder="employee number"/);
});

test('the invite defaults to the least-privileged role', async () => {
  const draw = await bundle();
  const html = await layout(draw, 'google');
  assert.match(html, /Client/, 'Client is the default choice');
});

test('a non-admin sees the list read-only: no Invite, no Remove, no role pickers', async () => {
  const draw = await bundle();
  const html = await layout(draw, 'google', {
    canManage: false,
    inviting: false,
    members: { admin: ['google:boss@corp.test'], client: ['google:ann@corp.test'] },
    me: 'google:ann@corp.test',
  });
  assert.match(html, /Only admins can invite or change members\./);
  assert.match(html, /ann@corp\.test/);
  assert.doesNotMatch(html, /Invite member/);
  assert.doesNotMatch(html, /aria-label="Remove /);
  assert.doesNotMatch(html, /aria-label="Role of /);
  const admin = await layout(draw, 'google', {
    inviting: false,
    members: { admin: ['google:boss@corp.test'], client: ['google:ann@corp.test'] },
    me: 'google:boss@corp.test',
  });
  assert.match(admin, /Invite member/);
  assert.match(admin, /aria-label="Remove ann@corp\.test"/);
  assert.match(admin, /aria-label="Role of ann@corp\.test"/);
  assert.match(admin, />you</);
});

test('members are shown as plain logins, emails and handles, whatever their provider prefix', async () => {
  const draw = await bundle();
  const html = await layout(draw, 'passkey', {
    inviting: false,
    members: { admin: ['passkey:owner'], client: ['octocat', 'google:ann@corp.test', 'oidc:u-42'] },
    me: 'passkey:owner',
  });
  for (const shown of ['>owner<', '>octocat<', '>ann@corp.test<', '>u-42<']) {
    assert.ok(html.includes(shown), shown);
  }
  assert.doesNotMatch(html, />google:ann/);
  assert.match(html, /title="google:ann@corp\.test"/, 'the full identity stays in the tooltip');
});

test('the outcome shows the sign-in link and the instruction, with the Access reminder only for Access', async () => {
  const draw = await bundle();
  const outcome = (accessReminder: boolean) => ({
    kind: 'link',
    link: 'https://studio.example.com/studio',
    signIn: true,
    accessReminder,
    expiresAt: undefined,
  });
  const access = await layout(draw, 'access', { inviting: false, outcome: outcome(true) });
  assert.match(access, /Stacki sends no email/);
  assert.match(access, /https:\/\/studio\.example\.com\/studio/);
  assert.match(access, /Cloudflare Zero Trust Access policy/);
  assert.match(access, /Copy link/);
  const google = await layout(draw, 'google', { inviting: false, outcome: outcome(false) });
  assert.doesNotMatch(google, /Zero Trust/);
  assert.match(google, /sign in at https:\/\/studio\.example\.com\/studio with that google account/i);
  const passkey = await layout(draw, 'passkey', {
    inviting: false,
    outcome: {
      kind: 'link',
      link: 'https://studio.example.com/studio/auth/login?invite=abc',
      signIn: false,
      accessReminder: false,
      expiresAt: Date.UTC(2030, 0, 15),
    },
  });
  assert.match(passkey, /One-time invite link, valid until/);
  assert.match(passkey, /invite=abc/);
});

test('server answers are parsed strictly: malformed or hostile shapes are refused', () => {
  const good = { provider: 'google', displayName: 'Google', kind: 'built-in', canManage: true, origin: 'https://s.test', me: 'owner' };
  assert.ok(parseAuthInfo(good).ok);
  for (const bad of [
    null,
    'x',
    [],
    {},
    { ...good, canManage: 'yes' },
    { ...good, kind: 'other' },
    { ...good, provider: 5 },
    { ...good, me: 'x'.repeat(500) },
    { ...good, origin: undefined },
  ]) {
    assert.equal(parseAuthInfo(bad).ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
  const view = {
    ok: true,
    result: {
      kind: 'view',
      view: {
        handles: [{ handle: 'zed', displayName: 'Zed', locked: false, passkeys: [{ id: 'abc', label: 'Phone', createdAt: 1, lastUsedAt: undefined }] }],
        invites: [{ hash: 'h'.repeat(30), handle: 'new', displayName: undefined, createdBy: 'passkey:owner', createdAt: 1, expiresAt: 2 }],
      },
    },
  };
  const parsed = parsePasskeyView(view);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.people[0]?.passkeys.length, 1);
  assert.equal(parsed.value.invites[0]?.handle, 'new');
  for (const bad of [
    null,
    {},
    { result: {} },
    { result: { view: { handles: 'x', invites: [] } } },
    { result: { view: { handles: [{ handle: 'a', passkeys: [{ id: 1 }] }], invites: [] } } },
    { result: { view: { handles: [], invites: [{ hash: 'x' }] } } },
    { result: { view: { handles: new Array(501).fill({}), invites: [] } } },
  ]) {
    assert.equal(parsePasskeyView(bad).ok, false, JSON.stringify(bad)?.slice(0, 40));
  }
  assert.ok(parseInviteLink({ ok: true, result: { kind: 'invite', link: 'https://s.test/studio/auth/login?invite=x', expiresAt: 5 } }).ok);
  for (const bad of [
    null,
    {},
    { result: { kind: 'done' } },
    { result: { kind: 'invite', link: 5, expiresAt: 1 } },
    { result: { kind: 'invite', link: 'x', expiresAt: -1 } },
  ]) {
    assert.equal(parseInviteLink(bad).ok, false);
  }
});
