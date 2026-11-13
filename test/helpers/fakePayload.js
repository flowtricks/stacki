// A fake Payload server for tests: a small in-memory model that answers the way a real Payload 3.93
// answered when its replies were recorded (test/fixtures/cms/payload/, docs/cms-testing.md).
// It reproduces the behaviours that made mocks lie before:
//   * `/me` is HTTP 200 with {"user":null} for a key it does not accept;
//   * a PATCH on a collection with drafts WITHOUT `draft=true` publishes; with it, the live document
//     is untouched and a draft version is added; a collection without drafts changes live either way;
//   * a list is paged (`limit`, `page`, `totalDocs`, `hasNextPage`) and `limit=0` returns everything;
//   * five wrong passwords lock an account (HTTP 401, message "This user is locked ...");
//   * a JWT expires (`exp`), after which a request is a 401 and `/me` is `{"user":null}`.
// `calls` records every request so a test can assert on exactly what Stacki sent.
const http = require('node:http');
const fs = require('node:fs');
const { repoPath } = require('./sources.js');

// eslint-disable-next-line stacki/no-null -- Payload's JSON says `null` where a value is absent; the fake says it the same way.
const NONE = null;
const fixture = (name) => JSON.parse(fs.readFileSync(repoPath(`test/fixtures/cms/payload/${name}.json`), 'utf8'));

const EMAIL = 'admin@example.test';
const PASSWORD = 'correct-password';
const API_KEY = 'good-key-1234';

