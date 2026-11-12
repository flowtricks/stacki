// Goal: every invoke channel accepts the renderer's wire shape and rejects
// malformed boundary values. Methodology: exercise an explicit fixture for
// each payload family, then corrupt types, nested fields, and resource bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IPC_PAYLOADS,
  parseIpcPayload,
  CLIPBOARD_BYTES_MAX,
  TERMINAL_DIMENSION_MAX,
  parseTerminalAck,
  parseTerminalInput,
} from '#dist/shared/ipc/ipcPayloads.js';
import { BOUNDARY_LIMITS, data, object, text, optional } from '#dist/shared/core/boundary.js';
import type { IpcContract } from '#dist/shared/ipc/ipcContract.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const noPayload = new Set([
  'project:pending',
  'native:copy',
  'native:paste',
  'native:undo',
  'native:redo',
  'settings:get',
  'apps:hostVersion',
  'recents:list',
  'git:repositories',
  'project:openDialog',
  'project:parentDialog',
  'dev:stop',
]);
const pathPayload = new Set([
  'publish:state',
  'publish:availability',
  'publish:siteURL',
  'studio:status',
  'project:close',
  'recents:add',
  'recents:remove',
  'recents:refreshThumb',
  'project:scan',
  'project:classes',
  'watch:start',
  'assets:list',
  'cms:list',
  'cms:meta',
  'css:variables',
  'content:collections',
  'dev:start',
  'style:listFiles',
  'style:listAstroStyles',
  'dev:diagnose',
  'git:info',
  'git:ghStatus',
  'git:init',
  'page:read',
  'page:delete',
  'style:readFile',
  'dev:probe',
  'shell:openExternal',
]);
// Field names intentionally come from actual callers (not the display DTOs).
const fields = {
  projectPath: '/site',
  pagePath: '/site/src/pages/index.astro',
  dir: '/site',
  parentPath: '/sites',
  name: 'Card',
  starter: 'lumos',
  template: 'basics',
  fromFile: '/site/src/pages/index.astro',
  fromPagePath: '/site/src/pages/index.astro',
  toPagePath: '/site/src/pages/about.astro',
  targetPath: '/site/src/components/Card.astro',
  rel: 'src/assets/hero.svg',
  destRel: 'public',
  fromRel: 'public/hero.svg',
  toDirRel: 'public/images',
  parentRel: 'public',
  assetRel: 'src/assets/hero.svg',
  newName: 'photo.svg',
  filePath: '/site/src/styles/site.css',
  spec: '../data/site',
  source: '<h1>Hello</h1>',
  change: { kind: 'remove', name: 'title' },
  text: 'Text',
  css: 'h1 {color:red}',
  file: 'src/styles/site.css',
  start: 0,
  end: 2,
  selector: ':root',
  valueStart: 0,
  valueEnd: 3,
  value: 'red',
  title: 'Colors',
  adds: [{ file: 'site.css', selector: ':root', name: '--red' }],
  moves: [{ file: 'site.css', selector: ':root', name: '--red', target: jsonNull }],
  renames: [{ from: '--old', to: '--new' }],
  fields: { title: { type: 'string' } },
  data: { title: 'Hello' },
  collection: 'posts',
  entry: { file: 'src/content/posts/post.md', locator: [] },
  edits: [{ path: ['title'], value: 'Changed' }],
  from: 'old',
  to: 'new',
  nodes: [{ kind: 'text', id: 'one', value: 'Hello' }],
  model: { imports: [], nodes: [{ kind: 'text', id: 'one', value: 'Hello' }] },
  baseChecksum: 'a'.repeat(64),
  authoredChecksum: 'a'.repeat(64),
  checksum: 'a'.repeat(64),
  token: '00000000-0000-4000-8000-000000000000',
  edit: {
    tag: 'remove-node',
    target: { path: [0], kind: 'element', span: { start: 0, end: 5 } },
  },
  devUrl: 'http://127.0.0.1:4321',
  render: {
    token: 'a'.repeat(64),
    stamps: [{ file: 'src/pages/index.astro', checksum: 'b'.repeat(64) }],
  },
  keys: ['src/pages/index.astro#0'],
  branch: 'feature',
  ref: 'HEAD',
  commit: 'a'.repeat(40),
  path: 'src/pages/index.astro',
  message: 'Update',
  target: 'all',
  request: { provider: 'cloudflare', account: '' },
  repoName: 'site',
  repository: 'owner/site',
  format: 'webp',
  isPrivate: true,
  id: 'term-1',
  cwd: '/site',
  cols: 80,
  rows: 24,
  bytes: [0, 127, 255],
  mime: 'image/png',
  setting: 'sound',
  enabled: true,
};

