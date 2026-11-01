// Goal: Astro route discovery must survive a save finishing during its scan.
// Method: run Astro's real route builder on a scratch page, forcing a lock
// removal or atomic rename between directory enumeration and the first stat.
// This reproduces the Windows timing deterministically on every platform.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { resolveConfig } from '../../../studio/node_modules/astro/dist/core/config/index.js';
import * as settings from '../../../studio/node_modules/astro/dist/core/config/settings.js';
import { AstroLogger } from '../../../studio/node_modules/astro/dist/core/logger/core.js';
import * as routing from '../../../studio/node_modules/astro/dist/core/routing/create-manifest.js';
import { NodeDocumentDisk } from '#dist/electron/documents/documentDisk.js';
import { replaceFileAtomic } from '#dist/electron/documents/atomicWrite.js';
import { toFilePath } from '#dist/shared/core/brand.js';

const SOURCE = '<section><p>Before</p></section>\n';
const logger = new AstroLogger({ level: 'silent', destination: { write: () => {} } });

async function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-astro-save-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  const pages = path.join(root, 'src', 'pages');
  fs.mkdirSync(pages, { recursive: true });
  const file = toFilePath(path.join(pages, 'index.astro'));
  fs.writeFileSync(file, SOURCE);
  const { astroConfig } = await resolveConfig({ root, configFile: false, logLevel: 'silent' }, 'dev');
  return { file, pages, settings: settings.createBaseSettings(astroConfig, 'silent') };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function scanDuringRemoval(context: TestContext, site: Fixture, remove: () => void) {
  const stat = fs.statSync;
  let removed = false;
  const patched = context.mock.method(fs, 'statSync', (file: fs.PathLike) => {
    if (!removed) {
      if (path.dirname(String(file)) === site.pages) {
        removed = true;
        remove();
      }
    }
    return stat(file);
  });
  try {
    // Astro walks synchronously before awaiting each route's source read.
    const routes = routing.createRoutesList({ settings: site.settings }, logger, { dev: true });
    assert.equal(removed, true, 'the save finishes after Astro enumerates the page directory');
    return routes;
  } finally {
    patched.mock.restore();
  }
}

test('Astro can scan while a document lock disappears', async (context) => {
  const site = await fixture(context);
  const disk = new NodeDocumentDisk();
  const locked = disk.lock(site.file);
  assert.ok(locked.ok);
  const routes = await scanDuringRemoval(context, site, () => {
    assert.ok(disk.unlock(locked.value).ok);
  });
  assert.ok(routes.routes.some((route) => route.route === '/'));
  assert.equal(fs.readFileSync(site.file, 'utf8'), SOURCE);
});

test('Astro can scan across text, grid insertion, and grid removal saves', async (context) => {
  const site = await fixture(context);
  const versions = ['<section><p>After</p></section>\n', '<section><div class="grid"><p>After</p></div></section>\n', '<section><p>After</p></section>\n'];
  for (const source of versions) {
    const rename = fs.renameSync;
    let scan: ReturnType<typeof routing.createRoutesList> | undefined;
    const patched = context.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      scan = scanDuringRemoval(context, site, () => rename(from, to));
    });
    try {
      assert.ok(replaceFileAtomic(site.file, Buffer.from(source)).ok);
      assert.ok(scan);
      const routes = await scan;
      assert.ok(routes.routes.some((route) => route.route === '/'));
      assert.equal(fs.readFileSync(site.file, 'utf8'), source);
    } finally {
      patched.mock.restore();
    }
  }
});
