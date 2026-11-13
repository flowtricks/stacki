// Goal: a template page is generated exactly, from a form's values alone, for each data
// source; samples are bounded and parsed; a secret reaches .env and nowhere else; and a
// content-collection template is created, read back as a template, and binds at once.
// Method: generated source is compared as exact text; samples run against a local fake
// server, Sanity's address rewritten onto it because no credentials exist here; .env rules
// run in throwaway Git repositories; the end-to-end test writes a temporary project with
// its content config injected, then reads the page through the real parser and data tree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pageTemplateText, headingField } = require('#dist/electron/content/pageTemplateSource.js');
const { DATA_SAMPLE_FETCH, fieldsOf, listsIn, sampleData } = require('#dist/electron/content/dataSample.js');
const { applyPageTemplate, planPageTemplate } = require('#dist/electron/content/pageTemplatePlan.js');
const { envEntries, gitignoreWithEnv, readProjectEnv, withEnvValue, writeProjectSecret } = require('#dist/electron/content/projectEnv.js');
const { parsePageSource } = require('#dist/electron/documents/pageRequests.js');
const load = require('../../helpers/rendererModule');

const route = { file: 'blog/[slug].astro', param: 'slug' };
const layout = { name: 'Base', importPath: '../../layouts/Base.astro' };
const content = { kind: 'content-collection', collection: 'blog', origin: 'existing', slug: { kind: 'entry-id' } };
const facts = { body: 'rendered', heading: 'title', api: 'current' };
const fields = [
  { path: 'title', kind: 'string' },
  { path: 'price', kind: 'number' },
  { path: 'tags', kind: 'list' },
  { path: 'sale-price', kind: 'number' },
];

const temporary = (context, name) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `stacki-${name}-`)));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

test('a content collection page reads its entries, renders its body and types its entry', () => {
  const text = pageTemplateText({ route, source: content, layout, collection: facts, prerender: 'inherited' });
  assert.equal(
    text,
    `---
import { getCollection, render } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import Base from '../../layouts/Base.astro';

export async function getStaticPaths() {
	const entries = await getCollection('blog');
	return entries.map((entry) => ({ params: { slug: entry.id }, props: { entry } }));
}

interface Props {
	entry: CollectionEntry<'blog'>;
}

const { entry } = Astro.props;
const { Content } = await render(entry);
---

<Base>
	<h1>{entry.data.title}</h1>
	<Content />
</Base>
`,
  );
});

test('a collection without a body, addressed by a field, renders nothing it does not have', () => {
  const source = { ...content, collection: 'nav-links', slug: { kind: 'field', name: 'url-path', treatment: 'exact' } };
  const text = pageTemplateText({
    route: { file: '[...path].astro', param: 'path' },
    source,
    layout: undefined,
    collection: { body: 'none', heading: undefined, api: 'current' },
    prerender: 'explicit',
  });
  assert.equal(
    text,
    `---
import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export const prerender = true;

export async function getStaticPaths() {
	const entries = await getCollection('nav-links');
	return entries.map((entry) => ({ params: { path: entry.data["url-path"] }, props: { entry } }));
}

interface Props {
	entry: CollectionEntry<'nav-links'>;
}

const { entry } = Astro.props;
---

<article>
</article>
`.replace('entry.data["url-path"]', "entry.data['url-path']"),
  );
});

test('Astro 4 keeps the entry API it has', () => {
  const text = pageTemplateText({ route, source: content, layout: undefined, collection: { ...facts, api: 'legacy' }, prerender: 'inherited' });
  assert.match(text, /import \{ getCollection \} from 'astro:content';/);
  assert.match(text, /params: \{ slug: entry\.slug \}/);
  assert.match(text, /const \{ Content \} = await entry\.render\(\);/);
});

