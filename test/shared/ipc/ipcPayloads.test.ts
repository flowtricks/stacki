// Goal: every invoke channel accepts the renderer's wire shape and rejects
// malformed boundary values. Methodology: exercise an explicit fixture for
// each payload family, then corrupt types, nested fields, and resource bounds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IPC_PAYLOADS,
  parseIpcPayload,
  CLIPBOARD_BYTES_MAX,
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
  'project:hasNodeModules',
  'project:install',
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

const metadataSamples: Readonly<Record<string, unknown>> = {
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
  'project:createDefaultsCanvas': {
    projectPath: '/site',
    canvas: {
      file: '.stacki/canvas/00000000-0000-4000-8000-000000000000.astro',
      source: '<h1>Hello</h1>',
    },
  },
  'project:removeDefaultsCanvas': {
    projectPath: '/site',
    file: '.stacki/canvas/00000000-0000-4000-8000-000000000000.astro',
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
  assert.throws(
    () => parseIpcPayload('project:scan', 'x'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1)),
    /Path exceeds limit/,
  );
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
  const malformedInputs = [
    undefined,
    jsonNull,
    'ls',
    { id: 't' },
    { data: 'x' },
    { id: 1, data: 'x' },
  ];
  for (const input of malformedInputs) {
    assert.throws(() => parseTerminalInput(input));
  }
  assert.throws(
    () => parseTerminalInput({ id: 't1', data: 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) }),
    /String exceeds limit/,
  );
  // A NaN, negative, fractional or unsafe count would poison the flow-control
  // total and leave a paused pty paused (or never pause it again).
  for (const count of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 2 ** 53, '10', undefined]) {
    assert.throws(() => parseTerminalAck({ id: 't1', count }));
  }
});

type Assignable<Source, Target> = [Source] extends [Target] ? true : false;
const channelsStayDistinct: Assignable<
  IpcContract['style:writeFile']['payload'],
  IpcContract['page:edit']['payload']
> = false;
const terminalSuccessNeedsId: Assignable<
  { readonly ok: true },
  IpcContract['terminal:start']['result']
> = false;
void channelsStayDistinct;
void terminalSuccessNeedsId;

test('desktop preferences reject unknown keys and nonboolean toggle values', () => {
  assert.deepEqual(parseIpcPayload('settings:set', { setting: 'sound', enabled: false }), {
    setting: 'sound',
    enabled: false,
  });
  for (const input of [
    { setting: 'unknown', enabled: true },
    { setting: 'sound', enabled: 'true' },
    { setting: 'usageCountsEnabled' },
  ]) {
    assert.throws(() => parseIpcPayload('settings:set', input));
  }
});
