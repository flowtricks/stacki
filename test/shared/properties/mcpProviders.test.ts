// Goal: the provider catalog is internally consistent and safe to offer: unique ids, https addresses (or a
// command), valid secret names, a server entry that passes the same parser the file codec uses, no secret
// value anywhere, and no bundled brand artwork or remote logo address.
// Method: walk every entry; build each with and without its optional inputs and parse the result; then
// feed the option builder bad URLs and bad project references.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MCP_LIMITS, isMcpEnvName, isMcpServerName, mcpConfigFromFileEntry, mcpFileFields } from '#dist/shared/properties/mcpConfig.js';
import { MCP_PROVIDERS, buildProviderConfig, findMcpProvider } from '#dist/shared/properties/mcpProviders.js';

test('ids are unique, valid server names, and the catalog lists the providers the panel promises', () => {
  const ids = MCP_PROVIDERS.map((provider) => provider.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const provider of MCP_PROVIDERS) {
    assert.ok(isMcpServerName(provider.name.replace(/[^A-Za-z0-9_.-]+/g, '-')), provider.id);
    assert.ok(provider.secrets.length <= MCP_LIMITS.secretsMax);
    assert.ok(provider.docsUrl.startsWith('https://'), provider.id);
  }
  for (const wanted of [
    'sanity',
    'figma',
    'github',
    'linear',
    'notion',
    'atlassian',
    'stripe',
    'supabase',
    'vercel',
    'cloudflare',
    'context7',
    'playwright',
    'sentry',
  ]) {
    assert.ok(findMcpProvider(wanted) !== undefined, wanted);
  }
  assert.equal(findMcpProvider('nope'), undefined);
  assert.equal(findMcpProvider('webflow'), undefined);
  assert.ok(!JSON.stringify(MCP_PROVIDERS).toLowerCase().includes('webflow'));
});

test('the shown Sanity server is the catalog entry', () => {
  const sanity = findMcpProvider('sanity');
  assert.ok(sanity !== undefined);
  assert.deepEqual(buildProviderConfig(sanity, { options: {}, optionalSecrets: [] }), {
    ok: true,
    value: { transport: 'http', url: 'https://mcp.sanity.io', headers: [] },
  });
});

test('every entry builds a server that reads back as itself through the file parser', () => {
  for (const provider of MCP_PROVIDERS) {
    const options = Object.fromEntries(provider.options.map((option) => [option.id, option.id === 'url' ? 'https://mcp.example.com/x' : 'abc123']));
    const all = provider.secrets.map((secret) => secret.name);
    for (const optionalSecrets of [[], all]) {
      const built = buildProviderConfig(provider, { options, optionalSecrets });
      assert.ok(built.ok, `${provider.id}: ${JSON.stringify(built)}`);
      const reread = mcpConfigFromFileEntry(mcpFileFields(built.value), provider.id);
      assert.ok(reread.ok, provider.id);
      assert.deepEqual(reread.value, built.value, provider.id);
    }
  }
});

test('addresses are https, commands are known launchers, secret names are variables, and secrets appear only as references', () => {
  for (const provider of MCP_PROVIDERS) {
    if (provider.transport === 'stdio') {
      assert.ok(['npx', 'uvx'].includes(provider.command ?? ''), provider.id);
    } else if ('url' in provider) {
      assert.ok(provider.url.startsWith('https://'), provider.id);
    }
    for (const secret of provider.secrets) {
      assert.ok(isMcpEnvName(secret.name), `${provider.id} ${secret.name}`);
    }
    const options = Object.fromEntries(provider.options.map((option) => [option.id, option.id === 'url' ? 'https://mcp.example.com/x' : 'abc123']));
    const built = buildProviderConfig(provider, { options, optionalSecrets: provider.secrets.map((secret) => secret.name) });
    assert.ok(built.ok);
    const text = JSON.stringify(built.value);
    for (const secret of provider.secrets) {
      assert.ok(text.includes(`\${${secret.name}}`), `${provider.id} refers to ${secret.name}`);
    }
  }
});

test('an optional secret left out is not sent, and a required one always is', () => {
  const github = findMcpProvider('github');
  const context7 = findMcpProvider('context7');
  assert.ok(github !== undefined && context7 !== undefined);
  const required = buildProviderConfig(github, { options: {}, optionalSecrets: [] });
  assert.ok(required.ok && required.value.transport === 'http');
  assert.deepEqual(required.value.headers, [{ name: 'Authorization', value: 'Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}' }]);
  const without = buildProviderConfig(context7, { options: {}, optionalSecrets: [] });
  assert.ok(without.ok && without.value.transport === 'http');
  assert.deepEqual(without.value.headers, []);
  const withKey = buildProviderConfig(context7, { options: {}, optionalSecrets: ['CONTEXT7_API_KEY'] });
  assert.ok(withKey.ok && withKey.value.transport === 'http');
  assert.deepEqual(withKey.value.headers, [{ name: 'CONTEXT7_API_KEY', value: '${CONTEXT7_API_KEY}' }]);
});

test('option inputs are checked: a required address, a valid URL, and a project reference that is an identifier', () => {
  const zapier = findMcpProvider('zapier');
  const supabase = findMcpProvider('supabase');
  assert.ok(zapier !== undefined && supabase !== undefined);
  assert.deepEqual(buildProviderConfig(zapier, { options: {}, optionalSecrets: [] }), { ok: false, error: 'missing-option' });
  assert.deepEqual(buildProviderConfig(zapier, { options: { url: 'javascript:alert(1)' }, optionalSecrets: [] }), { ok: false, error: 'bad-url' });
  assert.deepEqual(buildProviderConfig(zapier, { options: { url: 'http://x.example\nHost: y' }, optionalSecrets: [] }), { ok: false, error: 'bad-url' });
  const ref = buildProviderConfig(supabase, { options: { projectRef: 'abc-123' }, optionalSecrets: [] });
  assert.ok(ref.ok && ref.value.transport === 'http');
  assert.equal(ref.value.url, 'https://mcp.supabase.com/mcp?project_ref=abc-123');
  for (const bad of ['a b', 'a&b=c', '../x', 'x'.repeat(65), 'a#b']) {
    assert.deepEqual(buildProviderConfig(supabase, { options: { projectRef: bad }, optionalSecrets: [] }), { ok: false, error: 'bad-option' }, bad);
  }
});

test('the catalog carries no logo address and no brand artwork', () => {
  const text = JSON.stringify(MCP_PROVIDERS);
  assert.ok(!/\.(svg|png|jpe?g|ico|webp)/i.test(text));
  assert.ok(!/logo/i.test(text));
});