const aiChat = { projectPath: '/site', chat: `c${'a'.repeat(24)}` };
const metadataSamples: Readonly<Record<string, unknown>> = {
  // The AI chat panel's channels (shared/ipc/aiChat.ts; their bad shapes are in aiChatContract.test.ts).
  'ai:agents': { projectPath: '/site' },
  'ai:installAgent': { projectPath: '/site', agent: 'claude' },
  'ai:trust': { projectPath: '/site' },
  'ai:chats': { projectPath: '/site' },
  'ai:chatCreate': { projectPath: '/site', agent: 'codex' },
  'ai:chatUpdate': { ...aiChat, title: 'Hero copy' },
  'ai:chatDelete': aiChat,
  'ai:chatRead': aiChat,
  'ai:prompt': { ...aiChat, text: 'Tighten the hero copy', attachments: [] },
  'ai:steer': { ...aiChat, text: 'Also fix the footer', attachments: [] },
  'ai:compact': aiChat,
  'ai:chatFork': aiChat,
  'ai:chatMove': { ...aiChat, section: `s${'1'.repeat(16)}` },
  'ai:sections': { projectPath: '/site', action: { kind: 'create', name: 'Launch' } },
  'ai:diff': { ...aiChat, turn: `t${'1'.repeat(16)}`, path: 'src/pages/index.astro' },
  'ai:mentions': { projectPath: '/site', query: 'ind', kinds: ['file', 'skill'] },
  'ai:cancel': aiChat,
  'ai:permission': { ...aiChat, request: 'p1', answer: { kind: 'cancel' } },
  'ai:setOption': { ...aiChat, option: 'model', value: 'large' },
  'ai:setup': { projectPath: '/site', agent: 'claude', action: { kind: 'detect' } },
  'ai:review': { ...aiChat, turn: `t${'1'.repeat(16)}`, path: 'src/pages/index.astro', action: { kind: 'keep' } },
  'style:selectorUsage': { projectPath: '/site' },
  'style:removeSelectors': {
    projectPath: '/site',
    ids: ['src/styles/site.css|0|0|0'],
    files: [{ rel: 'src/styles/site.css', digest: 'a'.repeat(64) }],
  },
  'style:restoreSelectors': {
    projectPath: '/site',
    changes: [{ rel: 'src/styles/site.css', before: '.a {}', after: '' }],
    to: 'before',
  },
  'cmsRemote:create': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    collection: 'booklet',
  },
  'cmsRemote:delete': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    ids: ['abc'],
  },
  'cmsRemote:move': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    move: { collection: 'booklet', id: 'abc', after: 'def' },
  },
  'cmsRemote:collections': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
  },
  'cmsRemote:documents': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    collection: 'campus',
  },
  'cmsRemote:template': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    collection: 'campus',
  },
  'cmsRemote:document': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    id: 'abc',
  },
  'cmsRemote:write': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    write: { id: 'abc', field: 'pastorName', value: 'Matt' },
  },
  'cmsRemote:references': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    types: ['campus'],
  },
  'cmsRemote:upload': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    kind: 'image',
  },
  'cmsRemote:linkPreview': { url: 'https://youtu.be/gQIJRzTjvCA' },
  'pageTemplate:create': {
    projectPath: '/site',
    draft: { route: '/blog/[slug]', source: { kind: 'content-collection', collection: 'blog', origin: 'existing', slug: { kind: 'entry-id' } } },
  },
  'pageTemplate:plan': {
    projectPath: '/site',
    draft: { route: '/blog/[slug]', source: { kind: 'content-collection', collection: 'blog', origin: 'existing', slug: { kind: 'entry-id' } } },
  },
  'pageTemplate:sample': { projectPath: '/site', request: { kind: 'http-json', url: 'https://api.example.com/items', headers: [] } },
  'project:setEnv': { projectPath: '/site', name: 'API_TOKEN', value: 'value' },
  'content:remoteRead': {
    projectPath: '/site',
    request: { operation: 'documents', collection: 'blog' },
  },
  'content:remoteEdit': {
    projectPath: '/site',
    request: { operation: 'createCollection', name: 'Blog posts' },
  },
  'cmsRemote:act': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    id: 'abc',
    action: 'publish',
  },
  'cmsRemote:history': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    id: 'abc',
  },
  'cmsRemote:restore': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    id: 'abc',
    revision: 'tx-123',
  },
  // Stacki Apps: install from a file or a GitHub release, then commit; update and remove by id.
  'apps:list': { projectPath: '/site' },
  'apps:pickFile': { projectPath: '/site' },
  'apps:stageGitHub': { projectPath: '/site', source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', account: 'octocat' }, tag: 'v1.0.0' },
  'apps:githubRepositories': { projectPath: '/site', account: 'octocat' },
  'apps:githubReleases': { projectPath: '/site', source: { owner: 'octocat', repository: 'heat-map', asset: 'app.zip' } },
  'apps:commit': { projectPath: '/site', token: 'a'.repeat(32) },
  'apps:discard': { projectPath: '/site', token: 'a'.repeat(32) },
  'apps:uninstall': { projectPath: '/site', id: 'heat-map' },
  'apps:checkUpdates': { projectPath: '/site', force: true },
  'apps:applyUpdate': { projectPath: '/site', id: 'heat-map' },
  // Apps added as a folder: the folders that do not read as an app, and showing one.
  'apps:folders': { projectPath: '/site' },
  'apps:revealFolder': { projectPath: '/site', folder: 'My App' },
  'apps:marketplace': { projectPath: '/site', refresh: true },
  'apps:installMarketplace': { projectPath: '/site', id: 'heat-map', version: '1.1.0' },
  'apps:setAutoUpdate': { projectPath: '/site', id: 'heat-map', autoUpdate: false },
  'apps:repositoryVisibility': { projectPath: '/site', id: 'heat-map' },
  // Sharing and publishing apps, and app settings.
  'apps:scanSecrets': { projectPath: '/site', target: { kind: 'installed', id: 'heat-map' } },
  'apps:repositoryStatus': { projectPath: '/site', repository: { owner: 'octocat', repository: 'heat-map', account: 'octocat' } },
  'apps:makePublic': { projectPath: '/site', repository: { owner: 'octocat', repository: 'heat-map', account: 'octocat' } },
  'apps:addLicense': { projectPath: '/site', repository: { owner: 'octocat', repository: 'heat-map', account: 'octocat' } },
  'apps:share': {
    projectPath: '/site',
    share: { id: 'heat-map', account: 'octocat', owner: 'acme', ownerKind: 'organization', name: 'heat-map', visibility: 'private' },
  },
  'apps:switchSource': {
    projectPath: '/site',
    id: 'heat-map',
    source: { kind: 'github', owner: 'acme', repository: 'heat-map', asset: 'heat-map.zip', account: 'octocat', tag: 'v1.0.0' },
  },
  'apps:checkMarketplace': { projectPath: '/site', repository: { owner: 'octocat', repository: 'heat-map', account: 'octocat' } },
  'apps:submitMarketplace': { projectPath: '/site', submission: { owner: 'octocat', repository: 'heat-map', account: 'octocat', acceptedTerms: true } },
  'apps:readSettings': { projectPath: '/site', id: 'heat-map' },
  'apps:writeSettings': { projectPath: '/site', id: 'heat-map', values: { 'api-key': 'value' } },
  // The pages and components an app's page index stamps in one batch.
  'apps:fileStamps': { projectPath: '/site', rels: ['src/pages/index.astro', 'src/components/Card.astro'] },
  // App storage and the person.
  'apps:storageGet': { projectPath: '/site', id: 'heat-map', scope: 'project', key: 'pins/hero' },
  'apps:storageSet': { projectPath: '/site', id: 'heat-map', scope: 'local', key: 'pins/hero', value: '{}', writer: 'desktop-0a1b' },
  'apps:storageKeys': { projectPath: '/site', id: 'heat-map', scope: 'project' },
  'apps:storageWatch': { projectPath: '/site' },
  'apps:person': { projectPath: '/site' },
  'apps:people': { projectPath: '/site' },
  // A region of the editor window (window CSS pixels) the renderer measured for `canvas.snapshot`.
  'apps:canvasSnapshot': { rect: { x: 10, y: 20, width: 300, height: 200 }, widthMax: 320 },
  // Project files and sign-ins.
  'apps:files': { projectPath: '/site', id: 'heat-map', operation: { kind: 'write', path: 'src/data/heat.json', content: '{}', encoding: 'utf8' } },
  'apps:authConnect': { projectPath: '/site', id: 'heat-map', provider: 'google' },
  'apps:authStatus': { projectPath: '/site', id: 'heat-map' },
  'apps:authToken': { projectPath: '/site', id: 'heat-map', provider: 'google' },
  'apps:authDisconnect': { projectPath: '/site', id: 'heat-map', provider: 'google' },
  'apps:netFetch': { projectPath: '/site', id: 'heat-map', request: { url: 'https://api.example.test/v1/report', method: 'POST', body: '{}', auth: 'google' } },
  'mediaHosting:connections': { projectPath: '/site' },
  'mediaHosting:save': {
    projectPath: '/site',
    draft: {
      kind: 'bunny',
      label: 'CDN',
      storageZone: 'site-zone',
      region: 'de',
      publicBaseUrl: 'https://site.b-cdn.net',
      secret: { kind: 'accessKey', accessKey: 'zone-password' },
    },
  },
  'mediaHosting:remove': { projectPath: '/site', id: '00000000-0000-4000-8000-000000000000' },
  'mediaHosting:discover': { projectPath: '/site', key: { provider: 'r2', token: 'cf-token' } },
  'mediaHosting:connectAccount': {
    projectPath: '/site',
    connect: { provider: 'bunny', apiKey: 'account-key', label: 'CDN', storageZone: 'site-zone', publicBaseUrl: 'https://site.b-cdn.net' },
  },
  'mediaHosting:list': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: '' },
  'mediaHosting:pickUpload': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images' },
  'mediaHosting:upload': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images', filePaths: ['/tmp/a.png'] },
  'mediaHosting:createFolder': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: '', name: 'images' },
  'mediaHosting:rename': {
    projectPath: '/site',
    connectionId: '00000000-0000-4000-8000-000000000000',
    folder: 'images',
    entry: 'file',
    from: 'a.png',
    to: 'b.png',
  },
  'mediaHosting:delete': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images', entry: 'folder', name: 'old' },
  'mediaHosting:reorder': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images', order: ['b.png', 'a.png'] },
  'mediaHosting:replace': { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images', name: 'a.png' },
  'cmsConnections:list': { projectPath: '/site' },
  'cmsConnections:save': {
    projectPath: '/site',
    draft: {
      kind: 'sanity',
      label: 'Site',
      projectId: 'abc123',
      dataset: 'production',
      secret: 'sk',
    },
  },
  'cmsConnections:remove': { projectPath: '/site', id: '00000000-0000-4000-8000-000000000000' },
  'cmsConnections:sanityLogin': {
    projectPath: '/site',
    request: { action: 'start', id: '00000000-0000-4000-8000-000000000000' },
  },
  'publish:account': {
    projectPath: '/site',
    request: { action: 'start', id: '00000000-0000-4000-8000-000000000000' },
  },
  'publish:repository': {
    projectPath: '/site',
    request: { action: 'list', account: 'owner' },
  },
  'project:metadata': { projectPath: '/site', kind: 'publish' },
  'project:writeMetadata': { projectPath: '/site', write: { kind: 'publish', source: '{}' } },
  'project:pickFolder': { projectPath: '/site' },
  'project:createDefaultsCanvas': {
    projectPath: '/site',
    canvas: {
      file: '.stacki/canvas/00000000-0000-4000-8000-000000000000.astro',
      source: '<h1>Hello</h1>',
    },
  },
  // A batch is two edits or more (page:edit carries one).
  'page:editBatch': { pagePath: fields.pagePath, authoredChecksum: fields.authoredChecksum, edits: [fields.edit, fields.edit] },
  'project:removeDefaultsCanvas': {
    projectPath: '/site',
    file: '.stacki/canvas/00000000-0000-4000-8000-000000000000.astro',
  },
  // The Instructions panel: Markdown paths inside the project, and a folder for rules.
  'instructions:create': { projectPath: '/site', file: '.claude/rules/testing.md', source: '# Testing\n' },
  'instructions:createFolder': { projectPath: '/site', folder: '.claude/rules/frontend' },
  'instructions:read': { projectPath: '/site', file: 'AGENTS.md' },
  'instructions:write': { projectPath: '/site', file: 'AGENTS.md', source: '# B\n', base: '# A\n' },
  // The history panel's author pictures: full commit hashes with their authors' emails.
  'git:avatars': { projectPath: '/site', commits: [{ hash: 'a'.repeat(40), email: 'designer@example.com' }] },
  // The Roles tab's member picker: the typed start of a GitHub username.
  'github:searchUsers': { projectPath: '/site', query: 'octo-' },
  // The Audits panel's rendered pass: a route of the loopback dev server.
  'audit:render': { projectPath: '/site', devUrl: 'http://localhost:4321', route: '/about' },
  'audit:measure': { projectPath: '/site', devUrl: 'http://localhost:4321', route: '/' },
  // A page's value: one import called (`call`), or its last render's values (`scope`).
  'content:sampleValue': {
    projectPath: '/site',
    devUrl: 'http://localhost:4321',
    pagePath: fields.pagePath,
    source: { kind: 'scope', sinceMs: 0 },
  },
};

