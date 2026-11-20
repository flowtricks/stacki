// Goal: the sign-in choice for a hosted Studio is checked once, at the boundary, and every
// consumer (the create-stacki command and Desktop's Add Studio dialog) gets the same variables,
// the same secret commands and the same refusals.
// Method: table-driven pure tests. Valid drafts are built for every kind and their variables
// compared with the contract in studio/docs/auth-providers.md; each known-bad shape is refused
// with the field it belongs to; the wrangler.jsonc edit is run on files that hold comments,
// trailing commas, an existing AUTH_PROVIDER and one-line objects, and must change only the
// sign-in members. The wire parser must refuse unknown keys, so a secret cannot ride along.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STUDIO_AUTH_KINDS,
  STUDIO_AUTH_LIMITS,
  STUDIO_AUTH_VARIABLES,
  buildStudioAuth,
  emptyStudioAuthDraft,
  parseStudioAuth,
  studioAuthAdminSubject,
  studioAuthGuide,
  studioAuthNextSteps,
  studioAuthVariables,
  suggestSetupCode,
  type StudioAuthConfig,
  type StudioAuthDraft,
} from '#dist/shared/ipc/studioAuth.js';
import { applyStudioAuth, readStudioSignIn } from '#dist/shared/ipc/studioAuthConfigFile.js';

function built(draft: StudioAuthDraft): StudioAuthConfig {
  const result = buildStudioAuth(draft);
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.error));
  return result.value;
}

const google = {
  ...emptyStudioAuthDraft('google'),
  clientId: 'abc.apps.googleusercontent.com',
  admin: 'Me@Example.com',
  allowedDomains: '@Example.com, corp.io',
};
const oidc = { ...emptyStudioAuthDraft('oidc'), issuer: 'https://login.corp.com/realms/main', clientId: 'studio', admin: 'me@corp.com', name: 'Corp SSO' };
const AUD = 'f'.repeat(64);
const access = { ...emptyStudioAuthDraft('access'), teamDomain: 'MyTeam.cloudflareaccess.com', aud: AUD, admin: 'Boss@Corp.com' };

test('every kind produces the contract variables, GitHub none', () => {
  assert.deepEqual(studioAuthVariables(built(emptyStudioAuthDraft('github'))), []);
  assert.deepEqual(studioAuthVariables(built(google)), [
    ['AUTH_PROVIDER', 'google'],
    ['GOOGLE_CLIENT_ID', 'abc.apps.googleusercontent.com'],
    ['AUTH_ALLOWED_DOMAINS', 'example.com,corp.io'],
    ['AUTH_BOOTSTRAP_ADMIN', 'google:me@example.com'],
  ]);
  assert.deepEqual(studioAuthVariables(built({ ...oidc, allowedEmails: 'A@corp.com\nb@corp.com' })), [
    ['AUTH_PROVIDER', 'oidc'],
    ['OIDC_ISSUER', 'https://login.corp.com/realms/main'],
    ['OIDC_CLIENT_ID', 'studio'],
    ['OIDC_NAME', 'Corp SSO'],
    ['AUTH_ALLOWED_EMAILS', 'a@corp.com,b@corp.com'],
    ['AUTH_BOOTSTRAP_ADMIN', 'oidc:me@corp.com'],
  ]);
  assert.deepEqual(studioAuthVariables(built(emptyStudioAuthDraft('passkey'))), [
    ['AUTH_PROVIDER', 'passkey'],
    ['AUTH_BOOTSTRAP_ADMIN', 'passkey:owner'],
  ]);
  assert.equal(built({ ...emptyStudioAuthDraft('passkey'), admin: 'Sam.K' }).kind, 'passkey');
  assert.equal(studioAuthAdminSubject(built(google)), 'me@example.com');
  for (const kind of STUDIO_AUTH_KINDS) {
    for (const [name] of studioAuthVariables(
      built(kind === 'google' ? google : kind === 'oidc' ? oidc : kind === 'access' ? access : emptyStudioAuthDraft(kind)),
    )) {
      assert.ok(STUDIO_AUTH_VARIABLES.includes(name), `${name} is a managed variable`);
    }
  }
});

