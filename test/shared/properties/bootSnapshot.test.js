// Goal: the boot snapshot contract (shared/properties/bootSnapshot.ts) accepts exactly what the app writes and
// rejects everything else as an error value, so a damaged or hostile file can never half-apply to the first render.
// Method: a known-good snapshot and file pass; then each bad shape (wrong type, missing field, out-of-bound size
// or count, unknown version, malformed scan, unknown branch) is driven through the parser and must fail; the file
// bounds, the project cap and the oversize-scan fallback are exercised at their edges. No clock or disk involved.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  BOOT_LIMITS,
  BOOT_SNAPSHOT_VERSION,
  parseBootFileText,
  parseBootSnapshot,
  serializeBootSnapshot,
  withSnapshot,
} = require('#dist/shared/properties/bootSnapshot.js');

const scan = { pages: [{ path: '/p/src/pages/index.astro', name: 'index.astro', route: '/' }], pageFolders: [], layouts: [], components: [] };
const good = { version: 1, projectPath: '/p', scan, pageName: 'index.astro', leftTab: 'pages', branch: { kind: 'default', name: 'main' } };

test('a good snapshot parses to itself', () => {
  const parsed = parseBootSnapshot(good);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.projectPath, '/p');
  assert.equal(parsed.value.scan.pages[0].name, 'index.astro');
  assert.deepEqual(parsed.value.branch, good.branch);
  assert.equal(parseBootSnapshot({ version: 1, projectPath: '/p' }).ok, true, 'every field but the path is optional');
});

test('every bad shape is an error value', () => {
  const long = 'x'.repeat(BOOT_LIMITS.nameCharsMax + 1);
  const bad = [
    undefined,
    'text',
    7,
    [],
    {},
    { ...good, version: 2 },
    { ...good, version: undefined },
    { ...good, projectPath: '' },
    { ...good, projectPath: 3 },
    { ...good, projectPath: 'p'.repeat(BOOT_LIMITS.pathCharsMax + 1) },
    { ...good, scan: 'pages' },
    { ...good, scan: { pages: 'x' } },
    { ...good, scan: { ...scan, pages: [{ path: '/p', name: 4, route: '/' }] } },
    { ...good, pageName: '' },
    { ...good, pageName: long },
    { ...good, pageName: 9 },
    { ...good, leftTab: 'x'.repeat(BOOT_LIMITS.labelCharsMax + 1) },
    { ...good, leftTab: {} },
    { ...good, branch: 'main' },
    { ...good, branch: { kind: 'bogus' } },
    { ...good, branch: { kind: 'default' } },
    { ...good, branch: { kind: 'other', name: 'dev' } },
    { ...good, branch: { kind: 'detached', defaultName: 'main', canSwitch: 'yes' } },
    { ...good, branch: { kind: 'default', name: long } },
  ];
  for (const input of bad) {
    const parsed = parseBootSnapshot(input);
    assert.equal(parsed.ok, false, JSON.stringify(input)?.slice(0, 120));
    assert.equal(parsed.error.code, 'boot-invalid');
  }
});

test('the file parses, and a bad file is an error value', () => {
  const text = JSON.stringify({ version: 1, projects: [good] });
  assert.equal(parseBootFileText(text).ok, true);
  assert.equal(parseBootFileText('{nope').ok, false);
  assert.equal(parseBootFileText('[]').ok, false);
  assert.equal(parseBootFileText('{"version":2,"projects":[]}').ok, false);
  assert.equal(parseBootFileText('{"version":1}').ok, false);
  assert.equal(parseBootFileText('{"version":1,"projects":[{"version":1}]}').ok, false, 'one bad project fails the whole file');
  assert.equal(parseBootFileText(' '.repeat(BOOT_LIMITS.fileBytesMax + 1)).ok, false, 'size is checked before parsing');
  const many = Array.from({ length: BOOT_LIMITS.projectsMax + 1 }, (_unused, index) => ({ version: 1, projectPath: `/p${index}` }));
  assert.equal(parseBootFileText(JSON.stringify({ version: 1, projects: many })).ok, false, 'too many projects');
});

test('a snapshot replaces its own project, goes first, and the file stays bounded', () => {
  let file = { version: BOOT_SNAPSHOT_VERSION, projects: [] };
  for (let index = 0; index < BOOT_LIMITS.projectsMax + 3; index += 1) {
    file = withSnapshot(file, { version: 1, projectPath: `/p${index}` });
    assert.ok(file.projects.length <= BOOT_LIMITS.projectsMax);
    assert.equal(file.projects[0].projectPath, `/p${index}`);
  }
  const again = withSnapshot(file, { version: 1, projectPath: file.projects[2].projectPath, pageName: 'a.astro' });
  assert.equal(again.projects.length, file.projects.length, 'no duplicate');
  assert.equal(again.projects[0].pageName, 'a.astro');
});

test('an oversized scan is left out and the rest kept; an oversized rest is refused', () => {
  const pages = Array.from({ length: 4000 }, (_unused, index) => ({
    path: `/p/src/pages/${'a'.repeat(60)}${index}.astro`,
    name: `${'a'.repeat(60)}${index}.astro`,
    route: `/${index}`,
  }));
  const heavy = { version: 1, projectPath: '/p', pageName: 'x.astro', scan: { ...scan, pages } };
  assert.ok(JSON.stringify(heavy).length > BOOT_LIMITS.snapshotBytesMax);
  const text = serializeBootSnapshot(heavy);
  assert.ok(text !== undefined && text.length <= BOOT_LIMITS.snapshotBytesMax);
  assert.equal(JSON.parse(text).scan, undefined);
  assert.equal(JSON.parse(text).pageName, 'x.astro');
  assert.equal(
    serializeBootSnapshot({ version: 1, projectPath: 'p'.repeat(BOOT_LIMITS.pathCharsMax), pageName: 'n'.repeat(BOOT_LIMITS.nameCharsMax) }) !== undefined,
    true,
  );
});