for (const [channel, parse] of Object.entries(IPC_PAYLOADS)) {
  test(`IPC payload: ${channel}`, () => {
    const sample =
      metadataSamples[channel] ??
      (channel === 'assets:convert'
        ? { projectPath: '/site', rel: 'public/hero.png', format: 'webp' }
        : channel === 'studio:install'
          ? { projectPath: '/site', source: 'published', requestId: 'test-install' }
          : noPayload.has(channel)
            ? undefined
            : pathPayload.has(channel)
              ? '/site'
              : fields);
    assert.doesNotThrow(() => parse(sample));
    assert.throws(() => parse(Symbol('invalid')), /Expected/);
    if (!noPayload.has(channel)) {
      assert.throws(() => parse(17), /Expected/);
    }
  });
}

test('taking back a created component names the file and the bytes it was created with', () => {
  const request = { projectPath: '/site', path: '/site/src/components/Button.astro', checksum: 'c'.repeat(64) };
  assert.deepEqual(parseIpcPayload('component:discard', request), request);
  assert.equal(parseIpcPayload('component:discard', { ...request, force: true }).force, true);
  assert.throws(() => parseIpcPayload('component:discard', { ...request, checksum: 'short' }), /Digest: expected 64 lowercase hex/);
  assert.throws(() => parseIpcPayload('component:discard', { ...request, path: undefined }), /Expected/);
  assert.throws(() => parseIpcPayload('component:discard', { ...request, force: 'yes' }), /Expected/);
});

