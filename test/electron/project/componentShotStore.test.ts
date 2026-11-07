// Goal: the on-disk cache of component photographs only ever hands out what passed the parser, goes stale
// when the project changes, and keeps old pictures readable until new ones replace them.
// Methodology: a real cache folder and a real small project under node_modules/.stacki-test. Write and
// read back; corrupt the meta file in each way; change a project file and watch the fingerprint; read an
// image through the meta and through a name the meta does not hold.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  readShotImage,
  readShotMeta,
  shotFileName,
  pruneShotImages,
  shotsDirectory,
  writeShotImage,
  writeShotMeta,
} from '#dist/electron/project/componentShotStore.js';
import { fingerprint } from '#dist/electron/project/thumbs.js';

// Stale means no meta, or a meta written for other files than the project has now.
function isStale(userData: string, project: string): boolean {
  const meta = readShotMeta(userData, project);
  return meta === undefined || meta.fingerprint !== fingerprint(project);
}

const root = path.join(process.cwd(), 'node_modules', '.stacki-test', 'shot-store');

function freshProject(name: string): { readonly project: string; readonly userData: string } {
  const base = path.join(root, name);
  fs.rmSync(base, { recursive: true, force: true });
  const project = path.join(base, 'site');
  fs.mkdirSync(path.join(project, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'components', 'Hero.astro'), '<section />');
  return { project, userData: path.join(base, 'userData') };
}

const component = (project: string) => path.join(project, 'src', 'components', 'Hero.astro');

test('file names are stable per component, distinct between components, and valid for the parser', () => {
  assert.equal(shotFileName('/a/Hero.astro'), shotFileName('/a/Hero.astro'));
  assert.notEqual(shotFileName('/a/Hero.astro'), shotFileName('/a/Faq.astro'));
  assert.match(shotFileName('/a/Hero.astro'), /^[0-9a-f]{16}\.jpg$/);
});

test('a meta written is a meta read, and an image is served through it as a JPEG data URL', () => {
  const { project, userData } = freshProject('roundtrip');
  assert.equal(readShotMeta(userData, project), undefined, 'no cache yet');
  const file = shotFileName(component(project));
  writeShotImage(userData, project, file, Uint8Array.from([1, 2, 3]));
  const meta = {
    version: 1 as const,
    fingerprint: fingerprint(project),
    capturedAt: 5,
    shots: [{ component: component(project), file, width: 1440, height: 800 }],
  };
  writeShotMeta(userData, project, meta);
  assert.deepEqual(readShotMeta(userData, project), meta);
  assert.equal(readShotImage(userData, project, component(project)), 'data:image/jpeg;base64,AQID');
  assert.equal(readShotImage(userData, project, '/elsewhere/Faq.astro'), undefined, 'a component the meta does not hold');
  assert.equal(isStale(userData, project), false);
});

test('a project change makes the cache stale, and the old pictures stay readable', () => {
  const { project, userData } = freshProject('stale');
  const file = shotFileName(component(project));
  writeShotImage(userData, project, file, Uint8Array.from([9]));
  writeShotMeta(userData, project, {
    version: 1,
    fingerprint: fingerprint(project),
    capturedAt: 1,
    shots: [{ component: component(project), file, width: 1440, height: 10 + 20 }],
  });
  fs.writeFileSync(component(project), '<section>changed</section>');
  assert.equal(isStale(userData, project), true);
  assert.ok(readShotImage(userData, project, component(project)), 'stale pictures are still served until new ones are made');
});

test('a run that never completed is stale, and so is a missing cache', () => {
  const { project, userData } = freshProject('incomplete');
  assert.equal(isStale(userData, project), true);
  writeShotMeta(userData, project, { version: 1, fingerprint: '', capturedAt: 1, shots: [] });
  assert.equal(isStale(userData, project), true);
});

test('negative space: a meta that is not valid reads as an empty cache, whatever is wrong with it', () => {
  const { project, userData } = freshProject('corrupt');
  const directory = shotsDirectory(userData, project);
  fs.mkdirSync(directory, { recursive: true });
  const metaFile = path.join(directory, 'meta.json');
  const good = {
    version: 1,
    fingerprint: 'a'.repeat(40),
    capturedAt: 1,
    shots: [{ component: component(project), file: '0123456789abcdef.jpg', width: 1440, height: 10 }],
  };
  const bad = [
    '',
    '{',
    'null',
    '[]',
    JSON.stringify({ ...good, version: 9 }),
    JSON.stringify({ ...good, shots: [{ ...good.shots[0], file: '../../etc/passwd' }] }),
  ];
  for (const text of bad) {
    fs.writeFileSync(metaFile, text);
    assert.equal(readShotMeta(userData, project), undefined, text);
    assert.equal(readShotImage(userData, project, component(project)), undefined, text);
    assert.equal(isStale(userData, project), true, text);
  }
  fs.writeFileSync(metaFile, JSON.stringify(good));
  assert.ok(readShotMeta(userData, project));
});

test('an image the meta names but the disk lost is absent, not an error', () => {
  const { project, userData } = freshProject('lost');
  writeShotMeta(userData, project, {
    version: 1,
    fingerprint: 'a'.repeat(40),
    capturedAt: 1,
    shots: [{ component: component(project), file: '0123456789abcdef.jpg', width: 1440, height: 10 }],
  });
  assert.equal(readShotImage(userData, project, component(project)), undefined);
});

test('writing a meta that does not parse is refused, and leaves the old one', () => {
  const { project, userData } = freshProject('refuse');
  const first = { version: 1 as const, fingerprint: '', capturedAt: 1, shots: [] };
  writeShotMeta(userData, project, first);
  assert.throws(() => writeShotMeta(userData, project, { ...first, fingerprint: 'zz' }), /hexadecimal/);
  assert.deepEqual(readShotMeta(userData, project), first);
});

test('pruning deletes photographs the meta no longer names, and only files named like photographs', () => {
  const { project, userData } = freshProject('prune');
  const kept = shotFileName(component(project));
  const dropped = 'fedcba9876543210.jpg';
  writeShotImage(userData, project, kept, Uint8Array.from([1]));
  writeShotImage(userData, project, dropped, Uint8Array.from([2]));
  const directory = shotsDirectory(userData, project);
  fs.writeFileSync(path.join(directory, 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(directory, 'UPPER0123456789.jpg'), 'mine');
  const meta = { version: 1 as const, fingerprint: '', capturedAt: 1, shots: [{ component: component(project), file: kept, width: 1440, height: 10 }] };
  writeShotMeta(userData, project, meta);
  pruneShotImages(userData, project, meta);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['UPPER0123456789.jpg', kept, 'meta.json', 'notes.txt'].sort());
});

test('pruning a folder that does not exist is nothing', () => {
  const { project, userData } = freshProject('prune-none');
  assert.doesNotThrow(() => pruneShotImages(userData, project, { version: 1, fingerprint: '', capturedAt: 1, shots: [] }));
});