test('Cloudflare Access writes team domain, audience and admin, and holds no secret', () => {
  assert.deepEqual(STUDIO_AUTH_KINDS, ['github', 'access', 'google', 'oidc', 'passkey']);
  assert.deepEqual(studioAuthVariables(built(access)), [
    ['AUTH_PROVIDER', 'access'],
    ['ACCESS_TEAM_DOMAIN', 'myteam.cloudflareaccess.com'],
    ['ACCESS_AUD', AUD],
    ['AUTH_BOOTSTRAP_ADMIN', 'access:boss@corp.com'],
  ]);
  assert.deepEqual(studioAuthGuide(built(access)).secretLines, []);
  const text = studioAuthNextSteps(built(access)).join('\n');
  assert.match(text, /\/studio\*/);
  assert.match(text, /\(AUD\) tag/);
  assert.match(text, /BOTH[\s\S]*roles\.json/);
  assert.equal(studioAuthAdminSubject(built(access)), 'boss@corp.com');
  const cases: ReadonlyArray<readonly [Partial<StudioAuthDraft>, string, string]> = [
    [{ teamDomain: '' }, 'teamDomain', 'required'],
    [{ teamDomain: 'not a host' }, 'teamDomain', 'invalid'],
    [{ teamDomain: 'access.corp.com' }, 'teamDomain', 'customDomain'],
    [{ aud: '' }, 'aud', 'required'],
    [{ aud: 'abc' }, 'aud', 'tooShort'],
    [{ aud: 'x'.repeat(129) }, 'aud', 'tooLong'],
    [{ aud: `${'a'.repeat(40)}!` }, 'aud', 'invalid'],
  ];
  for (const [change, field, code] of cases) {
    const result = buildStudioAuth({ ...access, ...change });
    assert.ok(!result.ok && result.error.some((problem) => problem.field === field && problem.code === code), `${field} ${code}`);
  }
  const custom = built({ ...access, teamDomain: 'access.corp.com', teamDomainCheck: 'custom' });
  assert.equal(custom.kind === 'access' ? custom.teamDomainCustom : '', 'confirmed');
  assert.deepEqual(parseStudioAuth(custom), custom);
  assert.throws(() => parseStudioAuth({ ...built(access), clientSecret: 'x' }));
  assert.throws(() => parseStudioAuth({ ...built(access), teamDomain: 'access.corp.com' }));
});

test('the name falls back to SSO and the OIDC issuer is kept exactly as typed', () => {
  const config = built({ ...oidc, name: '  ', issuer: 'https://idp.example.com/' });
  assert.equal(config.kind === 'oidc' ? config.name : '', 'SSO');
  assert.equal(config.kind === 'oidc' ? config.issuer : '', 'https://idp.example.com/');
});

test('known-bad values are refused with the field that holds them', () => {
  const cases: ReadonlyArray<readonly [StudioAuthDraft, string, string]> = [
    [{ ...google, clientId: '' }, 'clientId', 'required'],
    [{ ...google, clientId: 'has space' }, 'clientId', 'invalid'],
    [{ ...google, clientId: 'x'.repeat(STUDIO_AUTH_LIMITS.clientIdCharsMax + 1) }, 'clientId', 'tooLong'],
    [{ ...google, admin: '' }, 'admin', 'required'],
    [{ ...google, admin: 'not-an-email' }, 'admin', 'invalid'],
    [{ ...google, admin: 'a,b@c.io' }, 'admin', 'invalid'],
    [{ ...google, allowedEmails: 'ok@x.io, nope' }, 'allowedEmails', 'invalid'],
    [{ ...google, allowedDomains: 'localhost' }, 'allowedDomains', 'invalid'],
    [{ ...google, allowedDomains: '-bad.example.com' }, 'allowedDomains', 'invalid'],
    [{ ...google, allowedDomains: Array.from({ length: 51 }, (_, index) => `d${index}.example.com`).join(',') }, 'allowedDomains', 'tooMany'],
    [{ ...oidc, issuer: '' }, 'issuer', 'required'],
    [{ ...oidc, issuer: 'http://login.corp.com' }, 'issuer', 'invalid'],
    [{ ...oidc, issuer: 'login.corp.com' }, 'issuer', 'invalid'],
    [{ ...oidc, issuer: 'https://user:pw@login.corp.com' }, 'issuer', 'invalid'],
    [{ ...oidc, issuer: 'https://login.corp.com/?x=1' }, 'issuer', 'invalid'],
    [{ ...oidc, issuer: `https://x.io/${'a'.repeat(STUDIO_AUTH_LIMITS.issuerCharsMax)}` }, 'issuer', 'tooLong'],
    [{ ...oidc, name: 'a'.repeat(61) }, 'name', 'tooLong'],
    [{ ...oidc, name: 'bad\u0007name' }, 'name', 'invalid'],
    [{ ...emptyStudioAuthDraft('passkey'), admin: 'Has Space' }, 'admin', 'invalid'],
    [{ ...emptyStudioAuthDraft('passkey'), admin: '-x' }, 'admin', 'invalid'],
    [{ ...emptyStudioAuthDraft('passkey'), admin: 'x'.repeat(65) }, 'admin', 'tooLong'],
  ];
  for (const [draft, field, code] of cases) {
    const result = buildStudioAuth(draft);
    assert.equal(result.ok, false, `${field} ${code}`);
    assert.ok(!result.ok && result.error.some((problem) => problem.field === field && problem.code === code), `${field} ${code}: ${JSON.stringify(result)}`);
  }
  const all = buildStudioAuth({ ...emptyStudioAuthDraft('oidc') });
  assert.ok(!all.ok && all.error.length === 3, 'every missing field is reported at once');
});