test('a sample entry is asked for by id, by position, or as the first a list shows', () => {
  const request = { devUrl: 'http://localhost:4321', name: 'stats' };
  assert.deepEqual(parseIpcPayload('content:sampleEntry', request), request);
  assert.equal(parseIpcPayload('content:sampleEntry', { ...request, index: 2 }).index, 2);
  assert.equal(parseIpcPayload('content:sampleEntry', { ...request, index: 0 }).index, 0);
  assert.throws(() => parseIpcPayload('content:sampleEntry', { ...request, index: -1 }), /Expected nonnegative integer/);
  assert.throws(() => parseIpcPayload('content:sampleEntry', { ...request, index: 1.5 }), /Expected safe integer/);
  assert.throws(() => parseIpcPayload('content:sampleEntry', { ...request, index: '2' }), /Expected number/);
});

test('content writes accept the storage locator used by ContentView', () => {
  const payload = parseIpcPayload('content:writeEntry', {
    projectPath: '/site',
    entry: fields.entry,
    edits: fields.edits,
    body: undefined,
  });
  assert.deepEqual(payload.entry, fields.entry);
  assert.equal('body' in payload, false);
  assert.throws(
    () =>
      parseIpcPayload('content:writeEntry', {
        projectPath: '/site',
        entry: { file: false, locator: [] },
        edits: [],
      }),
    /Expected string/,
  );
  assert.throws(
    () =>
      parseIpcPayload('content:writeEntry', {
        projectPath: '/site',
        entry: fields.entry,
        edits: [{ path: [-1], value: 'bad' }],
      }),
    /nonnegative/,
  );
});

