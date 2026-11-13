// Goal: everything a template form sends, and everything main answers, crosses the boundary
// parsed, and the values that would publish a secret are refused. Method: one known-good
// value per shape, then each known-bad field and bound, with the messages designers read pinned.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADDRESS_LIMITS,
  PAGE_TEMPLATE_LIMITS,
  addressFitOf,
  dataPathSegments,
  parseDataSample,
  parseDataSampleRequest,
  parseDataSource,
  parseEnvName,
  parsePageTemplateDraft,
  parsePageTemplatePlan,
  parseSecretValue,
  parseSourceURL,
  parseTemplateRoute,
  slugifyAddress,
} from '#dist/shared/properties/pageTemplate.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const CONNECTION = '00000000-0000-4000-8000-000000000000';
const FIELDS = [{ path: 'title', kind: 'string' }];
const CONTENT = { kind: 'content-collection', collection: 'blog', origin: 'existing', slug: { kind: 'entry-id' } };
const SANITY = {
  kind: 'sanity',
  projectId: 'abc123',
  dataset: 'production',
  documentType: 'post',
  slugPath: 'slug.current',
  slugTreatment: 'exact',
  fields: FIELDS,
};
const HTTP = {
  kind: 'http-json',
  url: 'https://api.example.com/items',
  headers: [],
  listPath: 'data.items',
  slugPath: 'id',
  slugTreatment: 'slugified',
  fields: FIELDS,
};

test('a route pattern becomes a page file and its placeholder', () => {
  for (const [route, file, param] of [
    ['/blog/[slug]', 'blog/[slug].astro', 'slug'],
    ['  /blog/[slug] ', 'blog/[slug].astro', 'slug'],
    ['/[slug]', '[slug].astro', 'slug'],
    ['/docs/guides/[...path]', 'docs/guides/[...path].astro', 'path'],
    ['/shop/[id]/details', 'shop/[id]/details.astro', 'id'],
  ] as const) {
    const parsed = parseTemplateRoute(route);
    assert.deepEqual(parsed, { ok: true, value: { file, param } }, route);
  }
});