test('a JSON page fetches, validates each item, and reads its header from the environment', () => {
  const source = {
    kind: 'http-json',
    url: "https://api.example.com/products?o'clock=1",
    headers: [
      { name: 'Authorization', env: 'API_TOKEN', scheme: 'bearer' },
      { name: 'X-Team', env: 'TEAM_KEY', scheme: 'plain' },
    ],
    listPath: 'data.items-list',
    slugPath: 'meta.handle',
    slugTreatment: 'exact',
    fields,
  };
  const text = pageTemplateText({ route, source, layout, collection: undefined, prerender: 'inherited' });
  assert.equal(
    text,
    `---
import Base from '../../layouts/Base.astro';

export async function getStaticPaths() {
	const url = 'https://api.example.com/products?o\\'clock=1';
	const secret0 = import.meta.env.API_TOKEN;
	if (!secret0) {
		throw new Error('Set API_TOKEN in .env to load this page.');
	}
	const secret1 = import.meta.env.TEAM_KEY;
	if (!secret1) {
		throw new Error('Set TEAM_KEY in .env to load this page.');
	}
	const response = await fetch(url, {
		headers: { 'Authorization': \`Bearer \${secret0}\`, 'X-Team': secret1 },
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) {
		throw new Error(\`\${url} answered \${response.status}.\`);
	}
	const body = await response.json();
	const list = body?.data?.['items-list'];
	if (!Array.isArray(list)) {
		throw new Error('Expected a list at data.items-list.');
	}
	const kinds = { title: 'string', price: 'number', tags: 'object', 'sale-price': 'number' };
	return list.map((item, index) => {
		const slug = item?.meta?.handle;
		if (typeof slug !== 'string' && typeof slug !== 'number') {
			throw new Error(\`Item \${index}: meta.handle is not text or a number.\`);
		}
		if (slug === '') {
			throw new Error(\`Item \${index}: meta.handle is empty.\`);
		}
		for (const [name, kind] of Object.entries(kinds)) {
			const value = name.split('.').reduce((part, step) => part?.[step], item);
			if (value !== undefined && value !== null && typeof value !== kind) {
				throw new Error(\`Item \${index}: \${name} is not a \${kind}.\`);
			}
		}
		const entry = { title: item.title, price: item.price, tags: item.tags, 'sale-price': item['sale-price'] };
		return { params: { slug: String(slug) }, props: { entry } };
	});
}

interface Props {
	entry: {
		title?: string;
		price?: number;
		tags?: unknown[];
		'sale-price'?: number;
	};
}

const { entry } = Astro.props;
---

<Base>
	<h1>{entry.title}</h1>
</Base>
`,
  );
});

test('nested fields keep their shape in the entry and in its type', () => {
  const source = {
    kind: 'http-json',
    url: 'https://api.example.com/items',
    headers: [],
    listPath: '',
    slugPath: 'slug.current',
    slugTreatment: 'exact',
    fields: [
      { path: 'title', kind: 'string' },
      { path: 'author.name', kind: 'string' },
      { path: 'author.links.web', kind: 'string' },
      { path: 'meta', kind: 'object' },
      { path: 'meta.views', kind: 'number' },
    ],
  };
  const text = pageTemplateText({ route, source, layout: undefined, collection: undefined, prerender: 'inherited' });
  assert.ok(text.includes("const kinds = { title: 'string', 'author.name': 'string', 'author.links.web': 'string', meta: 'object' };"), text);
  assert.ok(text.includes("const value = name.split('.').reduce((part, step) => part?.[step], item);"));
  assert.ok(text.includes('const slug = item?.slug?.current;'));
  assert.ok(
    text.includes('const entry = { title: item.title, author: { name: item?.author?.name, links: { web: item?.author?.links?.web } }, meta: item.meta };'),
    text,
  );
  assert.ok(
    text.includes(`interface Props {
	entry: {
		title?: string;
		author?: {
			name?: string;
			links?: {
				web?: string;
			};
		};
		meta?: Record<string, unknown>;
	};
}`),
    text,
  );
});

