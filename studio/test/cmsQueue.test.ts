// Goal: reading content schemas cannot block other editors' saves or heartbeats.
// Method: hold a real content-config child behind a file gate, then acquire the
// project writer queue before releasing the child. The captured catalog stays immutable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, access, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { cmsFixture } from './cmsFixture';

test('CMS inspection releases the project queue before executing project code', async () => {
  const control = await mkdtemp(path.join(tmpdir(), 'studio-cms-gate-'));
  const entered = path.join(control, 'entered');
  const release = path.join(control, 'release');
  const source = [
    'import { writeFileSync, existsSync } from "node:fs";',
    `writeFileSync(${JSON.stringify(entered)}, "ready");`,
    'for (let attempt = 0; attempt < 1500; attempt++) {',
    `  if (existsSync(${JSON.stringify(release)})) break;`,
    '  await new Promise(resolve => setTimeout(resolve, 10));',
    '}',
    'export const collections = {};',
  ].join('\n');
  const fixture = await cmsFixture({ 'src/content.config.ts': source });
  const reading = fixture.post('content:collections', 'studio');
  try {
    let started = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      started = await access(entered).then(
        () => true,
        () => false,
      );
      if (started) {
        break;
      }
      await delay(10);
    }
    assert.ok(started, 'The content config is executing in its isolated child');
    const result = await Promise.race([fixture.rooms.coordinator.run(async () => 'available'), delay(1000).then(() => 'blocked')]);
    assert.equal(result, 'available', 'CMS reads must not retain the shared writer queue');
  } finally {
    await writeFile(release, 'continue');
    const response = await reading;
    await fixture.close();
    await rm(control, { recursive: true, force: true });
    assert.equal(response['error'], undefined);
  }
});
