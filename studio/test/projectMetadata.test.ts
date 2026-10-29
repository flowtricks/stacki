// Verify project metadata through real HTTP routes, durable rooms, and source insertion.
// Temporary projects isolate conflicts, serialization, guide validation, and publish path checks.
// Exercise each settings file as the first save, without a guide file or metadata directory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRooms } from '../src/features/collaboration/rooms';
import { metadataRoute } from '../src/features/settings/projectMetadata';
import { loadInsertionDefaults } from '../src/features/settings/loadDefaults';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, parsePage } from '../src/features/source/source';
import { filePath, record } from '../src/shared/validation';
import { metadataFiles } from '../src/features/settings/projectMetadata';
import {
  METADATA_FILES,
  metadataKind,
  parseMetadataResult,
  type MetadataKind,
} from '../vendor/stacki/shared/properties/projectMetadata';
import {
  DEFAULT_PUBLISH_CONFIG,
  parsePublishSource,
} from '../vendor/stacki/shared/properties/publishConfig';

const firstSettings = {
  components: {
    version: 1,
    components: {
      'src/components/Wrapper.astro': {
        children: [{ component: 'src/components/Heading.astro', props: { slot: 'aside' } }],
      },
    },
  },
  guide: {
    version: 1,
    settings: {
      visible: true,
      numbers: false,
      color: '#888',
      opacity: 0.1,
      columns: { kind: 'count', count: 8 },
    },
  },
  pages: { version: 1, entries: ['about/', 'index.astro'] },
  componentSources: { version: 1, sources: [] },
  publish: {
    ...DEFAULT_PUBLISH_CONFIG,
    defaultTarget: 'hosting',
    githubAccount: 'owner',
    githubWorkflow: { kind: 'pull-request' },
    hosting: { provider: 'cloudflare-workers', accountId: 'account', project: 'website' },
    buildScript: 'build-site',
    beforePublish: ['prepare-site'],
    afterPublish: ['verify-site'],
  },
} satisfies Readonly<Record<MetadataKind, unknown>>;

test('Desktop and Studio exchange publish settings through the same project file', async () => {
  const setup = await fixture();
  try {
    const source = JSON.stringify(firstSettings.publish);
    const initial = desktopPublishMetadata(setup.root, { source });
    assert.deepEqual(initial, { ok: true, value: { source } });
    assert.equal((await setup.get('publish'))['source'], source);
    const changed = JSON.stringify({ ...firstSettings.publish, defaultTarget: 'github' });
    assert.equal(
      (await setup.post({ kind: 'publish', source: changed, base: source })).status,
      200,
    );
    assert.deepEqual(desktopPublishMetadata(setup.root, {}), {
      ok: true,
      value: { source: changed },
    });
    assert.deepEqual(await metadataFiles(setup.root), ['.stacki/publish.json']);
  } finally {
    await setup.close();
  }
});

function desktopPublishMetadata(root: string, input: { readonly source?: string }) {
  // Desktop's module graph is deliberately absent from the Studio bundle. Run its actual
  // TypeScript entry point in a separate host process, without weakening Studio's imports.
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      `const { readProjectMetadata, writeProjectMetadata } =
         require('../electron/project/projectMetadata.ts');
       const { parseMetadataWrite } = require('../shared/properties/projectMetadata.ts');
       const { readPublishConfig } = require('../electron/project/publishConfig.ts');
       const root = process.argv[1];
       const input = JSON.parse(process.argv[2]);
       const result = input.source === undefined
         ? readProjectMetadata(root, 'publish')
         : writeProjectMetadata(root, parseMetadataWrite({kind: 'publish', ...input}));
       readPublishConfig(root);
       process.stdout.write(JSON.stringify(result));`,
      root,
      JSON.stringify(input),
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
    },
  );
  const result: unknown = JSON.parse(output);
  return parseMetadataResult(result);
}