test('CSS group and row moves preserve both supported payload variants', () => {
  const moves = [fields.moves[0], { file: 'site.css', selector: ':root', names: ['--red'] }];
  const result = parseIpcPayload('css:moveVariables', { projectPath: '/site', moves });
  assert.equal(result.moves?.length, 2);
  assert.deepEqual(result.moves?.[1], moves[1]);
  assert.throws(
    () =>
      parseIpcPayload('css:moveVariables', {
        projectPath: '/site',
        moves: [{ file: 'site.css', selector: ':root', names: [false] }],
      }),
    /Expected string/,
  );
});

test('IPC collection, string, integer, depth, and path bounds fail explicitly', () => {
  assert.throws(() => parseIpcPayload('project:scan', 'x'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1)), /Path exceeds limit/);
  assert.throws(() => parseIpcPayload('project:scan', '/site\0suffix'), /NUL/);
  assert.throws(
    () =>
      parseIpcPayload('src:writeText', {
        projectPath: '/site',
        rel: 'file',
        text: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1),
      }),
    /String exceeds limit/,
  );
  assert.throws(
    () =>
      parseIpcPayload('selection:copy', {
        projectPath: '/site',
        keys: Array.from({ length: BOUNDARY_LIMITS.itemsMax + 1 }, () => 'key'),
      }),
    /Array exceeds limit/,
  );
  for (const value of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseIpcPayload('git:log', { projectPath: '/site', limit: value }));
  }
  assert.deepEqual(parseIpcPayload('git:log', { projectPath: '/site', withFiles: true }), {
    projectPath: '/site',
    withFiles: true,
  });
  assert.throws(() => parseIpcPayload('git:log', { projectPath: '/site', withFiles: 'yes' }));
  let deep: unknown = 'leaf';
  for (let index = 0; index <= BOUNDARY_LIMITS.depthMax; index++) {
    deep = { child: deep };
  }
  assert.throws(() => data(deep), /depth limit/);
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.throws(() => data(cyclic), /depth limit/);
});