test('a route that could not be a template says what to fix', () => {
  for (const [route, message] of [
    ['', /Enter a route/],
    ['blog/[slug]', /starts with \//],
    ['/blog', /needs a placeholder/],
    ['/blog//[slug]', /no empty parts/],
    ['/blog/[slug]/', /no empty parts/],
    ['/[lang]/blog/[slug]', /one placeholder/],
    ['/[...slug]/more', /comes last/],
    ['/blog/../[slug]', /cannot be part of a route/],
    ['/./[slug]', /cannot be part of a route/],
    ['/_drafts/[slug]', /cannot be part of a route/],
    ['/blog/post-[slug]', /cannot be part of a route/],
    ['/blog/[1slug]', /cannot be part of a route/],
    ['/blog/[slug', /cannot be part of a route/],
    ['/my blog/[slug]', /cannot be part of a route/],
    [`/${'a'.repeat(PAGE_TEMPLATE_LIMITS.routeCharsMax)}/[slug]`, /at most 256 characters/],
    [`/${'a/'.repeat(PAGE_TEMPLATE_LIMITS.routeSegmentsMax)}[slug]`, /at most 12 parts/],
  ] as const) {
    const parsed = parseTemplateRoute(route);
    assert.equal(parsed.ok, false, route);
    assert.match(parsed.ok ? '' : parsed.error, message);
  }
});

test('an address is fetched and saved only when it cannot carry a secret', () => {
  assert.deepEqual(parseSourceURL(' https://api.example.com/items?page=1 '), { ok: true, value: 'https://api.example.com/items?page=1' });
  assert.equal(parseSourceURL('http://localhost:3000/items').ok, true);
  for (const [url, message] of [
    ['', /Enter the address/],
    ['api.example.com/items', /not a complete address/],
    ['ftp://example.com/items', /starts with https/],
    ['file:///etc/passwd', /starts with https/],
    ['https://user:hunter2@example.com/items', /Remove the user name/],
    ['https://user@example.com/items', /Remove the user name/],
    ['https://example.com/items?api_key=abc', /“api_key” looks like a secret/],
    ['https://example.com/items?access_token=abc', /“access_token” looks like a secret/],
    ['https://example.com/items?Password=abc', /looks like a secret/],
    [`https://example.com/${'a'.repeat(PAGE_TEMPLATE_LIMITS.urlCharsMax)}`, /too long/],
  ] as const) {
    const parsed = parseSourceURL(url);
    assert.equal(parsed.ok, false, url);
    assert.match(parsed.ok ? '' : parsed.error, message);
  }
});

test('a secret lives in a private variable, one line and bounded', () => {
  assert.deepEqual(parseEnvName('API_TOKEN'), { ok: true, value: 'API_TOKEN' });
  for (const name of ['api_token', '1TOKEN', 'MY-TOKEN', '', 'A'.repeat(129)]) {
    assert.equal(parseEnvName(name).ok, false, name);
  }
  const exposed = parseEnvName('PUBLIC_TOKEN');
  assert.match(exposed.ok ? '' : exposed.error, /sent to the browser/);
  assert.equal(parseSecretValue('abc def'), 'abc def');
  for (const value of ['', 'two\nlines', 'two\rlines', 'x'.repeat(PAGE_TEMPLATE_LIMITS.secretCharsMax + 1), 7, undefined]) {
    assert.throws(() => parseSecretValue(value), /Project variable/);
  }
});

test('data paths step through plain field names only', () => {
  assert.deepEqual(dataPathSegments(''), { ok: true, value: [] });
  assert.deepEqual(dataPathSegments('data.items-list'), { ok: true, value: ['data', 'items-list'] });
  for (const path of ['a..b', '.a', 'a.', 'a b', '0.a', 'a.b.c.d.e.f.g.h.i', 'a'.repeat(129), "a'b", 'a[0]']) {
    assert.equal(dataPathSegments(path).ok, false, path);
  }
});

test('each data source parses, and each bad field is refused', () => {
  assert.deepEqual(parseDataSource(CONTENT), CONTENT);
  const byField = { ...CONTENT, slug: { kind: 'field', name: 'path', treatment: 'slugified' } };
  assert.deepEqual(parseDataSource(byField), byField);
  assert.deepEqual(parseDataSource(SANITY), { ...SANITY, tokenEnv: undefined });
  assert.deepEqual(parseDataSource({ ...SANITY, tokenEnv: 'SANITY_TOKEN' }), { ...SANITY, tokenEnv: 'SANITY_TOKEN' });
  assert.deepEqual(parseDataSource(HTTP), HTTP);
  const nested = { ...HTTP, fields: [{ path: 'author.name', kind: 'string' }] };
  assert.deepEqual(parseDataSource(nested), nested);
  const header = { name: 'X-Key', env: 'API_KEY', scheme: 'bearer' };
  assert.deepEqual(parseDataSource({ ...HTTP, headers: [header] }), { ...HTTP, headers: [header] });
  const tooMany = Array.from({ length: PAGE_TEMPLATE_LIMITS.fieldsMax + 1 }, (_item, index) => ({ path: `f${index}`, kind: 'string' }));
  for (const bad of [
    undefined,
    { kind: 'mystery' },
    { ...CONTENT, collection: '../secrets' },
    { ...CONTENT, origin: 'copied' },
    { ...CONTENT, origin: 'new', collection: 'nav-links' },
    { ...CONTENT, slug: { kind: 'hash' } },
    { ...CONTENT, slug: { kind: 'field', name: 'a b', treatment: 'exact' } },
    { ...CONTENT, slug: { kind: 'field', name: 'path' } },
    { ...SANITY, slugTreatment: 'raw' },
    { ...HTTP, slugTreatment: undefined },
    { ...SANITY, projectId: 'ABC' },
    { ...SANITY, dataset: 'pro duction' },
    { ...SANITY, documentType: '"] | *[' },
    { ...SANITY, tokenEnv: 'PUBLIC_SANITY' },
    { ...SANITY, tokenEnv: 'token value' },
    { ...SANITY, slugPath: '' },
    { ...SANITY, fields: [] },
    { ...HTTP, url: 'https://example.com/?token=abc' },
    { ...HTTP, headers: [{ ...header, name: 'X Key' }] },
    { ...HTTP, headers: [{ ...header, env: 'lower' }] },
    { ...HTTP, headers: [{ ...header, scheme: 'basic' }] },
    { ...HTTP, headers: Array.from({ length: PAGE_TEMPLATE_LIMITS.headersMax + 1 }, () => header) },
    { ...HTTP, listPath: 'a b' },
    { ...HTTP, fields: [{ path: 'author..name', kind: 'string' }] },
    { ...HTTP, fields: [{ path: '', kind: 'string' }] },
    { ...HTTP, fields: [{ path: 'title', kind: 'date' }] },
    { ...HTTP, fields: [FIELDS[0], FIELDS[0]] },
    { ...HTTP, fields: tooMany },
  ]) {
    assert.throws(() => parseDataSource(bad), /./, JSON.stringify(bad)?.slice(0, 80));
  }
});

test('values are judged as addresses: as they are, slugified, or not at all', () => {
  assert.deepEqual(addressFitOf(['hello-world', 'second.post', 7]), { kind: 'exact' });
  assert.deepEqual(addressFitOf(['25%', '99.9%']), { kind: 'slugified', example: '25' });
  assert.deepEqual(addressFitOf(['Uptime (copy)', 'Uptime']), { kind: 'slugified', example: 'uptime-copy' });
  assert.deepEqual(addressFitOf(['Café', 'Crème brûlée']), { kind: 'slugified', example: 'cafe' });
  assert.deepEqual(addressFitOf(['25%', '25 %']), {
    kind: 'unusable',
    reason: 'Two entries would share the address 25',
    reasonRef: { key: 'pages.template.address.repeated', params: { address: '25' } },
  });
  assert.deepEqual(addressFitOf(['same', 'same']), {
    kind: 'unusable',
    reason: 'Two entries would share the address same',
    reasonRef: { key: 'pages.template.address.repeated', params: { address: 'same' } },
  });
  assert.deepEqual(
    addressFitOf(['One', 'one']),
    { kind: 'unusable', reason: 'Two entries would share the address one', reasonRef: { key: 'pages.template.address.repeated', params: { address: 'one' } } },
    'case is no difference on every disk',
  );
  for (const value of ['', '   ', undefined, { current: 'x' }]) {
    assert.deepEqual(addressFitOf(['ok', value]), {
      kind: 'unusable',
      reason: 'Some entries have no value',
      reasonRef: { key: 'pages.template.address.noValue' },
    });
  }
  assert.deepEqual(addressFitOf([]), { kind: 'unusable', reason: 'Some entries have no value', reasonRef: { key: 'pages.template.address.noValue' } });
  assert.deepEqual(addressFitOf(['%%%', 'ok']), {
    kind: 'unusable',
    reason: 'Some values have no letters or numbers',
    reasonRef: { key: 'pages.template.address.noLetters' },
  });
  assert.deepEqual(addressFitOf(['日本語']), {
    kind: 'unusable',
    reason: 'Some values have no letters or numbers',
    reasonRef: { key: 'pages.template.address.noLetters' },
  });
  assert.deepEqual(addressFitOf(['a'.repeat(ADDRESS_LIMITS.valueCharsMax)]), { kind: 'exact' });
  assert.deepEqual(addressFitOf(['a'.repeat(ADDRESS_LIMITS.valueCharsMax + 1)]), {
    kind: 'unusable',
    reason: 'Too long for a page address',
    reasonRef: { key: 'pages.template.address.tooLong' },
  });
  assert.equal(slugifyAddress('  Déjà  Vu! '), 'deja-vu');
});

test('a draft carries a checked route and an optional layout', () => {
  const draft = parsePageTemplateDraft({ route: ' /blog/[slug] ', layout: { name: 'Base', path: '/site/src/layouts/Base.astro' }, source: CONTENT });
  assert.equal(draft.route, '/blog/[slug]');
  assert.equal(draft.layout?.name, 'Base');
  assert.equal(parsePageTemplateDraft({ route: '/blog/[slug]', source: CONTENT }).layout, undefined);
  assert.throws(() => parsePageTemplateDraft({ route: '/blog', source: CONTENT }), /needs a placeholder/);
  assert.throws(() => parsePageTemplateDraft({ route: '/blog/[slug]', source: {} }), /unknown data source/);
});

test('sample requests and replies are parsed on the way across', () => {
  assert.equal(parseDataSampleRequest({ kind: 'sanity-types', connectionId: CONNECTION }).kind, 'sanity-types');
  assert.equal(parseDataSampleRequest({ kind: 'sanity-documents', connectionId: CONNECTION, documentType: 'post' }).kind, 'sanity-documents');
  assert.throws(() => parseDataSampleRequest({ kind: 'sanity-types', projectId: 'abc', dataset: 'production' }));
  assert.deepEqual(
    parseIpcPayload('pageTemplate:create', {
      projectPath: '/site',
      draft: { route: '/blog/[slug]', source: CONTENT },
      keyCopy: { connectionId: CONNECTION, env: 'SANITY_API_TOKEN' },
    }).keyCopy,
    { connectionId: CONNECTION, env: 'SANITY_API_TOKEN' },
  );
  assert.throws(() =>
    parseIpcPayload('pageTemplate:create', {
      projectPath: '/site',
      draft: { route: '/blog/[slug]', source: CONTENT },
      keyCopy: { connectionId: CONNECTION, env: 'PUBLIC_TOKEN' },
    }),
  );
  assert.equal(parseDataSampleRequest({ kind: 'content-collection', collection: 'blog' }).kind, 'content-collection');
  assert.throws(() => parseDataSampleRequest({ kind: 'content-collection', collection: '../x' }));
  assert.throws(() => parseDataSampleRequest({ kind: 'file', path: '/etc/passwd' }), /unknown sample request/);
  assert.throws(() => parseDataSampleRequest({ kind: 'http-json', url: 'ftp://example.com', headers: [] }), /starts with https/);
  const lists = { kind: 'lists', lists: [{ path: '', count: 2, fields: [{ path: 'slug.current', kind: 'string', example: 'one' }] }] };
  assert.deepEqual(parseDataSample(lists), lists);
  const fitted = (address: unknown) => ({ kind: 'lists', lists: [{ path: '', count: 1, fields: [{ path: 'a', kind: 'string', example: 'x', address }] }] });
  for (const address of [
    { kind: 'exact' },
    { kind: 'slugified', example: '25' },
    { kind: 'unusable', reason: 'Too long for a page address', reasonRef: { key: 'pages.template.address.tooLong' } },
  ]) {
    assert.deepEqual(parseDataSample(fitted(address)), fitted(address));
  }
  for (const address of [{ kind: 'maybe' }, { kind: 'slugified' }, { kind: 'unusable', reason: 'x'.repeat(ADDRESS_LIMITS.reasonCharsMax + 1) }]) {
    assert.throws(() => parseDataSample(fitted(address)));
  }
  assert.deepEqual(parseDataSample({ kind: 'types', types: ['post'], access: 'private' }), { kind: 'types', types: ['post'], access: 'private' });
  for (const bad of [
    undefined,
    { kind: 'other' },
    { kind: 'types', types: ['a b'], access: 'public' },
    { kind: 'types', types: ['post'] },
    { kind: 'types', types: Array.from({ length: PAGE_TEMPLATE_LIMITS.typesMax + 1 }, () => 'post'), access: 'public' },
    { kind: 'lists', lists: [{ path: '', count: -1, fields: [] }] },
    { kind: 'lists', lists: [{ path: '', count: 1, fields: [{ path: 'a', kind: 'date', example: '' }] }] },
    { kind: 'lists', lists: [{ path: '', count: 1, fields: [{ path: 'a', kind: 'string', example: 'x'.repeat(PAGE_TEMPLATE_LIMITS.exampleCharsMax + 1) }] }] },
  ]) {
    assert.throws(() => parseDataSample(bad));
  }
});

test('a plan lists bounded files and variable states, never values', () => {
  const plan = {
    route: '/a/[slug]',
    changes: [{ path: 'src/pages/a/[slug].astro', action: 'create', text: '---\n---\n' }],
    env: [{ name: 'API_TOKEN', state: 'set' }],
  };
  assert.deepEqual(parsePageTemplatePlan(plan), plan);
  for (const bad of [
    { ...plan, changes: [{ ...plan.changes[0], action: 'delete' }] },
    { ...plan, changes: [{ ...plan.changes[0], text: 'x'.repeat(PAGE_TEMPLATE_LIMITS.changeCharsMax + 1) }] },
    { ...plan, changes: Array.from({ length: PAGE_TEMPLATE_LIMITS.changesMax + 1 }, () => plan.changes[0]) },
    { ...plan, env: [{ name: 'API_TOKEN', state: 'value' }] },
  ]) {
    assert.throws(() => parsePageTemplatePlan(bad));
  }
});