for (const [key, value] of Object.entries(firstSettings)) {
  const kind = metadataKind(key);
  test(`${kind} creates its own file on first Studio save without guide settings`, async () => {
    const setup = await fixture();
    try {
      const directory = path.join(setup.root, '.stacki');
      assert.deepEqual(await setup.get(kind), {});
      assert.equal((await setup.post({ kind, source: '{broken' })).status, 400);
      await assert.rejects(readdir(directory), { code: 'ENOENT' });
      const source = JSON.stringify(value);
      const changed = JSON.stringify(value, undefined, 2) + '\n';
      assert.equal((await setup.post({ kind, source })).status, 200);
      assert.deepEqual(await readdir(directory), [path.basename(METADATA_FILES[kind])]);
      assert.equal((await setup.get(kind))['source'], source);
      assert.equal((await setup.post({ kind, source: changed, base: source })).status, 200);
      assert.equal((await setup.get(kind))['source'], changed);
      assert.equal((await setup.post({ kind, source, base: source })).status, 400);
      assert.equal(await readFile(path.join(setup.root, METADATA_FILES[kind]), 'utf8'), changed);
      assert.deepEqual(await metadataFiles(setup.root), [METADATA_FILES[kind]]);
      if (kind === 'publish') {
        assert.deepEqual(parsePublishSource(changed), firstSettings.publish);
      }
    } finally {
      await setup.close();
    }
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-metadata-'));
  await mkdir(path.join(root, 'src/components'), { recursive: true });
  await writeFile(path.join(root, 'src/components/Heading.astro'), '<h2><slot /></h2>');
  await writeFile(
    path.join(root, 'src/components/Wrapper.astro'),
    '<section><slot /><slot name="aside" /></section>',
  );
  const rooms = createRooms(root);
  const server = createServer((request, response) => {
    void metadataRoute(root, rooms, request, response, '/studio/api/metadata', async () => {
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
      }
      return body;
    }).catch((error: unknown) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/studio/api/metadata`;
  return {
    root,
    get: async (kind: string) => record(await (await fetch(url + '?kind=' + kind)).json()),
    post: (input: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(input) }),
    close: async () => {
      server.close();
      server.closeAllConnections();
      rooms.sockets.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Studio saves shared recipes, rejects stale saves, and inserts the saved nested defaults', async () => {
  const setup = await fixture();
  try {
    assert.deepEqual(await setup.get('components'), {});
    const source = JSON.stringify({
      version: 1,
      components: {
        'src/components/Heading.astro': {
          text: 'Literal <b> & {expression}',
          props: { hidden: false },
        },
        'src/components/Wrapper.astro': {
          children: [
            { component: 'src/components/Heading.astro' },
            {
              component: 'src/components/Heading.astro',
              props: { slot: 'aside' },
              text: 'Sidebar default',
            },
          ],
        },
      },
    });
    assert.equal((await setup.post({ kind: 'components', source })).status, 200);
    assert.equal((await setup.post({ kind: 'components', source })).status, 400);
    assert.equal(await readFile(path.join(setup.root, '.stacki/components.json'), 'utf8'), source);
    const settings = await loadInsertionDefaults(setup.root);
    const original = '<main><!-- Keep this comment. --></main>\n';
    const output = applyEdits(
      original,
      structuralEdits(
        original,
        {
          kind: 'insert',
          paired: true,
          name: 'Wrapper',
          importPath: '../components/Wrapper.astro',
          target: 'n0',
        },
        'src/pages/index.astro',
        settings,
      ),
    );
    assert.match(output, /Keep this comment/);
    assert.match(output, /import Heading from/);
    assert.match(output, /hidden=\{false\}/);
    assert.match(output, /slot="aside"/);
    assert.match(output, /Sidebar default/);
    assert.doesNotMatch(output, /<b>/);
    assert.equal(parsePage(output).editable, true);
    const changed = source.replace('Literal', 'Updated');
    assert.equal(
      (await setup.post({ kind: 'components', source: changed, base: source })).status,
      200,
    );
    assert.equal((await setup.post({ kind: 'components', source, base: source })).status, 400);
    const external = changed.replace('Updated', 'External');
    await writeFile(path.join(setup.root, '.stacki/components.json'), external);
    assert.equal((await setup.get('components'))['source'], external);
    assert.equal(
      (await setup.post({ kind: 'components', source: changed, base: external })).status,
      200,
    );
  } finally {
    await setup.close();
  }
});

test('guide settings are shared files; malformed values and arbitrary metadata paths are refused', async () => {
  const setup = await fixture();
  try {
    const source = JSON.stringify({
      version: 1,
      settings: {
        visible: true,
        numbers: false,
        color: '#888',
        opacity: 0.1,
        columns: { kind: 'count', count: 8 },
        columnDefaultsVersion: 1,
        margin: { kind: 'variable', name: '--site-margin' },
      },
    });
    assert.equal((await setup.post({ kind: 'guide', source })).status, 200);
    assert.equal((await setup.get('guide'))['source'], source);
    assert.equal(
      (await setup.post({ kind: 'guide', source: source.replace('0.1', '4'), base: source }))
        .status,
      400,
    );
    assert.equal((await setup.post({ kind: '../credentials', source })).status, 400);
    assert.equal(filePath('.stacki/guide.json'), '.stacki/guide.json');
    assert.throws(() => filePath('.stacki/secret.json'));
    assert.ok((await metadataFiles(setup.root)).includes('.stacki/guide.json'));
  } finally {
    await setup.close();
  }
});

test('page and folder ordering survives Studio reopen and rejects stale or invalid writes', async () => {
  const setup = await fixture();
  try {
    const source = JSON.stringify({ version: 1, entries: ['about/', 'index.astro'] });
    assert.deepEqual(await setup.get('pages'), {});
    assert.equal((await setup.post({ kind: 'pages', source })).status, 200);
    assert.equal((await setup.get('pages'))['source'], source);
    assert.equal(await readFile(path.join(setup.root, '.stacki/pages.json'), 'utf8'), source);
    assert.equal((await setup.post({ kind: 'pages', source })).status, 400);
    assert.equal((await setup.post({ kind: 'pages', source: '{}', base: source })).status, 400);
    assert.equal(filePath('.stacki/pages.json'), '.stacki/pages.json');
  } finally {
    await setup.close();
  }
});