test('object parsing omits undefined options and rejects prototype-shaped non-data', () => {
  assert.deepEqual(object({ value: optional(text) })({}), {});
  assert.throws(() => data(() => undefined), /Expected object/);
  assert.throws(() => data(NaN), /finite/);
});

// Assignment tests pin the compile-time distinction between channels and results.
const write: IpcContract['content:writeEntry']['payload'] = {
  projectPath: '/site',
  entry: fields.entry,
  edits: fields.edits,
};
const ready: IpcContract['dev:start']['result'] = {
  url: 'http://localhost:4321',
  trailingSlash: 'always',
};
void write;
void ready;

test('clipboard payloads accept bytes without truncation and reject invalid byte values', () => {
  const image = new Uint8Array(BOUNDARY_LIMITS.itemsMax + 1);
  image[0] = 255;
  const parsed = parseIpcPayload('terminal:clipboardImage', { bytes: image, mime: 'image/png' });
  assert.equal(parsed.bytes.length, image.length);
  assert.equal(parsed.bytes[0], 255);
  for (const bytes of [[256], [-1], [1.5], ['0']]) {
    assert.throws(() => parseIpcPayload('terminal:clipboardImage', { bytes, mime: 'image/png' }));
  }
  assert.throws(
    () =>
      parseIpcPayload('terminal:clipboardImage', {
        bytes: new Uint8Array(CLIPBOARD_BYTES_MAX + 1),
        mime: 'image/png',
        setting: 'sound',
        enabled: true,
      }),
    /byte limit/,
  );
});