function fakePayload(options = {}) {
  const config = { postCount: 3, tokenSeconds: 3600, graphql: true, ...options };
  const calls = [];
  const state = { keyEnabled: true, failedLogins: 0, now: () => Date.now(), tokens: new Map(), nextId: 1000, logins: 0 };
  const template = fixture('posts-page').docs[0];
  const posts = new Map();
  const versions = [];
  const makePost = (id, over = {}) => ({
    ...template,
    id,
    title: `Post ${id}`,
    body: lexicalOf(`Body of post ${id}`),
    slug: `post-${id}`,
    views: id,
    where: [10.5, 20.5],
    _status: 'published',
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    ...over,
  });
  for (let id = 1; id <= config.postCount; id += 1) {
    posts.set(id, makePost(id, id % 5 === 0 ? { _status: 'draft' } : {}));
    versions.push({ id: 100 + id, parent: id, version: { ...posts.get(id) }, latest: true, updatedAt: posts.get(id).updatedAt });
  }
  const pages = new Map([
    [1, { id: 1, name: 'Home', slug: 'home', blurb: 'Hello', layout: [], updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }],
  ]);
  const media = new Map();

  const authOf = (request) => {
    const header = request.headers.authorization ?? '';
    if (header === `users API-Key ${API_KEY}`) {
      if (!state.keyEnabled) {
        return undefined;
      }
      return 'key';
    }
    const jwt = /^JWT (.+)$/.exec(header)?.[1];
    const record = jwt === undefined ? undefined : state.tokens.get(jwt);
    return record !== undefined && record.exp * 1000 > state.now() ? 'jwt' : undefined;
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    const body = await readBody(request);
    const entry = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization,
      body: tryJson(body),
    };
    calls.push(entry);
    const json = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (config.route?.(request, response, entry) === true) {
      return;
    }
    const auth = authOf(request);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'api') {
      json(404, { message: `Route not found "${url.pathname}"` });
      return;
    }
    const [, resource, second, third] = segments;
    if (resource === 'users' && second === 'login' && request.method === 'POST') {
      state.logins += 1;
      const parsed = entry.body ?? {};
      if (state.failedLogins >= 5) {
        json(401, fixture('login-locked').body);
        return;
      }
      if (parsed.email === EMAIL && parsed.password === PASSWORD) {
        const token = `token-${state.tokens.size + 1}`;
        const exp = Math.floor(state.now() / 1000) + config.tokenSeconds;
        state.tokens.set(token, { exp });
        json(200, { ...fixture('login-ok'), token, exp });
        return;
      }
      state.failedLogins += 1;
      json(401, fixture('login-wrong').body);
      return;
    }
    if (resource === 'users' && second === 'me') {
      json(200, auth === undefined ? fixture('me-null') : fixture('me-ok'));
      return;
    }
    if (resource === 'graphql') {
      if (config.graphql) {
        json(200, fixture('graphql-introspection'));
      } else {
        json(400, { errors: [{ message: 'GraphQL is disabled.' }] });
      }
      return;
    }
    if (!['users', 'posts', 'pages', 'media', 'categories', 'access', 'graphql'].includes(resource)) {
      json(404, { message: `Route not found "${url.pathname}"` });
      return;
    }
    if (auth === undefined && resource !== 'posts' && resource !== 'pages' && resource !== 'access') {
      json(403, { errors: [{ message: 'You are not allowed to perform this action.' }] });
      return;
    }
    if (resource === 'access') {
      json(200, fixture('access'));
      return;
    }
    if (resource === 'posts') {
      posts_route({ request, url, entry, second, third, json, auth, body });
      return;
    }
    if (resource === 'pages') {
      pages_route({ request, url, entry, second, json, auth });
      return;
    }
    if (resource === 'media' && request.method === 'POST') {
      media_upload({ entry, body, json });
      return;
    }
    if (resource === 'users' || resource === 'categories' || resource === 'media') {
      json(200, {
        docs: [],
        totalDocs: 0,
        limit: 10,
        page: 1,
        totalPages: 1,
        hasNextPage: false,
        hasPrevPage: false,
        nextPage: NONE,
        prevPage: NONE,
        pagingCounter: 1,
      });
      return;
    }
    json(404, { message: `Route not found "${url.pathname}"` });
  });

  function paged(list, url) {
    const limitParameter = url.searchParams.get('limit');
    const limit = limitParameter === null ? 10 : Number(limitParameter);
    const page = Number(url.searchParams.get('page') ?? '1');
    const everything = limit === 0;
    const size = everything ? list.length : limit;
    const totalPages = everything ? 1 : Math.max(1, Math.ceil(list.length / size));
    const docs = everything ? list : list.slice((page - 1) * size, page * size);
    return {
      docs,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      limit: everything ? list.length : limit,
      nextPage: page < totalPages ? page + 1 : NONE,
      page,
      pagingCounter: (page - 1) * size + 1,
      prevPage: page > 1 ? page - 1 : NONE,
      totalDocs: list.length,
      totalPages,
    };
  }

  function posts_route({ request, url, entry, second, third, json, auth, body }) {
    // A request nobody is signed in for (an expired token, a key switched off) is an anonymous visitor to Payload:
    // it may read published posts and nothing else, and says nothing about having been demoted.
    if (auth === undefined && request.method !== 'GET') {
      json(403, { errors: [{ message: 'You are not allowed to perform this action.' }] });
      return;
    }
    const wantsDraft = url.searchParams.get('draft') === 'true';
    const latestOf = (id) => versions.filter((version) => version.parent === id).sort((left, right) => right.id - left.id)[0];
    if (second === 'versions') {
      if (request.method === 'POST' && third !== undefined) {
        const version = versions.find((candidate) => candidate.id === Number(third));
        if (version === undefined) {
          json(404, fixture('not-found').body);
          return;
        }
        const restored = { ...version.version, updatedAt: new Date(state.now()).toISOString() };
        if (!wantsDraft) {
          posts.set(version.parent, { ...restored, _status: 'published' });
        }
        versions.push({
          id: ++state.nextId,
          parent: version.parent,
          version: wantsDraft ? { ...restored, _status: 'draft' } : { ...restored, _status: 'published' },
          latest: true,
          updatedAt: restored.updatedAt,
        });
        json(200, { ...restored, message: 'Restored successfully.' });
        return;
      }
      const parent = url.searchParams.get('where[parent][equals]');
      const published = url.searchParams.get('where[version._status][equals]');
      let list = versions
        .filter((version) => parent === null || version.parent === Number(parent))
        .filter((version) => published === null || version.version._status === published);
      list = list.sort((left, right) => right.id - left.id);
      json(200, paged(list, url));
      return;
    }
    if (second === undefined && request.method === 'GET') {
      let list = [...posts.values()];
      if (auth === undefined) {
        list = list.filter((post) => post._status === 'published');
      } else if (wantsDraft) {
        list = list.map((post) => latestOf(post.id)?.version ?? post);
      }
      const ids = url.searchParams.get('where[id][in]');
      if (ids !== null) {
        const wanted = new Set(ids.split(',').map(Number));
        list = list.filter((post) => wanted.has(post.id));
      }
      list.sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1));
      const result = paged(list, url);
      result.docs = result.docs.map((post) => localeAll(post, url));
      if (url.searchParams.get('select[_status]') === 'true') {
        result.docs = result.docs.map((post) => ({ id: post.id, _status: post._status }));
      }
      json(200, result);
      return;
    }
    if (second === undefined && request.method === 'POST') {
      const id = ++state.nextId;
      const document = makePost(id, {
        ...entry.body,
        title: entry.body?.title,
        slug: NONE,
        _status: entry.body?._status ?? 'published',
        updatedAt: new Date(state.now()).toISOString(),
      });
      posts.set(id, document);
      versions.push({ id: ++state.nextId, parent: id, version: { ...document }, latest: true, updatedAt: document.updatedAt });
      json(201, { doc: document, message: 'Post successfully created.' });
      return;
    }
    const id = Number(second);
    const live = posts.get(id);
    if (live === undefined) {
      json(404, fixture('not-found').body);
      return;
    }
    if (request.method === 'GET') {
      const shown = wantsDraft && auth !== undefined ? (latestOf(id)?.version ?? live) : live;
      json(200, localeAll(shown, url));
      return;
    }
    if (request.method === 'DELETE') {
      posts.delete(id);
      json(200, { doc: live, message: 'Deleted successfully.' });
      return;
    }
    if (request.method === 'PATCH') {
      const patch = entry.body ?? {};
      const base = wantsDraft ? (latestOf(id)?.version ?? live) : (latestOf(id)?.version ?? live);
      const now = new Date(state.now()).toISOString();
      if (wantsDraft) {
        const next = { ...base, ...patch, _status: 'draft', updatedAt: now };
        versions.push({ id: ++state.nextId, parent: id, version: next, latest: true, updatedAt: now });
        json(200, { doc: next, message: 'Draft saved successfully.' });
        return;
      }
      // Without draft=true Payload applies the change to the live document and, with `_status`, sets it.
      const status = patch._status ?? live._status;
      const next = { ...base, ...patch, _status: status, updatedAt: now };
      posts.set(id, { ...next, _status: status });
      versions.push({ id: ++state.nextId, parent: id, version: { ...next }, latest: true, updatedAt: now });
      json(200, { doc: next, message: 'Updated successfully.' });
      return;
    }
    json(405, { message: 'Method not allowed' });
  }

  // Only the fields the tests care about change under `?locale=all`.
  function localeAll(post, url) {
    if (url.searchParams.get('locale') !== 'all') {
      return post;
    }
    return { ...post, title: { en: post.title }, tagline: { en: post.tagline } };
  }

  function pages_route({ request, url, entry, second, json, auth }) {
    if (auth === undefined && request.method !== 'GET') {
      json(403, { errors: [{ message: 'You are not allowed to perform this action.' }] });
      return;
    }
    if (second === undefined && request.method === 'GET') {
      json(200, paged([...pages.values()], url));
      return;
    }
    const id = Number(second);
    const page = pages.get(id);
    if (page === undefined) {
      json(404, fixture('not-found').body);
      return;
    }
    if (request.method === 'GET') {
      json(200, page);
      return;
    }
    if (request.method === 'PATCH') {
      // No drafts here: `draft=true` is ignored, and the live page changes.
      const next = { ...page, ...(entry.body ?? {}) };
      if (next.name === null || next.name === undefined) {
        json(400, {
          errors: [
            {
              name: 'ValidationError',
              data: { collection: 'pages', errors: [{ label: 'Name', message: 'This field is required.', path: 'name' }] },
              message: 'The following field is invalid: Name',
            },
          ],
        });
        return;
      }
      pages.set(id, next);
      json(200, { doc: next, message: 'Updated successfully.' });
      return;
    }
    json(405, { message: 'Method not allowed' });
  }

  function media_upload({ entry, body, json }) {
    if (!String(body).includes('name="alt"') && !String(body).includes('"alt"')) {
      json(400, fixture('validation-error').body);
      return;
    }
    const id = ++state.nextId;
    const document = { ...fixture('media-doc'), id, filename: 'upload.png', url: '/api/media/file/upload.png' };
    media.set(id, document);
    json(201, { doc: document, message: 'Media successfully created.' });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        calls,
        state,
        posts,
        versions,
        pages,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => (server.closeAllConnections?.(), server.close(done))),
        EMAIL,
        PASSWORD,
        API_KEY,
      });
    });
  });
}

function lexicalOf(text) {
  return structuredClone({
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      children: [
        {
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          textFormat: 0,
          children: [{ mode: 'normal', text, type: 'text', style: '', detail: 0, format: 0, version: 1 }],
        },
      ],
    },
  });
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

module.exports = { fakePayload, fixture, EMAIL, PASSWORD, API_KEY };
