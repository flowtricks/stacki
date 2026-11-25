// Goal: one file Studio cannot edit must not stop a project from opening. Studio accepts a
// narrow set of path characters, and ordinary sites carry names outside it (`logo@2x.png`,
// `Card (old).astro`) or stylesheets past the editing limit (minified vendor CSS).
// Method: scan a real temporary project holding such files, parse the answers with the
// client's own parser, and check that the files stay refused for editing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readListedSource, readSource, safePath, scanProject } from '../src/features/project/projectServer';
import { readSources } from '../src/features/bake/bakeSite';
import { scanComponentUsage } from '../src/features/components/componentUsageServer';
import { scanProjectVariables, variableRoutes } from '../src/features/variables/variableServer';
import { cmsSources, withCmsSnapshot } from '../src/features/cms/cmsSnapshot';
import { record } from '../src/shared/validation';
import { parseProject } from '../src/features/project/projectClient';
import { assetCatalog } from '../src/features/assets/assetCatalog';
import { styleFiles } from '../src/features/settings/styleRoutes';
import { saveAsset } from '../src/features/storage/assetStorage';
import { MAX_SOURCE } from '../src/shared/validation';

async function project(files: Readonly<Record<string, string>>, run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-names-'));
  try {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const SITE = {
  'src/pages/index.astro': '<main class="kept"></main>\n',
  'src/pages/über.astro': '<main></main>\n',
  'src/components/Card.astro': '<div></div>\n',
  'src/components/Card (old).astro': '<div></div>\n',
  'src/styles/site.css': '.small { color: red }\n',
  'public/logo.png': 'png',
  'public/logo@2x.png': 'png',
  'src/pages/(old)/draft.astro': '<main></main>\n',
  'public/vendor/theme@2x.css': '.odd { color: red }\n',
  'public/vendor/bundle.min.css': '.huge{}'.padEnd(MAX_SOURCE + 1, ' '),
};

test('a project with unsupported names and an oversized stylesheet still opens', async () => {
  await project(SITE, async (root) => {
    const scan = parseProject(await scanProject(root));
    assert.deepEqual(scan.pages, ['src/pages/index.astro']);
    assert.deepEqual(
      scan.components.map((component) => component.file),
      ['src/components/Card.astro'],
    );
    assert.ok(scan.classes.includes('small'));
    assert.ok(!scan.classes.includes('huge'));
    assert.ok(!scan.classes.includes('odd'));
  });
});

test('the asset and stylesheet lists keep the files Studio can open', async () => {
  await project(SITE, async (root) => {
    const assets = await assetCatalog(root);
    assert.deepEqual(
      assets.entries.filter((entry) => !entry.isDir).map((entry) => entry.rel),
      ['public/logo.png'],
    );
    const styles = await styleFiles(root, false);
    assert.deepEqual(
      styles.files.map((file) => file.rel),
      ['public/vendor/bundle.min.css', 'src/styles/site.css'],
    );
  });
});

test('an upload saves beside a file Studio cannot open', async () => {
  await project({ 'public/logo@2x.png': 'png' }, async (root) => {
    await saveAsset(root, 'public/new.png', Buffer.from('new'));
    assert.equal(await readFile(path.join(root, 'public/new.png'), 'utf8'), 'new');
  });
});

test('unsupported names and oversized files stay refused for editing', async () => {
  await project(SITE, async (root) => {
    await assert.rejects(() => safePath(root, 'public/logo@2x.png'), /Invalid project path/);
    await assert.rejects(() => saveAsset(root, 'public/new@2x.png', Buffer.from('new')), /Invalid project path/);
    await assert.rejects(() => readSource(root, 'public/vendor/bundle.min.css'), /1 MB/);
  });
});

// The scans behind the Variables panel, component usage and Collections read every
// file, whatever its name or size: one skipped file would make a rename or a usage
// count silently incomplete. Writing stays limited to the paths Studio can edit.
const BIG_SCRIPT = `export const colour = 'var(--brand)';\n//${'x'.repeat(MAX_SOURCE)}\n`;
const REFERENCES = {
  'src/styles/tokens.css': ':root {\n  --brand: #123456;\n}\n',
  'src/components/Card.astro': '<div></div>\n',
  'src/components/Card (old).astro': "---\nimport Card from './Card.astro';\n---\n<Card />\n",
  'src/pages/über.astro': "---\nimport Card from '../components/Card.astro';\n---\n<Card />\n",
  'src/pages/index.astro': '<main></main>\n',
  'src/content/posts/über.md': '---\ntitle: One\n---\n',
  'public/logo@2x.png': 'png',
  'public/vendor/bundle.js': BIG_SCRIPT,
};

test('component usage counts files Studio cannot open', async () => {
  await project(REFERENCES, async (root) => {
    const usage = await scanComponentUsage(root);
    assert.deepEqual(
      usage.map(({ file, total }) => [file, total]),
      [['src/components/Card.astro', 2]],
    );
  });
});

test('the variables scan reads unsupported names and a script over 1 MB', async () => {
  await project(REFERENCES, async (root) => {
    const snapshot = await scanProjectVariables(root);
    assert.ok(Object.hasOwn(snapshot.versions, 'public/vendor/bundle.js'));
    assert.ok(Object.hasOwn(snapshot.versions, 'src/pages/über.astro'));
  });
});

// The Variables route over a fake room store that records what it is asked to write.
async function postVariables(root: string, input: unknown) {
  const written: string[] = [];
  const rooms = {
    coordinator: { run: <T>(work: () => Promise<T>) => work() },
    read: (file: string) => readSource(root, file),
    get: async (file: string) => {
      await readSource(root, file);
      return { setSource: async () => void written.push(file) };
    },
  };
  let answer = '';
  const route = variableRoutes(root, rooms as unknown as Parameters<typeof variableRoutes>[1]);
  const response = { setHeader: () => undefined, end: (text: string) => void (answer = text) };
  await route({ method: 'POST' } as IncomingMessage, response as unknown as ServerResponse, '/studio/api/variables', async () => JSON.stringify(input));
  return { result: record(JSON.parse(answer)), written };
}

test('a rename that reaches a file Studio cannot write changes nothing', async () => {
  await project(REFERENCES, async (root) => {
    const { versions } = await scanProjectVariables(root);
    const rename = { operation: 'renameCssVariables', payload: { projectPath: 'studio', renames: [{ from: '--brand', to: '--accent' }] }, versions };
    const { result, written } = await postVariables(root, rename);
    assert.equal(result['ok'], false);
    assert.match(String(result['error']), /public\/vendor\/bundle\.js/);
    assert.deepEqual(written, []);
  });
});

test('collections read and stage files Studio cannot edit', async () => {
  await project(REFERENCES, async (root) => {
    const snapshot = await cmsSources(root);
    assert.equal(snapshot.sources.get('src/content/posts/über.md'), REFERENCES['src/content/posts/über.md']);
    assert.equal(snapshot.sources.get('public/vendor/bundle.js'), BIG_SCRIPT);
    await withCmsSnapshot(root, snapshot, async (stage) => {
      assert.equal(await readFile(path.join(stage, 'src/content/posts/über.md'), 'utf8'), REFERENCES['src/content/posts/über.md']);
      assert.deepEqual((await cmsSources(stage)).sources, snapshot.sources);
    });
  });
});

test('reading a listed file stays inside the project and refuses links', async (context) => {
  await project(REFERENCES, async (root) => {
    for (const file of ['../outside.js', 'src/../../outside.js', 'src/.env', 'package.json', '/etc/hosts', 'src//x.css']) {
      await assert.rejects(() => readListedSource(root, file, MAX_SOURCE), /Invalid project path/, file);
    }
    await assert.rejects(() => readListedSource(root, 'public/vendor/bundle.js', MAX_SOURCE), /limit/);
    // Windows needs a privilege to make links.
    if (process.platform === 'win32') {
      context.diagnostic('links are not checked on Windows');
      return;
    }
    await symlink(tmpdir(), path.join(root, 'src/linked'));
    await assert.rejects(() => readListedSource(root, 'src/linked/anything.css', MAX_SOURCE), /Symbolic links/);
  });
});

test('the demo bake leaves out the files its project list leaves out', async () => {
  await project(SITE, async (root) => {
    const sources = await readSources(root, []);
    assert.ok(sources.ok);
    assert.deepEqual(Object.keys(sources.value).sort(), ['src/components/Card.astro', 'src/pages/index.astro', 'src/styles/site.css']);
  });
});
