// Goal: real main-process handlers honor the wire contract and preserve source.
// Methodology: register main in a windowless VM, use isolated disk fixtures, and
// exercise disk/network parsers plus the failure boundaries before side effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { mainHarness } from './main-harness.ts';
import { IPC_PAYLOADS } from '../../dist/shared/ipc-payloads.js';
import { toRecord } from '../../dist/shared/record.js';
import { parseMarkdownPage, serializeMarkdownPage } from '../../dist/electron/markdownParser.js';
import {
  parseMarkdownModel,
  parseContentConfig,
  parseDynamicPaths,
  parseSampleEntry,
  parseSettings,
  parseRecents,
  parseAliases,
  parseAstroLock,
} from '../../dist/electron/main.validation.js';
import { directoryBudget, MAIN_LIMITS } from '../../dist/electron/main.bounds.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-main-contract-'));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(path.join(root, 'user'));
  return {
    root,
    ...harness,
    dispose: () => {
      harness.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test('the complete channel inventory matches real main and terminal registration', (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const terminal = fs.readFileSync(path.resolve('dist/electron/terminal.js'), 'utf8');
  const terminalChannels = [...terminal.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  assert.equal(harness.handlers.size, 114);
  assert.equal(terminalChannels.length, 4);
  assert.deepEqual(
    [...Object.keys(IPC_PAYLOADS)].sort(),
    [...harness.handlers.keys(), ...terminalChannels].sort(),
  );
});

test('malformed writes fail before altering disk; valid writes still work', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const file = path.join(harness.root, 'src/pages/index.astro');
  fs.writeFileSync(file, '<h1>Before</h1>\n');
  await harness.invoke('project:scan', harness.root);
  await assert.rejects(
    harness.invoke('src:writeText', {
      projectPath: harness.root,
      rel: 'src/pages/index.astro',
      text: 42,
    }),
    /Expected string/,
  );
  await assert.rejects(harness.invoke('page:write', { pagePath: file, model: { nodes: false } }));
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Before</h1>\n');
  const written = toRecord(
    await harness.invoke('page:writeRaw', { pagePath: file, source: '<h1>After</h1>\n' }),
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>After</h1>\n');
  assert.equal(written?.['source'], '<h1>After</h1>\n');
  const result = toRecord(await harness.invoke('page:read', file));
  assert.equal(result?.['editable'], true);
  assert.equal(result?.['source'], '<h1>After</h1>\n');
  const parsed = toRecord(
    await harness.invoke('page:parse', { pagePath: file, source: '<main>Draft</main>\n' }),
  );
  assert.equal(parsed?.['editable'], true);
  assert.equal(parsed?.['source'], '<main>Draft</main>\n');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '<h1>After</h1>\n',
    'parsing a code draft has no disk side effect',
  );
});

test('Markdown boundary preserves source metadata and rejects corrupted fields', () => {
  for (const source of ['# Title\n\nParagraph.\n\n', '---\r\ntitle: Title\r\n---\r\nHello\r\n']) {
    const { model } = parseMarkdownPage(source);
    assert.equal(serializeMarkdownPage(parseMarkdownModel(model)), serializeMarkdownPage(model));
    assert.throws(() => parseMarkdownModel({ ...model, mdEndsWithNewline: 'yes' }), /boolean/);
    assert.throws(
      () =>
        parseMarkdownModel({ ...model, nodes: [{ kind: 'text', value: 'a', mdBlanksBefore: -1 }] }),
      /nonnegative/,
    );
  }
});

test('disk parsers validate known shapes and fail on corrupt data', () => {
  assert.deepEqual(parseSettings({ sound: true }), { sound: true });
  assert.throws(() => parseSettings({ sound: 'yes' }), /boolean/);
  const recent = { path: '/site', name: 'Site', openedAt: 1000 };
  assert.deepEqual(parseRecents([recent]), [recent]);
  assert.throws(() => parseRecents([{ ...recent, openedAt: -1 }]), /nonnegative/);
  assert.deepEqual(parseAliases({ compilerOptions: { paths: { '@/*': ['src/*'] } } }), [
    ['@/', ['src/']],
  ]);
  assert.throws(() => parseAliases({ compilerOptions: { paths: { '@/*': [12] } } }), /string/);
  assert.deepEqual(parseAstroLock({ url: 'http://localhost:4321' }), {
    url: 'http://localhost:4321',
  });
  assert.throws(() => parseAstroLock({ url: [] }), /string/);
});

test('dev-server parsers support current and legacy responses', () => {
  assert.deepEqual(parseDynamicPaths({ entries: [{ slug: 'a' }] }).entries, [
    { params: { slug: 'a' }, props: null },
  ]);
  assert.deepEqual(
    parseDynamicPaths({ entries: [{ params: { slug: 'a' }, props: { n: 1 } }] }).entries,
    [{ params: { slug: 'a' }, props: { n: 1 } }],
  );
  assert.throws(() => parseDynamicPaths({ entries: [42] }), /object/);
  assert.throws(() => parseDynamicPaths({ entries: [], error: 42 }), /string/);
  assert.deepEqual(parseSampleEntry({ entry: null, error: 'offline' }), {
    entry: null,
    error: 'offline',
  });
  assert.throws(() => parseSampleEntry([]), /object/);
  assert.throws(() => parseContentConfig({ collections: [{ name: 12 }] }), /string/);
  assert.deepEqual(parseContentConfig({ collections: [{ name: 'broken', error: 'bad' }] }), {
    collections: [{ name: 'broken', error: 'bad' }],
  });
  assert.throws(
    () => parseContentConfig({ collections: [{ name: 'posts', crossFieldChecks: 'yes' }] }),
    /boolean/,
  );
  const manifest = {
    collections: [
      {
        name: 'posts',
        loader: { kind: 'glob', base: './posts' },
        schema: { type: 'object' },
        crossFieldChecks: true,
      },
    ],
  };
  assert.equal(parseContentConfig(manifest).collections[0]?.name, 'posts');
});

test('directory budgets reject both deep and wide projects without partial results', () => {
  const budget = directoryBudget('/site');
  assert.throws(() => budget('/site', -1), /Directory entry count must be nonnegative/);
  assert.throws(() => budget('/site', 1.5), /Directory entry count must be an integer/);
  assert.throws(() => directoryBudget('/site')('/site', MAIN_LIMITS.directoryEntriesMax), /limit/);
  const deep = '/site/' + 'nested/'.repeat(MAIN_LIMITS.directoryDepthMax + 1);
  assert.throws(() => directoryBudget('/site')(deep, 0), /depth/);
});

test('port search skips busy sockets and rejects invalid starts', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const port = await harness.call('findFreePort', address.port);
  assert.equal(typeof port, 'number');
  assert.notEqual(port, address.port);
  await assert.rejects(
    async () => harness.call('findFreePort', -1),
    /Starting port must be positive/,
  );
});

test('Markdown array metadata and source-file size have explicit bounds', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const { model } = parseMarkdownPage('Hello\n');
  model.nodes.mdTrailingBlanks = Number.MAX_SAFE_INTEGER;
  assert.throws(() => parseMarkdownModel(model), /blank lines exceed limit/);
  const file = path.join(harness.root, 'src/pages/large.astro');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, MAIN_LIMITS.sourceBytesMax + 1);
  await assert.rejects(harness.invoke('page:read', file), /Source file exceeds 10 MB limit/);
});

test('an empty tsconfig alias map takes precedence over jsconfig', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const config = path.join(harness.root, 'tsconfig.json');
  fs.writeFileSync(config, '{"compilerOptions":{"paths":{}}}');
  fs.writeFileSync(
    path.join(harness.root, 'jsconfig.json'),
    '{"compilerOptions":{"paths":{"@/*":["src/*"]}}}',
  );
  fs.writeFileSync(path.join(harness.root, 'src/data/site.ts'), 'export const title = "Site";');
  await harness.invoke('project:scan', harness.root);
  const payload = {
    projectPath: harness.root,
    fromFile: path.join(harness.root, 'src/pages/index.astro'),
    spec: '@/data/site',
  };
  assert.equal(toRecord(await harness.invoke('src:resolvePath', payload))?.['ok'], false);
  fs.writeFileSync(config, '{"compilerOptions":{}}');
  assert.equal(toRecord(await harness.invoke('src:resolvePath', payload))?.['ok'], true);
});