test('the guide prints the secret command and the redirect path, never a value', () => {
  assert.deepEqual(studioAuthGuide(built(google)), {
    secretLines: ['cd studio', 'npx wrangler secret put GOOGLE_CLIENT_SECRET --config cloudflare/wrangler.jsonc'],
    redirectPath: '/studio/auth/google/callback',
    bootstrapPath: undefined,
    secretNames: ['GOOGLE_CLIENT_SECRET'],
  });
  assert.equal(studioAuthGuide(built(oidc)).redirectPath, '/studio/auth/oidc/callback');
  assert.deepEqual(studioAuthGuide(built(emptyStudioAuthDraft('passkey'))), {
    secretLines: ['cd studio', 'npx wrangler secret put AUTH_SETUP_CODE --config cloudflare/wrangler.jsonc'],
    redirectPath: undefined,
    bootstrapPath: '/studio/auth/passkey/bootstrap',
    secretNames: ['AUTH_SETUP_CODE'],
  });
  const passkey = studioAuthNextSteps(built(emptyStudioAuthDraft('passkey'))).join('\n');
  assert.match(passkey, /AUTH_BOOTSTRAP_ADMIN/);
  assert.match(passkey, /long random code \(16 to 200 characters/);
  assert.match(passkey, /\/studio\/auth\/passkey\/bootstrap/);
  assert.match(passkey, /Roles view/);
  assert.match(studioAuthNextSteps(built(access)).join('\n'), /ACCESS_TEAM_DOMAIN[\s\S]*ACCESS_AUD[\s\S]*policy/);
  const suggestion = suggestSetupCode(new Uint8Array(32).fill(7));
  assert.match(suggestion, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => suggestSetupCode(new Uint8Array(8)), /32 random bytes/);
  assert.deepEqual(studioAuthGuide({ kind: 'github' }).secretLines, []);
  assert.equal(studioAuthGuide(built(google)).bootstrapPath, undefined);
  const text = studioAuthNextSteps(built(oidc)).join('\n');
  assert.match(text, /OIDC_CLIENT_SECRET/);
  assert.match(text, /https:\/\/<your-site>\/studio\/auth\/oidc\/callback/);
  assert.match(text, /public PKCE client has no client secret/);
});

test('the wire parser accepts a checked choice and refuses everything else', () => {
  const config = built(google);
  assert.deepEqual(parseStudioAuth(config), config);
  assert.deepEqual(parseStudioAuth({ kind: 'github' }), { kind: 'github' });
  assert.deepEqual(parseStudioAuth({ kind: 'passkey', admin: 'passkey:sam' }), { kind: 'passkey', admin: 'passkey:sam' });
  const refused: readonly unknown[] = [
    undefined,
    'google',
    {},
    { kind: 'saml' },
    { ...config, clientSecret: 'shh' },
    { ...config, secret: 'shh' },
    { ...config, admin: 'oidc:me@example.com' },
    { ...config, admin: 'me@example.com' },
    { ...config, clientId: 12 },
    { ...config, allowedDomains: 'example.com' },
    { ...config, allowedDomains: ['example.com', 7] },
    { ...config, allowedDomains: Array.from({ length: 51 }, (_, index) => `d${index}.example.com`) },
    { ...config, clientId: 'x'.repeat(2000) },
    { kind: 'oidc', issuer: 'http://x.io', clientId: 'a', admin: 'oidc:a@b.co' },
    { kind: 'passkey', admin: 'passkey:Has Space' },
  ];
  for (const value of refused) {
    assert.throws(() => parseStudioAuth(value), Error, JSON.stringify(value));
  }
});

// A project's own file: comments, trailing commas, other vars and routes the edit must not disturb.
const FILE = `{
  // Name of the Worker.
  "name": "stacki-studio",
  "vars": {
    "STUDIO_ORIGIN": "https://studio.example.com", // keep
    "EDITOR_ACCESS": "repository",
    "EDITOR_GITHUB_IDS": "",
  },
  "routes": [{ "pattern": "example.com/studio*" }],
}
`;

function applied(text: string, config: StudioAuthConfig, existing: 'refuse' | 'replace' = 'refuse'): string {
  const result = applyStudioAuth(text, config, existing);
  assert.ok(result.ok, JSON.stringify(result.ok ? '' : result.error));
  return result.value;
}

test('the file edit inserts only the sign-in members and leaves the rest byte for byte', () => {
  const after = applied(FILE, built(google));
  assert.equal(after.slice(0, after.indexOf('    // How people sign in')), FILE.slice(0, FILE.indexOf('  },\n  "routes"')));
  assert.ok(after.endsWith('  },\n  "routes": [{ "pattern": "example.com/studio*" }],\n}\n'));
  assert.match(after, /"AUTH_PROVIDER": "google",\n/);
  assert.match(after, /\/\/ keep\n/);
  assert.deepEqual(readStudioSignIn(after), { ok: true, value: 'google' });
});

test('switching removes what the new choice does not use, and GitHub returns the original file', () => {
  const asOidc = applied(FILE, built({ ...oidc, allowedDomains: 'corp.com' }));
  const asGoogle = applied(asOidc, built(google), 'replace');
  assert.doesNotMatch(asGoogle, /OIDC_|corp\.com/);
  assert.match(asGoogle, /GOOGLE_CLIENT_ID/);
  assert.equal(applied(asGoogle, { kind: 'github' }, 'replace'), FILE);
  assert.deepEqual(readStudioSignIn(FILE), { ok: true, value: 'github' });
});

test('an existing AUTH_PROVIDER is refused unless replacement is explicit', () => {
  const custom = FILE.replace('"EDITOR_ACCESS"', '"AUTH_PROVIDER": "my-sso",\n    "EDITOR_ACCESS"');
  const refused = applyStudioAuth(custom, built(google), 'refuse');
  assert.deepEqual(refused, { ok: false, error: { kind: 'alreadySet', provider: 'my-sso' } });
  assert.deepEqual(readStudioSignIn(custom), { ok: true, value: 'custom' });
  const replaced = applied(custom, built(google), 'replace');
  assert.doesNotMatch(replaced, /my-sso/);
  assert.match(replaced, /"AUTH_PROVIDER": "google"/);
});

test('the edit handles one-line objects, an empty vars and a last member without a comma', () => {
  const oneLine = '{ "vars": { "A": "b" } }';
  assert.equal(
    applied(oneLine, built(emptyStudioAuthDraft('passkey'))).replace(/\s+/g, ' '),
    '{ "vars": { "A": "b", "AUTH_PROVIDER": "passkey", "AUTH_BOOTSTRAP_ADMIN": "passkey:owner" } }',
  );
  const empty = applied('{\n  "vars": {},\n}\n', built(emptyStudioAuthDraft('passkey')));
  assert.match(empty, /"AUTH_PROVIDER": "passkey",\n/);
  assert.deepEqual(readStudioSignIn(empty), { ok: true, value: 'passkey' });
  const noComma = '{\n  "vars": {\n    "A": "b"\n  }\n}\n';
  const added = applied(noComma, built(emptyStudioAuthDraft('passkey')));
  assert.match(added, /"A": "b",\n/);
  assert.doesNotMatch(added, /,\n\s*\}/, 'a file without trailing commas keeps none');
  assert.equal(applied(added, { kind: 'github' }, 'replace'), noComma);
});

test('a file the scanner cannot place is reported, never rewritten', () => {
  for (const text of ['', '[]', '{ "vars": ', '{ "name": "x" }', '{ "vars": [] }', '{ "vars": { "A": "unterminated } }', '{ /* open }']) {
    const result = applyStudioAuth(text, built(google), 'replace');
    assert.equal(result.ok, false, text);
  }
  assert.deepEqual(applyStudioAuth('x'.repeat(1_000_001), built(google), 'replace'), { ok: false, error: { kind: 'tooLarge' } });
});