test('terminal send channels accept keystrokes and acks and refuse every malformed shape', () => {
  assert.deepEqual(parseTerminalInput({ id: 't1', data: 'ls\r' }), { id: 't1', data: 'ls\r' });
  assert.deepEqual(parseTerminalAck({ id: 't1', count: 0 }), { id: 't1', count: 0 });
  assert.deepEqual(parseTerminalAck({ id: 't1', count: 4096 }), { id: 't1', count: 4096 });
  const malformedInputs = [undefined, jsonNull, 'ls', { id: 't' }, { data: 'x' }, { id: 1, data: 'x' }];
  for (const input of malformedInputs) {
    assert.throws(() => parseTerminalInput(input));
  }
  assert.throws(() => parseTerminalInput({ id: 't1', data: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) }), /String exceeds limit/);
  // A NaN, negative, fractional or unsafe count would poison the flow-control
  // total and leave a paused pty paused (or never pause it again).
  for (const count of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53, '10', undefined]) {
    assert.throws(() => parseTerminalAck({ id: 't1', count }));
  }
});

type Assignable<Source, Target> = [Source] extends [Target] ? true : false;
const channelsStayDistinct: Assignable<IpcContract['style:writeFile']['payload'], IpcContract['page:edit']['payload']> = false;
const terminalSuccessNeedsId: Assignable<{ readonly ok: true }, IpcContract['terminal:start']['result']> = false;
void channelsStayDistinct;
void terminalSuccessNeedsId;

test('desktop preferences reject unknown keys and nonboolean toggle values', () => {
  assert.deepEqual(parseIpcPayload('settings:set', { setting: 'sound', enabled: false }), {
    setting: 'sound',
    enabled: false,
  });
  for (const input of [{ setting: 'unknown', enabled: true }, { setting: 'sound', enabled: 'true' }, { setting: 'usageCountsEnabled' }]) {
    assert.throws(() => parseIpcPayload('settings:set', input));
  }
});

