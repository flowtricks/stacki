// Goal: source maps cannot block Cloudflare uploads, while oversized runtime assets still fail.
// Method: run Wrangler's actual dry-run asset validation against bounded temporary files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { prepareCloudflareAssets } from '../scripts/cloudflareAssets';

const assetBytesMax = 25 * 1024 * 1024;
const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

test('Cloudflare excludes oversized maps but still validates runtime asset sizes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-cloudflare-assets-'));
  const assets = path.join(root, 'assets');
  try {
    await mkdir(path.join(assets, 'nested'), { recursive: true });
    await writeFile(path.join(assets, 'studio.js'), 'console.log("editor");');
    await writeFile(path.join(assets, 'studio.css'), 'body { margin: 0; }');
    await writeFile(
      path.join(root, 'wrangler.json'),
      JSON.stringify({
        name: 'studio-assets-test',
        compatibility_date: '2026-10-16',
        assets: { directory: './assets' },
      }),
    );
    await oversizedAsset(path.join(assets, 'studio.js.map'));
    await oversizedAsset(path.join(assets, 'nested/studio.css.map'));
    const before = validateAssets(root);
    assert.notEqual(before.status, 0);
    assert.match(before.stdout + before.stderr, /25 MiB/);

    await prepareCloudflareAssets(assets);
    const after = validateAssets(root);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.equal((await stat(path.join(assets, 'studio.js.map'))).size, assetBytesMax + 1);
    assert.equal((await stat(path.join(assets, 'nested/studio.css.map'))).size, assetBytesMax + 1);

    await oversizedAsset(path.join(assets, 'studio.js'));
    const runtime = validateAssets(root);
    assert.notEqual(runtime.status, 0);
    assert.match(runtime.stdout + runtime.stderr, /studio\.js/);
    assert.match(runtime.stdout + runtime.stderr, /25 MiB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function oversizedAsset(filename: string): Promise<void> {
  const file = await open(filename, 'w');
  try {
    await file.truncate(assetBytesMax + 1);
  } finally {
    await file.close();
  }
}

function validateAssets(root: string) {
  return spawnSync(process.execPath, [wrangler, 'deploy', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
}