test('a JSON reply that is the list itself is read from the top', () => {
  const source = {
    kind: 'http-json',
    url: 'https://api.example.com/items',
    headers: [],
    listPath: '',
    slugPath: 'id',
    slugTreatment: 'exact',
    fields: fields.slice(1, 2),
  };
  const text = pageTemplateText({ route, source, layout: undefined, collection: undefined, prerender: 'inherited' });
  assert.match(
    text,
    /^---\nexport async function getStaticPaths\(\) \{\n\tconst url = 'https:\/\/api\.example\.com\/items';\n\tconst response = await fetch\(url, \{\n\t\tsignal:/,
  );
  assert.match(text, /const list = body;/);
  assert.match(text, /Expected a list at the top of the reply\./);
  assert.ok(!text.includes('<h1>'), 'no text field to head the page with');
});

test('a Sanity page asks over plain HTTP: the CDN when public, the API with a token', () => {
  const source = {
    kind: 'sanity',
    projectId: 'abc123',
    dataset: 'production',
    documentType: 'post',
    tokenEnv: undefined,
    slugPath: 'slug.current',
    slugTreatment: 'exact',
    fields: fields.slice(0, 1),
  };
  const text = pageTemplateText({ route, source, layout: undefined, collection: undefined, prerender: 'inherited' });
  assert.equal(
    text,
    `---
export async function getStaticPaths() {
	const query = new URLSearchParams({
		query: '*[_type == $type && defined(slug.current)]',
		$type: JSON.stringify('post'),
	});
	const url = \`https://abc123.apicdn.sanity.io/v2025-02-19/data/query/production?\${query}\`;
	const response = await fetch(url, {
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) {
		throw new Error(\`\${url} answered \${response.status}.\`);
	}
	const body = await response.json();
	const list = body?.result;
	if (!Array.isArray(list)) {
		throw new Error('Expected a list at result.');
	}
	const kinds = { title: 'string' };
	return list.map((item, index) => {
		const slug = item?.slug?.current;
		if (typeof slug !== 'string' && typeof slug !== 'number') {
			throw new Error(\`Item \${index}: slug.current is not text or a number.\`);
		}
		if (slug === '') {
			throw new Error(\`Item \${index}: slug.current is empty.\`);
		}
		for (const [name, kind] of Object.entries(kinds)) {
			const value = name.split('.').reduce((part, step) => part?.[step], item);
			if (value !== undefined && value !== null && typeof value !== kind) {
				throw new Error(\`Item \${index}: \${name} is not a \${kind}.\`);
			}
		}
		const entry = { title: item.title };
		return { params: { slug: String(slug) }, props: { entry } };
	});
}

interface Props {
	entry: {
		title?: string;
	};
}

const { entry } = Astro.props;
---

<article>
	<h1>{entry.title}</h1>
</article>
`,
  );
  const signed = pageTemplateText({
    route,
    source: { ...source, tokenEnv: 'SANITY_API_TOKEN' },
    layout: undefined,
    collection: undefined,
    prerender: 'inherited',
  });
  assert.match(signed, /https:\/\/abc123\.api\.sanity\.io\//);
  assert.match(signed, /const secret0 = import\.meta\.env\.SANITY_API_TOKEN;/);
  assert.match(signed, /headers: \{ Authorization: `Bearer \$\{secret0\}` \}/);
});

test('generated values cannot break out of the page', () => {
  const source = {
    kind: 'http-json',
    url: "https://a.example/x'+y\\",
    headers: [],
    listPath: '',
    slugPath: 'id',
    slugTreatment: 'exact',
    fields: fields.slice(0, 1),
  };
  const text = pageTemplateText({ route, source, layout: undefined, collection: undefined, prerender: 'inherited' });
  assert.ok(text.includes("const url = 'https://a.example/x\\'+y\\\\';"));
  assert.throws(
    () => pageTemplateText({ route, source: content, layout: undefined, collection: undefined, prerender: 'inherited' }),
    /planned with its collection/,
  );
  assert.equal(headingField(['body', 'name', 'title']), 'title');
  assert.equal(headingField(['body']), undefined);
});

async function fakeServer(context, answer) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    answer(request, response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { requests, base: `http://127.0.0.1:${server.address().port}` };
}

const json = (response, body, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

test('a sample finds every list in the reply and the fields of its items', async (context) => {
  const items = [
    { id: 7, title: 'One', slug: { current: 'one' }, tags: ['a'], skipped: undefined },
    { id: 8, extra: true },
  ];
  const { base, requests } = await fakeServer(context, (_request, response) => json(response, { meta: { total: 2 }, data: { items, labels: ['a', 'b'] } }));
  const sample = await sampleData(
    {
      kind: 'http-json',
      url: `${base}/items`,
      headers: [
        { name: 'Authorization', env: 'API_TOKEN', scheme: 'bearer' },
        { name: 'X-Key', env: 'KEY', scheme: 'plain' },
      ],
    },
    {
      fetch,
      env: new Map([
        ['API_TOKEN', 'abc'],
        ['KEY', 'def'],
      ]),
    },
  );
  assert.equal(requests[0].headers.authorization, 'Bearer abc');
  assert.equal(requests[0].headers['x-key'], 'def');
  assert.deepEqual(sample, {
    kind: 'lists',
    lists: [
      {
        path: 'data.items',
        count: 2,
        fields: [
          { path: 'id', kind: 'number', example: '7', examples: ['7', '8'], address: { kind: 'exact' } },
          {
            path: 'title',
            kind: 'string',
            example: 'One',
            examples: ['One', ''],
            address: { kind: 'unusable', reason: 'Some entries have no value', reasonRef: { key: 'pages.template.address.noValue' } },
          },
          { path: 'slug', kind: 'object', example: 'object', examples: ['object', ''] },
          { path: 'tags', kind: 'list', example: '1 items', examples: ['1 items', ''] },
          {
            path: 'slug.current',
            kind: 'string',
            example: 'one',
            examples: ['one', ''],
            address: { kind: 'unusable', reason: 'Some entries have no value', reasonRef: { key: 'pages.template.address.noValue' } },
          },
          { path: 'extra', kind: 'boolean', example: 'true', examples: ['', 'true'] },
        ],
      },
    ],
  });
});

test('a collection is sampled from its entries, each field judged as an address', async () => {
  const items = [
    { Number: '25%', Heading: 'Uptime', Description: 'x'.repeat(200), featured: true },
    { Number: '99%', Heading: 'Uptime', Description: 'short', featured: false },
  ];
  const sample = await sampleData({ kind: 'content-collection', collection: 'stats' }, { fetch, env: new Map(), readCollection: async () => items });
  const fits = Object.fromEntries(sample.lists[0].fields.map((field) => [field.path, field.address]));
  assert.deepEqual(fits, {
    Number: { kind: 'slugified', example: '25' },
    Heading: {
      kind: 'unusable',
      reason: 'Two entries would share the address uptime',
      reasonRef: { key: 'pages.template.address.repeated', params: { address: 'uptime' } },
    },
    Description: { kind: 'unusable', reason: 'Too long for a page address', reasonRef: { key: 'pages.template.address.tooLong' } },
    featured: undefined,
  });
});

const SLUG_HELPER = `	const toSlug = (value: unknown) =>
		String(value ?? '')
			.normalize('NFKD')
			.replace(/[\\u0300-\\u036f]/g, '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '');
	const seen = new Map();
`;

test('a slugified content field makes safe, unique addresses in one small helper', () => {
  const source = { ...content, collection: 'stats', slug: { kind: 'field', name: 'Number', treatment: 'slugified' } };
  const collection = { ...facts, body: 'none', heading: undefined };
  const text = pageTemplateText({ route: { file: 'stats/[slug].astro', param: 'slug' }, source, layout: undefined, collection, prerender: 'inherited' });
  assert.ok(
    text.includes(`export async function getStaticPaths() {
${SLUG_HELPER}	const entries = await getCollection('stats');
	return entries.map((entry) => {
		const slug = toSlug(entry.data.Number);
		if (slug === '') {
			throw new Error(\`\${entry.id}: Number has no letters or numbers for its page address.\`);
		}
		if (seen.has(slug)) {
			throw new Error(\`\${seen.get(slug)} and \${entry.id} would both be at \${slug}. Change Number on one of them.\`);
		}
		seen.set(slug, entry.id);
		return { params: { slug: slug }, props: { entry } };
	});
}
`),
    text,
  );
  const entryId = pageTemplateText({ route, source: content, layout: undefined, collection: facts, prerender: 'inherited' });
  assert.ok(!entryId.includes('toSlug'), 'an entry id needs no slugify step');
});

const SLUGGED_ITEM = `	return list.map((item, index) => {
		const address = item?.Number;
		if (typeof address !== 'string' && typeof address !== 'number') {
			throw new Error(\`Item \${index}: Number is not text or a number.\`);
		}
		const slug = toSlug(address);
		if (slug === '') {
			throw new Error(\`Item \${index}: Number has no letters or numbers for its page address.\`);
		}
		if (seen.has(slug)) {
			throw new Error(\`Items \${seen.get(slug)} and \${index} would both be at \${slug}. Change Number on one of them.\`);
		}
		seen.set(slug, index);
`;

test('a slugified external field checks every item at build, for JSON and for Sanity', () => {
  const shared = { slugPath: 'Number', slugTreatment: 'slugified', fields: fields.slice(0, 1) };
  for (const source of [
    { kind: 'http-json', url: 'https://api.example.com/items', headers: [], listPath: '', ...shared },
    { kind: 'sanity', projectId: 'abc123', dataset: 'production', documentType: 'stat', tokenEnv: undefined, ...shared },
  ]) {
    const text = pageTemplateText({ route, source, layout: undefined, collection: undefined, prerender: 'inherited' });
    assert.ok(text.startsWith(`---\nexport async function getStaticPaths() {\n${SLUG_HELPER}`), source.kind);
    assert.ok(text.includes(SLUGGED_ITEM), source.kind);
    assert.ok(text.includes('return { params: { slug: slug }, props: { entry } };'), source.kind);
  }
});

test('the generated helper makes the address the form showed', () => {
  const { slugifyAddress } = require('#dist/shared/properties/pageTemplate.js');
  const source = { ...content, slug: { kind: 'field', name: 'Number', treatment: 'slugified' } };
  const text = pageTemplateText({ route, source, layout: undefined, collection: facts, prerender: 'inherited' });
  const helper = /const toSlug = \(value: unknown\) =>([\s\S]*?);\n\tconst seen/.exec(text)[1];
  const toSlug = vm.runInNewContext(`(value) => ${helper}`);
  for (const value of ['25%', 'Uptime (copy)', '  Déjà  Vu! ', '%%%', 'plain', 3.5]) {
    assert.equal(toSlug(value), slugifyAddress(String(value)), String(value));
  }
  assert.equal(toSlug(undefined), '');
});

test('samples stay inside their bounds however large the reply is', () => {
  assert.deepEqual(
    listsIn([{ a: 1 }]).map((list) => list.path),
    [''],
  );
  assert.deepEqual(
    listsIn({ a: { b: { c: { d: [{ e: 1 }] } } } }).map((list) => list.path),
    ['a.b.c.d'],
  );
  assert.deepEqual(listsIn({ a: { b: { c: { d: { e: [{ f: 1 }] } } } } }), [], 'past the depth bound');
  assert.deepEqual(listsIn({ ok: ['x', 1] }), [], 'a list of scalars has no fields');
  const wide = Object.fromEntries(Array.from({ length: 200 }, (_item, index) => [`field${index}`, 1]));
  assert.equal(fieldsOf([wide]).length, 64);
  assert.equal(fieldsOf([{ long: 'x'.repeat(500) }])[0].example.length, 80);
  assert.equal(fieldsOf([{ 'not a name': 1, ok: 2 }]).length, 1);
  const longName = 'n'.repeat(100);
  assert.deepEqual(
    fieldsOf([{ [longName]: { [longName]: 1 } }]).map((field) => field.path),
    [longName],
    'a path past the bound is not offered',
  );
  assert.deepEqual(
    fieldsOf([{ a: 'one' }, { a: 'two' }, {}, { a: 'four' }])[0].examples,
    ['one', 'two', '', 'four'],
    'each item’s value can be stepped through',
  );
  assert.equal(fieldsOf(Array.from({ length: 30 }, (_item, index) => ({ a: index })))[0].examples.length, 10);
  const late = [...Array.from({ length: DATA_SAMPLE_FETCH.itemsReadMax }, () => ({ a: 1 })), { b: 2 }];
  assert.deepEqual(
    fieldsOf(late).map((field) => field.path),
    ['a'],
    'only the first items are read',
  );
});

test('a failed sample says why in plain words, and sends no redirect a secret', async (context) => {
  const big = Buffer.alloc(1024 * 1024, 32);
  const { base, requests } = await fakeServer(context, (request, response) => {
    switch (request.url) {
      case '/moved':
        response.writeHead(302, { location: 'https://elsewhere.example/data' });
        return response.end();
      case '/html':
        response.writeHead(200, { 'content-type': 'text/html' });
        return response.end('<html></html>');
      case '/none':
        return json(response, { ok: true });
      case '/refused':
        return json(response, {}, 401);
      case '/missing':
        return json(response, {}, 404);
      case '/broken':
        return json(response, { message: 'Dataset not found' }, 500);
      case '/huge': {
        response.writeHead(200);
        // Writes that outrun the socket are buffered, which is all a reply this size needs.
        for (let written = 0; written < 10; written += 1) {
          response.write(big);
        }
        return response.end();
      }
      default:
        return json(response, []);
    }
  });
  const sample = (url) => sampleData({ kind: 'http-json', url: `${base}${url}`, headers: [] }, { fetch, env: new Map() });
  await assert.rejects(sample('/moved'), /redirects to https:\/\/elsewhere\.example\/data\. Use that address instead/);
  await assert.rejects(sample('/html'), /didn’t return data Stacki can read/);
  await assert.rejects(sample('/none'), /didn’t return a list\. Check it’s the right link/);
  await assert.rejects(sample('/refused'), /refused the request \(401\)/);
  await assert.rejects(sample('/missing'), /Nothing was found at that address \(404\)/);
  await assert.rejects(sample('/broken'), /answered 500: Dataset not found/);
  await assert.rejects(sample('/huge'), /larger than 8 MB/);
  assert.equal(requests.filter((request) => request.url === '/moved').length, 1);
  await assert.rejects(
    sampleData({ kind: 'http-json', url: `${base}/x`, headers: [{ name: 'X-Key', env: 'KEY', scheme: 'plain' }] }, { fetch, env: new Map() }),
    /Set KEY in \.env first/,
  );
  const timedOut = async () => {
    throw Object.assign(new Error('late'), { name: 'TimeoutError' });
  };
  await assert.rejects(
    sampleData({ kind: 'http-json', url: `${base}/x`, headers: [] }, { fetch: timedOut, env: new Map() }),
    /did not answer within 15 seconds/,
  );
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(sampleData({ kind: 'http-json', url: `${base}/x`, headers: [] }, { fetch: offline, env: new Map() }), /Could not reach that address/);
});

test('Sanity samples read through a connection’s key, and learn if the dataset is public, against a fake API', async (context) => {
  let open = false;
  const { base, requests } = await fakeServer(context, (request, response) => {
    if (request.headers.authorization === undefined && !open) {
      return json(response, { result: [] });
    }
    const query = new URL(request.url, 'http://fake').searchParams.get('query');
    if (query === 'array::unique(*[]._type)') {
      return json(response, { result: ['sanity.imageAsset', 'post', 'system.group', 'author', 'bad name'] });
    }
    return json(response, { result: [{ _id: 'p1', title: 'Post', slug: { _type: 'slug', current: 'post' } }] });
  });
  const seen = [];
  const rewrite = (url, init) => {
    seen.push(url);
    const parsed = new URL(url);
    return fetch(`${base}${parsed.pathname}${parsed.search}`, init);
  };
  const host = { fetch: rewrite, env: new Map(), sanityConnection: () => ({ projectId: 'abc123', dataset: 'production', token: 'sk' }) };
  const id = '00000000-0000-4000-8000-000000000000';
  assert.deepEqual(await sampleData({ kind: 'sanity-types', connectionId: id }, host), { kind: 'types', types: ['author', 'post'], access: 'private' });
  assert.match(seen[0], /^https:\/\/abc123\.api\.sanity\.io\/v2025-02-19\/data\/query\/production\?query=/);
  assert.equal(requests[0].headers.authorization, 'Bearer sk');
  assert.match(seen[1], /^https:\/\/abc123\.apicdn\.sanity\.io\//);
  assert.equal(requests[1].headers.authorization, undefined, 'the access check asks as an anonymous site would');
  open = true;
  assert.equal((await sampleData({ kind: 'sanity-types', connectionId: id }, host)).access, 'public');
  const sample = await sampleData({ kind: 'sanity-documents', connectionId: id, documentType: 'post' }, host);
  assert.equal(new URL(seen.at(-1)).searchParams.get('$type'), '"post"');
  assert.equal(requests.at(-1).headers.authorization, 'Bearer sk');
  assert.deepEqual(
    sample.lists[0].fields.map((field) => field.path),
    ['_id', 'title', 'slug', 'slug._type', 'slug.current'],
  );
  const gone = {
    ...host,
    sanityConnection: () => {
      throw new Error('That Sanity connection is no longer there.');
    },
  };
  await assert.rejects(sampleData({ kind: 'sanity-types', connectionId: id }, gone), /no longer there/);
});

test('env text is read and changed one line at a time', () => {
  assert.deepEqual(envEntries('# note\nA=1\nexport B="two words"\nC=\'lit\\n\'\nD=x # trailing\nnot a line\n'), [
    ['A', '1'],
    ['B', 'two words'],
    ['C', 'lit\\n'],
    ['D', 'x'],
  ]);
  assert.equal(withEnvValue('', 'A', 'b'), 'A=b\n');
  assert.equal(withEnvValue('X=1', 'A', 'b c'), 'X=1\nA="b c"\n');
  assert.equal(withEnvValue('X=1\nA=old\nY=2\n', 'A', 'new'), 'X=1\nA=new\nY=2\n');
  assert.equal(withEnvValue('', 'A', 'q"\\'), 'A="q\\"\\\\"\n');
  assert.equal(envEntries(withEnvValue('', 'A', 'q"\\ #x'))[0][1], 'q"\\ #x', 'a value reads back as written');
  assert.throws(() => withEnvValue('', 'A', 'two\nlines'), /one line/);
  assert.equal(gitignoreWithEnv('.env\n'), undefined);
  assert.equal(gitignoreWithEnv('dist\n.env*\n'), undefined);
  assert.equal(gitignoreWithEnv('dist'), 'dist\n.env\n');
  assert.equal(gitignoreWithEnv(undefined), '.env\n');
});

const gitRun = (root, args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const git = async (root, args) => {
  try {
    return { stdout: gitRun(root, args).toString() };
  } catch (error) {
    throw Object.assign(new Error('git failed'), { code: error.status });
  }
};
function repository(context) {
  const root = temporary(context, 'env-repo');
  gitRun(root, ['init', '--quiet']);
  gitRun(root, ['config', 'user.email', 'test@example.com']);
  gitRun(root, ['config', 'user.name', 'Test']);
  return root;
}

test('a secret lands in an ignored .env and in no tracked file', async (context) => {
  const root = repository(context);
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist\n');
  fs.writeFileSync(path.join(root, 'page.astro'), 'keep\n');
  gitRun(root, ['add', '.']);
  gitRun(root, ['commit', '--quiet', '-m', 'start']);
  const secret = 'sk-very-secret-value';
  assert.equal(await writeProjectSecret(root, { name: 'API_TOKEN', value: secret }, git), 'added');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), 'dist\n.env\n', 'only the rule is added');
  assert.equal(readProjectEnv(root).get('API_TOKEN'), secret);
  assert.equal(await writeProjectSecret(root, { name: 'OTHER', value: 'two' }, git), 'already-ignored');
  gitRun(root, ['add', '.']);
  const staged = gitRun(root, ['diff', '--cached', '--name-only']).toString().trim();
  assert.equal(staged, '.gitignore', '.env stays out of Git');
  assert.throws(() => gitRun(root, ['grep', '--cached', '--quiet', secret]), 'no tracked file holds the secret');
});

test('a secret is refused when .env is tracked or a rule brings it back', async (context) => {
  const tracked = repository(context);
  fs.writeFileSync(path.join(tracked, '.env'), 'A=1\n');
  gitRun(tracked, ['add', '.env']);
  await assert.rejects(writeProjectSecret(tracked, { name: 'TOKEN', value: 'x' }, git), /tracked by Git/);
  assert.equal(fs.readFileSync(path.join(tracked, '.env'), 'utf8'), 'A=1\n');
  const negated = repository(context);
  fs.writeFileSync(path.join(negated, '.gitignore'), '.env\n!.env\n');
  await assert.rejects(writeProjectSecret(negated, { name: 'TOKEN', value: 'x' }, git), /does not ignore \.env/);
  assert.equal(fs.existsSync(path.join(negated, '.env')), false);
  const plain = temporary(context, 'env-plain');
  assert.equal(await writeProjectSecret(plain, { name: 'TOKEN', value: 'x' }, git), 'added', 'a folder outside Git still gets the rule');
});

function project(context) {
  const root = temporary(context, 'template-project');
  fs.mkdirSync(path.join(root, 'src/pages/blog'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/layouts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/layouts/Base.astro'), '<html><slot /></html>\n');
  return root;
}
const hostFor = (projectPath, collections, env = new Map()) => ({ projectPath, env, readConfig: async () => ({ collections }) });
const BLOG = { name: 'blog', hasBody: true, schema: { type: 'object', properties: { title: { type: 'string' }, path: { type: 'string' } } } };

test('a template on an existing collection writes one new file, and reads back as a template that binds', async (context) => {
  const root = project(context);
  const config = "import { defineCollection } from 'astro:content';\nexport const collections = { blog: defineCollection({}) };\n";
  fs.writeFileSync(path.join(root, 'src/content.config.ts'), config);
  const draft = { route: '/blog/[slug]', layout: { name: 'Base', path: path.join(root, 'src/layouts/Base.astro') }, source: content };
  const host = hostFor(root, [BLOG]);
  const plan = await planPageTemplate(draft, host);
  assert.deepEqual(
    plan.changes.map((change) => [change.path, change.action]),
    [['src/pages/blog/[slug].astro', 'create']],
  );
  assert.equal(fs.existsSync(path.join(root, 'src/pages/blog/[slug].astro')), false, 'planning writes nothing');
  const { pagePath } = await applyPageTemplate(draft, host);
  const written = fs.readFileSync(pagePath, 'utf8');
  assert.equal(written, plan.changes[0].text, 'what was shown is what was written');
  assert.equal(fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8'), config, 'an existing config is untouched');

  const read = parsePageSource(pagePath, written);
  assert.equal(read.editable, true, 'the page opens in the editor');
  const { isCollectionRoute } = load('src/features/pages/pageOrder.ts');
  const { pageDisplayName } = load('src/lib/pageName.ts');
  assert.equal(isCollectionRoute('blog/[slug].astro'), true);
  assert.equal(pageDisplayName({ name: 'blog/[slug].astro' }), 'Blog Template');

  const { dataTree } = load('src/editor/dataSuggest.ts');
  const propsSample = { entry: { id: 'first', collection: 'blog', data: { title: 'First' } } };
  const tree = dataTree({ frontmatter: read.model.extraFrontmatter, imports: read.model.imports, propsSample });
  const entry = tree.find((node) => node.path === 'entry');
  assert.ok(entry, 'the sample entry is in the picker');
  const data = entry.children.find((node) => node.path === 'entry.data');
  assert.deepEqual(
    data.children.map((node) => node.path),
    ['entry.data.title'],
    'its fields bind as entry.data.*',
  );
  assert.equal(
    tree.some((node) => node.path === 'entries'),
    false,
    'getStaticPaths’ locals are not in scope',
  );
  await assert.rejects(planPageTemplate(draft, host), /already exists at src\/pages\/blog\/\[slug\]\.astro/);
});

test('a new collection is planned in full and written beside its page', async (context) => {
  const root = project(context);
  const config = "import { defineCollection } from 'astro:content';\n\nexport const collections = {};\n";
  fs.writeFileSync(path.join(root, 'src/content.config.ts'), config);
  const source = { kind: 'content-collection', collection: 'teamMembers', origin: 'new', slug: { kind: 'entry-id' } };
  const draft = { route: '/team/[slug]', layout: undefined, source };
  const host = hostFor(root, []);
  const plan = await planPageTemplate(draft, host);
  assert.deepEqual(
    plan.changes.map((change) => [change.path, change.action]),
    [
      ['src/pages/team/[slug].astro', 'create'],
      ['src/content.config.ts', 'edit'],
      ['src/content/team-members/first-entry.md', 'create'],
    ],
  );
  assert.equal(fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8'), config, 'planning leaves the config alone');
  await applyPageTemplate(draft, host);
  const after = fs.readFileSync(path.join(root, 'src/content.config.ts'), 'utf8');
  assert.equal(after, plan.changes[1].text);
  assert.ok(after.includes("import { defineCollection } from 'astro:content';"), 'what was there stays');
  assert.match(after, /export const collections = \{ teamMembers \}/);
  assert.match(fs.readFileSync(path.join(root, 'src/content/team-members/first-entry.md'), 'utf8'), /^---\ntitle: First entry\n---/);
  assert.match(fs.readFileSync(path.join(root, 'src/pages/team/[slug].astro'), 'utf8'), /<h1>\{entry\.data\.title\}<\/h1>\n\t<Content \/>/);
});

test('a project without a content config gets one, and a config it cannot patch stops everything', async (context) => {
  const root = project(context);
  const source = { kind: 'content-collection', collection: 'notes', origin: 'new', slug: { kind: 'entry-id' } };
  const draft = { route: '/notes/[slug]', layout: undefined, source };
  const plan = await planPageTemplate(draft, hostFor(root, []));
  assert.deepEqual(plan.changes[1].action, 'create');
  await applyPageTemplate(draft, hostFor(root, []));
  assert.ok(fs.existsSync(path.join(root, 'src/content.config.ts')));
  assert.ok(fs.existsSync(path.join(root, 'src/content/notes/first-entry.md')));
  const stuck = project(context);
  fs.writeFileSync(path.join(stuck, 'src/content.config.ts'), 'export default {};\n');
  await assert.rejects(applyPageTemplate(draft, hostFor(stuck, [])), /could not find/);
  assert.equal(fs.existsSync(path.join(stuck, 'src/pages/notes')), false, 'no page names a collection that was not added');
  assert.equal(fs.existsSync(path.join(stuck, 'src/content/notes')), false);
});

test('a plan refuses what the project would not allow, and reports variables by state only', async (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'src/pages/blog/[id].astro'), '---\n---\n');
  const page = (source, routeText = '/blog/[slug]') =>
    planPageTemplate({ route: routeText, layout: undefined, source }, hostFor(root, [BLOG], new Map([['SET', 'value-1']])));
  await assert.rejects(page(content), /\[id\]\.astro in that folder already generates these URLs/);
  await assert.rejects(page({ ...content, collection: 'nope' }, '/other/[slug]'), /no collection named “nope”/);
  await assert.rejects(page({ ...content, origin: 'new' }, '/other/[slug]'), /named “blog” already exists/);
  await assert.rejects(page({ ...content, slug: { kind: 'field', name: 'nope' } }, '/other/[slug]'), /no field named “nope”/);
  await assert.rejects(
    planPageTemplate(
      { route: '/x/[slug]', layout: undefined, source: content },
      { ...hostFor(root, []), readConfig: async () => ({ collections: [], error: 'The config failed.' }) },
    ),
    /The config failed/,
  );
  const source = {
    kind: 'http-json',
    url: 'https://api.example.com/items',
    headers: [
      { name: 'A', env: 'SET', scheme: 'plain' },
      { name: 'B', env: 'UNSET', scheme: 'plain' },
    ],
    listPath: '',
    slugPath: 'id',
    slugTreatment: 'exact',
    fields: fields.slice(0, 1),
  };
  const plan = await page(source, '/items/[slug]');
  assert.deepEqual(plan.env, [
    { name: 'SET', state: 'set' },
    { name: 'UNSET', state: 'missing' },
  ]);
  assert.ok(!JSON.stringify(plan).includes('value-1'), 'a plan never carries a value');
});

test('a server-output project asks Astro to run the paths at build time', async (context) => {
  const root = project(context);
  fs.writeFileSync(path.join(root, 'astro.config.mjs'), "export default { output: 'server' };\n");
  const plan = await planPageTemplate({ route: '/posts/[slug]', layout: undefined, source: content }, hostFor(root, [BLOG]));
  assert.match(plan.changes[0].text, /export const prerender = true;/);
});

test('the installed Astro decides the entry API', async (context) => {
  const root = project(context);
  fs.mkdirSync(path.join(root, 'node_modules/astro'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/astro/package.json'), JSON.stringify({ version: '4.16.0' }));
  const plan = await planPageTemplate({ route: '/posts/[slug]', layout: undefined, source: content }, hostFor(root, [BLOG]));
  assert.match(plan.changes[0].text, /await entry\.render\(\)/);
});