test('terminal startup and resize reject unmeasured or unrepresentable native grids', () => {
  const payload = { id: 'terminal', cwd: '/site', cols: 92, rows: 18 };
  for (const channel of ['terminal:start', 'terminal:resize'] as const) {
    assert.equal(parseIpcPayload(channel, payload).cols, 92);
    assert.equal(parseIpcPayload(channel, payload).rows, 18);
    assert.equal(parseIpcPayload(channel, { ...payload, cols: 1 }).cols, 1);
    assert.equal(parseIpcPayload(channel, { ...payload, rows: TERMINAL_DIMENSION_MAX }).rows, TERMINAL_DIMENSION_MAX);
    for (const field of ['cols', 'rows'] as const) {
      for (const value of [undefined, 0, -1, 1.5, NaN, Infinity, '80', TERMINAL_DIMENSION_MAX + 1]) {
        assert.throws(() => parseIpcPayload(channel, { ...payload, [field]: value }));
      }
    }
    assert.throws(() => parseIpcPayload(channel, { id: 'terminal', cwd: '/site' }));
  }
});

test('a sampled value names its source: an import call or the render’s own scope', () => {
  const page = { projectPath: '/site', devUrl: 'http://localhost:4321', pagePath: fields.pagePath };
  const call = parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'call', spec: '@/sanity/queries.ts', name: 'getPastors' } });
  assert.deepEqual(call.source, { kind: 'call', spec: '@/sanity/queries.ts', name: 'getPastors' });
  const scope = parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'scope', sinceMs: 1_700_000_000_000 } });
  assert.deepEqual(scope.source, { kind: 'scope', sinceMs: 1_700_000_000_000 });
  // The old flat shape, an unknown kind, a missing field, and a time that is not a count all fail.
  assert.throws(() => parseIpcPayload('content:sampleValue', { ...page, spec: '../data', name: 'getPastors' }), /Expected object/);
  assert.throws(() => parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'module' } }), /Unknown sample source/);
  assert.throws(() => parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'call', spec: '../data' } }), /Expected string/);
  assert.throws(() => parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'scope', sinceMs: -1 } }), /nonnegative/);
  assert.throws(() => parseIpcPayload('content:sampleValue', { ...page, source: { kind: 'scope', sinceMs: 1.5 } }), /safe integer/);
});

test('media hosting payloads refuse traversal, unknown entries, unbounded uploads and keys in the wrong place', () => {
  const target = { projectPath: '/site', connectionId: '00000000-0000-4000-8000-000000000000', folder: 'images' };
  assert.throws(() => parseIpcPayload('mediaHosting:list', { ...target, folder: '../secrets' }), /reserved/);
  assert.throws(() => parseIpcPayload('mediaHosting:list', { ...target, connectionId: 'abc' }), /connection id/);
  assert.throws(() => parseIpcPayload('mediaHosting:rename', { ...target, entry: 'bucket', from: 'a', to: 'b' }), /entry kind/);
  assert.throws(() => parseIpcPayload('mediaHosting:rename', { ...target, entry: 'file', from: 'a', to: 'x/y' }), /slash/);
  assert.throws(() => parseIpcPayload('mediaHosting:upload', { ...target, filePaths: [] }), /files to upload/);
  assert.throws(() => parseIpcPayload('mediaHosting:upload', { ...target, filePaths: Array.from({ length: 101 }, () => '/a') }), /files to upload/);
  assert.throws(() => parseIpcPayload('mediaHosting:reorder', { ...target, order: ['a', 'a'] }), /once/);
  assert.throws(
    () =>
      parseIpcPayload('mediaHosting:save', {
        projectPath: '/site',
        draft: { kind: 'r2', label: 'R', accountId: 'a'.repeat(32), bucket: 'media', publicBaseUrl: 'https://c.dev' },
      }),
    /Expected object/,
  );
  assert.throws(() => parseIpcPayload('assets:replace', { projectPath: '/site' }), /Expected string/);
});
