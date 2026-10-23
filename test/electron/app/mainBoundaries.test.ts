// Goal: real main-process handlers honor the wire contract and preserve source.
// Methodology: register main in a windowless VM, use isolated disk fixtures, and
// exercise disk/network parsers plus the failure boundaries before side effects.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';
import { createHash } from 'node:crypto';
import { mainHarness } from '../../helpers/mainHarness.ts';
import { IPC_PAYLOADS } from '#dist/shared/ipc/ipcPayloads.js';
import { toArray, toRecord } from '#dist/shared/core/record.js';
import { parseMarkdownPage } from '#dist/electron/parse/markdownParser.js';
import { parsePageModel } from '#dist/shared/page/pageNode.js';
import {
  parseContentConfig,
  parseDynamicPaths,
  parseSampleEntry,
  parseSettings,
  parseRecents,
  parseValidationResult,
} from '#dist/electron/app/mainValidation.js';
import { parseAliases } from '#dist/electron/properties/importPaths.js';
import { parseAstroLock } from '#dist/electron/preview/devServerChecks.js';
import { directoryBudget, MAIN_LIMITS } from '#dist/electron/lib/mainLimits.js';
import { coveredPaths } from '#dist/electron/content/contentEntries.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

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
  const terminal = fs.readFileSync(path.resolve('dist/electron/terminal/terminal.js'), 'utf8');
  const terminalChannels = [...terminal.matchAll(/ipcMain\.handle\(['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  // Step 8 retired page:writeRaw; step 9 added page:previewEdit; step 10
  // retired page:write and page:serialize, the Markdown whole-model save.
  // Publishing and its availability check, project settings, canvases, and history are scoped.
  // Account sign-in adds one project-scoped channel for start, status, and cancellation.
  // Published-site discovery has its own channel so remote lookups cannot block local status.
  // Git pull and its background incoming check each have a project-scoped channel.
  assert.equal(harness.handlers.size, 136);
  assert.equal(terminalChannels.length, 4);
  assert.deepEqual(
    [...Object.keys(IPC_PAYLOADS)].sort(),
    [...harness.handlers.keys(), ...terminalChannels].sort(),
  );
  // One-way `send` listeners bypass the invoke registrar, so each must name
  // its own parser before touching the payload.
  const sendChannels = [...terminal.matchAll(/ipcMain\.on\(['"]([^'"]+)['"]/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(sendChannels, ['terminal:input', 'terminal:ack']);
  for (const channel of sendChannels) {
    assert.match(terminal, new RegExp(`parseSendPayload\\('${channel}'`), `${channel} is parsed`);
  }
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
  const patch = {
    tag: 'code-patch',
    hunks: [{ span: { start: 4, end: 10 }, expected: 'Before', text: 'After' }],
  };
  await assert.rejects(
    harness.invoke('page:edit', { pagePath: file, authoredChecksum: 'nope', edit: patch }),
    /Digest: expected 64 lowercase hex characters/,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), '<h1>Before</h1>\n');
  const baseChecksum = sha256('<h1>Before</h1>\n');
  const written = toRecord(
    await harness.invoke('page:edit', {
      pagePath: file,
      authoredChecksum: baseChecksum,
      edit: patch,
    }),
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

test('the Markdown wire model keeps source metadata and rejects corrupted fields', () => {
  for (const source of ['# Title\n\nParagraph.\n\n', '---\r\ntitle: Title\r\n---\r\nHello\r\n']) {
    const parsed = parseMarkdownPage(source);
    assert.ok(parsed.editable);
    const { model } = parsed;
    const wire = parsePageModel(model);
    assert.equal(wire.mdEol, model.mdEol);
    assert.equal(wire.bodyStart, model.bodyStart);
    assert.throws(() => parsePageModel({ ...model, mdEndsWithNewline: 'yes' }), /boolean/);
    const blank = { id: 'n0', kind: 'text', value: 'a', mdBlanksBefore: -1 };
    assert.throws(() => parsePageModel({ ...model, nodes: [blank] }), /nonnegative/);
    assert.throws(() => parsePageModel({ ...model, bodyStart: -1 }), /nonnegative/);
  }
});

test('disk parsers validate known shapes and fail on corrupt data', () => {
  assert.deepEqual(parseSettings({ sound: true }), {
    sound: true,
    usageCountsEnabled: true,
    usageNoticeVersion: 0,
  });
  assert.throws(() => parseSettings({ sound: 'yes' }), /boolean/);
  assert.deepEqual(
    parseSettings({
      sound: false,
      usageCountsEnabled: false,
      usageNoticeVersion: 1,
      usageLastAttemptDay: '2026-10-08',
    }),
    {
      sound: false,
      usageCountsEnabled: false,
      usageNoticeVersion: 1,
      usageLastAttemptDay: '2026-10-08',
    },
  );
  assert.throws(() => parseSettings({ sound: false, usageCountsEnabled: 'no' }), /boolean/);
  assert.throws(
    () => parseSettings({ sound: false, usageLastAttemptDay: 'yesterday' }),
    /usage day/,
  );
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

test('content validation replies keep their issues and refuse corrupt or oversized ones', () => {
  const issue = { path: ['posts', 0, 'title'], message: 'Required', code: 'invalid_type' };
  assert.deepEqual(parseValidationResult({ issues: [issue] }), { issues: [issue] });
  assert.deepEqual(parseValidationResult({ issues: [], unchecked: true, error: 'no schema' }), {
    issues: [],
    unchecked: true,
    error: 'no schema',
  });
  const bad: readonly unknown[] = [
    undefined,
    { issues: 'none' },
    { issues: [{ ...issue, path: [-1] }] },
    { issues: [{ ...issue, path: [1.5] }] },
    { issues: [{ ...issue, message: 3 }] },
    { issues: [{ path: [], message: 'm' }] },
    { issues: [], unchecked: 'yes' },
    { issues: [], error: 'x'.repeat(LIMITS.ipcFieldCharsMax + 1) },
    { issues: Array.from({ length: LIMITS.ipcItemsMax + 1 }, () => issue) },
  ];
  for (const input of bad) {
    assert.throws(() => parseValidationResult(input));
  }
});

test('CMS discovers data modules outside a content glob', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  fs.mkdirSync(path.join(harness.root, 'src/data/posts'), { recursive: true });
  fs.mkdirSync(path.join(harness.root, 'src/lib'), { recursive: true });
  fs.writeFileSync(
    path.join(harness.root, 'src/data/site.ts'),
    [
      'export const site = { title: "Stacki", launched: 2026 };',
      'export const tagline = "Design in the browser";',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(harness.root, 'src/data/team.ts'),
    'export const team = [{ name: "Ada", role: "Engineer" }];\n',
  );
  fs.writeFileSync(
    path.join(harness.root, 'src/lib/constants.ts'),
    'export const internalLabel = "Not CMS content";\n',
  );
  fs.writeFileSync(path.join(harness.root, 'src/data/posts/first.md'), '# First\n');

  const listed = toArray(toRecord(await harness.invoke('cms:list', harness.root))?.['files']);
  assert.ok(listed);
  const relativePaths = listed.map((file) => toRecord(file)?.['rel']);
  assert.ok(relativePaths.includes('data/site.ts#*general'));
  assert.ok(relativePaths.includes('data/team.ts#team'));
  assert.ok(!relativePaths.includes('lib/constants.ts#*general'));

  const read = toRecord(
    await harness.invoke('cms:read', {
      projectPath: harness.root,
      rel: 'data/site.ts#*general',
    }),
  );
  assert.deepEqual(toRecord(read?.['data'])?.['site'], { title: 'Stacki', launched: 2026 });

  const covered = coveredPaths(harness.root, [
    {
      name: 'posts',
      loader: { kind: 'glob', base: 'src/data', pattern: '**/*.md' },
    },
  ]);
  assert.deepEqual(covered, { files: ['src/data/posts/first.md'], dirs: [] });
  assert.ok(!covered.files.includes('src/data/site.ts'));
});

test('CMS discovers root site constants and preserves unrelated source', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  const source = [
    '/** Site name. Keep this comment. */',
    'export const SITE_NAME: string = "Original";',
    'export const SITE_DESCRIPTION =',
    '  "Site description";',
    'export const SITE_URL = "https://example.com";',
    'export const SITE_LOCALE = "en-US";',
    'export const NOINDEX_ROUTES: string[] = ["/404"];',
    'const privateSetting = "Private";',
    '',
  ].join('\r\n');
  const file = path.join(harness.root, 'src/consts.ts');
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(harness.root, 'src/constants.mjs'), 'export const title = "Site";');
  fs.writeFileSync(path.join(harness.root, 'src/consts.d.ts'), 'export const title: string;');
  fs.writeFileSync(path.join(harness.root, 'src/constants-helper.ts'), 'export const limit = 3;');
  const listed = toArray(toRecord(await harness.invoke('cms:list', harness.root))?.['files']);
  assert.ok(listed);
  assert.deepEqual(listed.map((entry) => toRecord(entry)?.['rel']).sort(), [
    'constants.mjs#*general',
    'consts.ts#*general',
  ]);
  const payload = { projectPath: harness.root, rel: 'consts.ts#*general' };
  const read = toRecord(await harness.invoke('cms:read', payload));
  const data = toRecord(read?.['data']);
  assert.ok(data);
  assert.deepEqual(data, {
    SITE_NAME: 'Original',
    SITE_DESCRIPTION: 'Site description',
    SITE_URL: 'https://example.com',
    SITE_LOCALE: 'en-US',
  });
  const saved = toRecord(
    await harness.invoke('cms:write', { ...payload, data: { ...data, SITE_NAME: 'Updated' } }),
  );
  assert.equal(saved?.['ok'], true);
  assert.equal(fs.readFileSync(file, 'utf8'), source.replace('Original', 'Updated'));
});

test('dev-server parsers support current and legacy responses', () => {
  assert.deepEqual(parseDynamicPaths({ entries: [{ slug: 'a' }] }).entries, [
    { params: { slug: 'a' }, props: undefined },
  ]);
  assert.deepEqual(
    parseDynamicPaths({ entries: [{ params: { slug: 'a' }, props: { n: 1 } }] }).entries,
    [{ params: { slug: 'a' }, props: { n: 1 } }],
  );
  assert.throws(() => parseDynamicPaths({ entries: [42] }), /object/);
  assert.throws(() => parseDynamicPaths({ entries: [], error: 42 }), /string/);
  assert.deepEqual(parseSampleEntry({ entry: jsonNull, error: 'offline' }), {
    entry: jsonNull,
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
  const parsed = parseMarkdownPage('Hello\n');
  assert.ok(parsed.editable);
  const { model } = parsed;
  model.nodes.mdTrailingBlanks = Number.MAX_SAFE_INTEGER;
  assert.throws(() => parsePageModel(model), /exceeds blank-line limit/);
  const file = path.join(harness.root, 'src/pages/large.astro');
  fs.writeFileSync(file, '');
  fs.truncateSync(file, LIMITS.sourceBytesMax + 1);
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

test('Studio setup accepts the open project root and refuses outside projects', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  await harness.invoke('project:scan', harness.root);
  assert.deepEqual(await harness.invoke('studio:status', harness.root), {
    kind: 'missing',
    desktopVersion: '0.1.48',
  });
  await assert.rejects(harness.invoke('studio:status', path.dirname(harness.root)), /outside/);
  await assert.rejects(
    harness.invoke('studio:install', {
      projectPath: path.dirname(harness.root),
      source: 'published',
      requestId: 'test-install',
    }),
    /outside/,
  );
  fs.mkdirSync(path.join(harness.root, 'studio'));
  const status = toRecord(await harness.invoke('studio:status', harness.root));
  assert.equal(status?.['kind'], 'blocked');
  assert.deepEqual(
    await harness.invoke('studio:install', {
      projectPath: harness.root,
      source: 'published',
      requestId: 'test-install',
    }),
    { kind: 'error', message: 'Studio already exists. Setup does not replace existing files.' },
  );
});

test('popup preferences persist independently and reject invalid changes', async (context) => {
  const harness = fixture();
  context.after(harness.dispose);
  await harness.invoke('settings:set', { setting: 'sound', enabled: true });
  await harness.invoke('settings:set', { setting: 'usageCountsEnabled', enabled: false });
  const result = toRecord(await harness.invoke('settings:get'));
  assert.equal(result?.['sound'], true);
  assert.equal(result?.['usageCountsEnabled'], false);
  const stored = toRecord(harness.call('readSettings'));
  assert.equal(stored?.['sound'], true);
  assert.equal(stored?.['usageCountsEnabled'], false);
  await assert.rejects(harness.invoke('settings:set', { setting: 'sound', enabled: 'yes' }));
  await assert.rejects(harness.invoke('settings:set', { setting: 'unknown', enabled: true }));
  assert.equal(toRecord(harness.call('readSettings'))?.['sound'], true);
});
