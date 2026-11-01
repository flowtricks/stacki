// Goal: the preview bridge contract of step 7 (plan §9) holds end to end.
//   - Source markers exist only in memory: the dev plugin's marked copy of a
//     file is a module Vite compiles, and no byte of it — no node marker, no
//     stamp — is ever written into the project.
//   - A canvas rendering carries a token: the digest of the sorted manifest of
//     every file that rendered, each with the checksum of the bytes it was
//     marked from. A rendering is current only while the disk still holds all
//     of them: a component edit makes the page's rendering stale although the
//     page's own bytes never changed, and an unrelated page's edit does not.
// Method: the wire parsers get known-good and known-bad shapes (stamps,
// manifests, renderings, verdicts). Then a temporary project runs through the
// real generated preview config — writeMarkerConfig from the windowless main
// harness, the config module imported as Astro would, its marker plugin's
// `load` called on each file — with every project byte snapshotted before and
// compared after. The stamps that load emits become the rendering the frame
// would announce, and the real `preview:check` handler judges it as files
// change on disk. A static inventory closes the loop: the marking module is
// imported by nothing, and only it calls the marked serializers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mainHarness } from '../../helpers/mainHarness.ts';
import {
  canonicalManifest,
  judgePreviewRender,
  judgeShownFile,
  judgeEventToken,
  manifestOf,
  parsePreviewRender,
  parsePreviewVerdict,
  parseStampData,
  PREVIEW_STALE_REASONS,
  describePreviewStale,
  stampComment,
  type PreviewRender,
  type PreviewStamp,
  type StampedFileState,
} from '#dist/shared/page/previewToken.js';
import { toDigest } from '#dist/shared/core/brand.js';
import { LIMITS } from '#dist/shared/core/limits.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const firstDigest = toDigest('a'.repeat(64));
const secondDigest = toDigest('b'.repeat(64));

function renderOf(stamps: readonly PreviewStamp[]): PreviewRender {
  const manifest = manifestOf(stamps);
  assert.ok(manifest.ok, 'the stamps form a manifest');
  return { token: toDigest(sha256(canonicalManifest(manifest.value))), stamps: manifest.value };
}

test('a stamp is written and read back; anything else in a comment is not one', () => {
  const stamp = { file: 'src/components/Card.astro', checksum: firstDigest };
  const comment = stampComment(stamp);
  assert.equal(comment, `<!--avb-d:${firstDigest}:src/components/Card.astro-->`);
  assert.deepEqual(parseStampData(comment.slice(4, -3)), stamp);
  // Page code can write any comment it likes; none of these is a stamp.
  for (const data of [
    'avb-s:0.1',
    `avb-d:${firstDigest}`,
    `avb-d:${firstDigest.toUpperCase()}:src/a.astro`,
    `avb-d:${'a'.repeat(63)}:src/a.astro`,
    `avb-d:${firstDigest}:`,
    `avb-d:${firstDigest}:/etc/passwd`,
    `avb-d:${firstDigest}:C:/x.astro`,
    `avb-d:${firstDigest}:src/../../x.astro`,
    `avb-d:${firstDigest}:src//x.astro`,
    `avb-d:${firstDigest}:src\\x.astro`,
    `avb-d:${firstDigest}:src/x.astro\n`,
    `avb-d:${firstDigest}:${'x'.repeat(LIMITS.previewStampPathCharsMax + 1)}`,
  ]) {
    assert.equal(parseStampData(data), undefined, JSON.stringify(data));
  }
  assert.throws(() => stampComment({ file: '../x.astro', checksum: firstDigest }), /project-relative/);
  assert.throws(() => stampComment({ file: 'a-->b.astro', checksum: firstDigest }), /project-relative/);
});

test('a manifest is sorted, one entry per file, and refuses a rendering of two versions', () => {
  const card = { file: 'src/components/Card.astro', checksum: firstDigest };
  const page = { file: 'src/pages/index.astro', checksum: secondDigest };
  // Every rendered copy of a component stamps the same entry.
  const manifest = manifestOf([page, card, card, card]);
  assert.deepEqual(manifest, { ok: true, value: [card, page] });
  assert.deepEqual(manifestOf([card, { ...card, checksum: secondDigest }]), {
    ok: false,
    error: 'conflicting-stamps',
  });
  const many = Array.from({ length: LIMITS.previewManifestFilesMax + 1 }, (_, index) => ({
    file: `src/components/C${index}.astro`,
    checksum: firstDigest,
  }));
  assert.deepEqual(manifestOf(many), { ok: false, error: 'too-many-files' });
  assert.equal(manifestOf(many.slice(1)).ok, true, 'the bound itself is allowed');
  const copies = Array.from({ length: LIMITS.previewMarkersMax + 1 }, () => card);
  assert.deepEqual(manifestOf(copies), { ok: false, error: 'too-many-files' });
  assert.equal(canonicalManifest([card, page]), `${firstDigest} src/components/Card.astro\n${secondDigest} src/pages/index.astro\n`);
  assert.throws(() => canonicalManifest([page, card]), /sorted/);
});

test('a rendering parses when well formed and fails at the field that is wrong', () => {
  const good = renderOf([
    { file: 'src/pages/index.astro', checksum: secondDigest },
    { file: 'src/components/Card.astro', checksum: firstDigest },
  ]);
  assert.deepEqual(parsePreviewRender(JSON.parse(JSON.stringify(good))), good);
  const bad: readonly [unknown, RegExp][] = [
    [jsonNull, /expected object/],
    [[], /expected object/],
    [{ ...good, token: 'nope' }, /Digest/],
    [{ ...good, token: undefined }, /token/],
    [{ ...good, stamps: {} }, /expected list/],
    [{ ...good, stamps: [...good.stamps].reverse() }, /sorted/],
    [{ ...good, stamps: [good.stamps[0], good.stamps[0]] }, /sorted/],
    [{ ...good, stamps: [{ file: '/abs.astro', checksum: firstDigest }] }, /absolute/],
    [{ ...good, stamps: [{ file: 'src/a.astro', checksum: 'x' }] }, /Digest/],
    [{ ...good, stamps: [{ file: 7, checksum: firstDigest }] }, /file/],
    [
      {
        ...good,
        stamps: Array.from({ length: LIMITS.previewManifestFilesMax + 1 }, (_, i) => ({
          file: `src/c${String(i).padStart(4, '0')}.astro`,
          checksum: firstDigest,
        })),
      },
      /exceeds limit/,
    ],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parsePreviewRender(input), message, JSON.stringify(input)?.slice(0, 80));
  }
});

test('the judge: token first, then every stamped file, each state named', () => {
  const render = renderOf([
    { file: 'src/components/Card.astro', checksum: firstDigest },
    { file: 'src/pages/index.astro', checksum: secondDigest },
  ]);
  const tokenOf = (text: string) => toDigest(sha256(text));
  const present = (checksum: typeof firstDigest): StampedFileState => ({
    tag: 'present',
    checksum,
  });
  const now = (card: StampedFileState, page: StampedFileState) =>
    new Map<string, StampedFileState>([
      ['src/components/Card.astro', card],
      ['src/pages/index.astro', page],
    ]);
  assert.deepEqual(judgePreviewRender(render, now(present(firstDigest), present(secondDigest)), tokenOf), {
    tag: 'current',
  });
  assert.deepEqual(judgePreviewRender(render, now(present(secondDigest), present(secondDigest)), tokenOf), {
    tag: 'stale',
    reason: 'file-changed',
    file: 'src/components/Card.astro',
  });
  assert.deepEqual(judgePreviewRender(render, now({ tag: 'missing' }, present(secondDigest)), tokenOf), {
    tag: 'stale',
    reason: 'file-missing',
    file: 'src/components/Card.astro',
  });
  assert.deepEqual(judgePreviewRender(render, now(present(firstDigest), { tag: 'over-limit' }), tokenOf), {
    tag: 'stale',
    reason: 'file-changed',
    file: 'src/pages/index.astro',
  });
  // A token that is not the manifest's digest vouches for nothing.
  const forged = { ...render, token: firstDigest };
  assert.deepEqual(judgePreviewRender(forged, now(present(firstDigest), present(secondDigest)), tokenOf), {
    tag: 'stale',
    reason: 'token-mismatch',
    file: undefined,
  });
  // Main must have read every stamped file: a missing entry is a bug.
  assert.throws(() => judgePreviewRender(render, new Map(), tokenOf), /read every stamped file/);
});

test('the event token and the shown file', () => {
  const render = renderOf([{ file: 'src/pages/index.astro', checksum: secondDigest }]);
  assert.deepEqual(judgeEventToken(render.token, render), { tag: 'current' });
  assert.equal(judgeEventToken(firstDigest, render).tag, 'stale');
  assert.deepEqual(judgeEventToken(firstDigest, render), {
    tag: 'stale',
    reason: 'superseded',
    file: undefined,
  });
  assert.deepEqual(judgeEventToken(undefined, render).tag, 'stale');
  assert.deepEqual(judgeEventToken(render.token, undefined), {
    tag: 'stale',
    reason: 'no-render',
    file: undefined,
  });
  assert.deepEqual(judgeShownFile(render, 'src/pages/index.astro', secondDigest), {
    tag: 'current',
  });
  assert.deepEqual(judgeShownFile(render, 'src/pages/index.astro', firstDigest), {
    tag: 'stale',
    reason: 'shown-page-differs',
    file: 'src/pages/index.astro',
  });
  assert.equal(judgeShownFile(render, 'src/pages/index.astro', undefined).tag, 'stale');
  assert.deepEqual(judgeShownFile(render, 'src/pages/about.astro', secondDigest), {
    tag: 'stale',
    reason: 'unstamped-file',
    file: 'src/pages/about.astro',
  });
});

test('verdicts cross the wire intact, and every reason has its own notice', () => {
  for (const reason of PREVIEW_STALE_REASONS) {
    const verdict = { tag: 'stale', reason, file: 'src/pages/index.astro' };
    assert.deepEqual(parsePreviewVerdict(verdict), verdict);
    assert.deepEqual(parsePreviewVerdict({ tag: 'stale', reason }), {
      tag: 'stale',
      reason,
      file: undefined,
    });
  }
  assert.deepEqual(parsePreviewVerdict({ tag: 'current' }), { tag: 'current' });
  assert.throws(() => parsePreviewVerdict({ tag: 'fresh' }), /tag/);
  assert.throws(() => parsePreviewVerdict({ tag: 'stale', reason: 'old' }), /reason/);
  assert.throws(() => parsePreviewVerdict({ tag: 'stale', reason: 'superseded', file: '../x' }), /file/);
  assert.equal(new Set(PREVIEW_STALE_REASONS.map(describePreviewStale)).size, PREVIEW_STALE_REASONS.length);
});

// --- End to end ---------------------------------------------------------------

const PAGE = `---
import Card from '../components/Card.astro';
---
<main>
  <h1>Home</h1>
  <Card title="One" />
  <Card title="Two" />
</main>
`;
const CARD = `---
const { title } = Astro.props;
---
<article class="card"><h2>{title}</h2></article>
`;
const OTHER = `---
---
<p>About</p>
`;

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-preview-bridge-')));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), PAGE);
  fs.writeFileSync(path.join(root, 'src/pages/about.astro'), OTHER);
  fs.writeFileSync(path.join(root, 'src/components/Card.astro'), CARD);
  return root;
}

/** Every file under `root` but the app's own scaffolding, with its bytes. */
function snapshot(root: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    assert.ok(directory !== undefined);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel === 'node_modules/.avb' || rel === 'user') {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        out.set(rel, sha256(fs.readFileSync(full)));
      }
    }
  }
  return out;
}

const STAMP = /<!--(avb-d:[^>]*?)-->/g;

function stampsIn(code: string): PreviewStamp[] {
  return [...code.matchAll(STAMP)].map((match) => {
    const stamp = parseStampData(match[1] ?? '');
    assert.ok(stamp !== undefined, `a well-formed stamp: ${match[0]}`);
    return stamp;
  });
}

test('markers live in memory only; the token follows the rendering chain', async () => {
  const root = project();
  const harness = mainHarness(path.join(root, 'user'));
  try {
    const before = snapshot(root);
    const configPath = harness.call('writeMarkerConfig', root);
    assert.equal(typeof configPath, 'string', 'the generated config parses');
    assert.ok(typeof configPath === 'string');
    assert.ok(
      path.relative(path.join(root, 'node_modules', '.avb'), configPath).split(path.sep)[0] !== '..',
      'the generated config lives in node_modules/.avb, outside the project source',
    );
    const module: unknown = await import(pathToFileURL(configPath).href);
    assert.ok(typeof module === 'object' && module !== null && 'default' in module);
    const plugin = markerPlugin(module.default, 'avb-node-markers');
    // The canvas patcher, as the config serves it: its bounds are LIMITS'.
    const patcher = markerPlugin(module.default, 'avb-morph').load('\0virtual:avb-morph');
    assert.equal(typeof patcher, 'string');
    assert.ok(
      String(patcher).startsWith(
        'const AVB_PREVIEW_LIMITS = Object.freeze(' +
          JSON.stringify({
            previewMarkersMax: LIMITS.previewMarkersMax,
            previewMorphWorkMax: LIMITS.previewMorphWorkMax,
          }) +
          ');\n',
      ),
      'the served patcher opens with the bounds from shared/core/limits.ts',
    );
    const load = (rel: string): string => {
      const code = plugin.load(path.join(root, ...rel.split('/')));
      assert.equal(typeof code, 'string', `${rel} is marked`);
      assert.ok(typeof code === 'string');
      return code;
    };
    const page = load('src/pages/index.astro');
    const card = load('src/components/Card.astro');
    assert.match(page, /<!--avb-s:0-->/, 'the page is marked');
    assert.match(card, /src\/components\/Card\.astro\|0/, 'a component marks in its own namespace');
    assert.deepEqual(stampsIn(page), [{ file: 'src/pages/index.astro', checksum: sha256(PAGE) }]);
    assert.deepEqual(stampsIn(card), [{ file: 'src/components/Card.astro', checksum: sha256(CARD) }]);
    assert.match(
      card,
      /data-avb-d=\{\["avb-d:[0-9a-f]{64}:src\/components\/Card\.astro",/,
      'the stamp also rides on root markup when project code strips comments',
    );
    // No marker reached the project: every byte of it is what it was, and the
    // files on disk carry no marker at all.
    assert.deepEqual(snapshot(root), before, 'marking wrote nothing into the project');
    for (const rel of before.keys()) {
      const text = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.doesNotMatch(text, /avb-[sed]:|data-avb-[pd]/, `${rel} holds no preview marker`);
    }

    // The rendering the frame would announce: the page and two copies of the card.
    const render = renderOf([...stampsIn(page), ...stampsIn(card), ...stampsIn(card)]);
    await judgeAsFilesChange(harness, root, render);
  } finally {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** The real `preview:check` handler, as files change under one rendering. */
async function judgeAsFilesChange(harness: ReturnType<typeof mainHarness>, root: string, render: PreviewRender): Promise<void> {
  const check = async () => parsePreviewVerdict(await harness.invoke('preview:check', { projectPath: root, render }));
  assert.deepEqual(await check(), { tag: 'current' });

  // Direction one: a component edit makes the page's rendering stale, though
  // the page's own bytes are unchanged.
  const cardFile = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(cardFile, CARD.replace('card', 'card is-new'));
  assert.equal(sha256(fs.readFileSync(path.join(root, 'src/pages/index.astro'))), sha256(PAGE));
  assert.deepEqual(await check(), {
    tag: 'stale',
    reason: 'file-changed',
    file: 'src/components/Card.astro',
  });
  fs.writeFileSync(cardFile, CARD);
  assert.deepEqual(await check(), { tag: 'current' }, 'the same bytes are current again');

  // Direction two: an unrelated page's edit leaves it current — the manifest
  // names only what rendered.
  fs.writeFileSync(path.join(root, 'src/pages/about.astro'), OTHER.replace('About', 'Team'));
  assert.deepEqual(await check(), { tag: 'current' });

  // And the page itself, and a component that is gone.
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), PAGE.replace('Home', 'Start'));
  assert.equal((await check()).tag, 'stale');
  fs.writeFileSync(path.join(root, 'src/pages/index.astro'), PAGE);
  fs.rmSync(cardFile);
  assert.deepEqual(await check(), {
    tag: 'stale',
    reason: 'file-missing',
    file: 'src/components/Card.astro',
  });
  fs.writeFileSync(cardFile, CARD);

  // Page code can forge a stamp; one pointing out of the project reads as
  // missing, never as a file somewhere else on disk.
  const outside = path.join(path.dirname(root), 'outside.astro');
  const escaped = {
    token: firstDigest,
    stamps: [{ file: 'src/../../outside.astro', checksum: firstDigest }],
  };
  await assert.rejects(
    () => harness.invoke('preview:check', { projectPath: root, render: escaped }),
    /not normalized/,
    'the payload parser refuses the path before any read',
  );
  assert.equal(fs.existsSync(outside), false);
  // A token that does not match its manifest vouches for nothing.
  const forged = { ...render, token: firstDigest };
  assert.deepEqual(parsePreviewVerdict(await harness.invoke('preview:check', { projectPath: root, render: forged })), {
    tag: 'stale',
    reason: 'token-mismatch',
    file: undefined,
  });
}

interface MarkerPlugin {
  readonly load: (id: string) => unknown;
}

function markerPlugin(config: unknown, name: string): MarkerPlugin {
  assert.ok(typeof config === 'object' && config !== null && 'vite' in config);
  const vite: unknown = config.vite;
  assert.ok(typeof vite === 'object' && vite !== null && 'plugins' in vite);
  const plugins: unknown = vite.plugins;
  assert.ok(Array.isArray(plugins));
  const found: unknown = plugins.find((plugin: unknown) => typeof plugin === 'object' && plugin !== null && 'name' in plugin && plugin.name === name);
  assert.ok(typeof found === 'object' && found !== null && 'load' in found);
  const load: unknown = found.load;
  assert.ok(typeof load === 'function');
  return {
    load: (id) => {
      const code: unknown = Reflect.apply(load, found, [id]);
      return code;
    },
  };
}

// --- Static inventory ---------------------------------------------------------

function sources(directory: string): readonly string[] {
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => path.join(directory, file));
}

test('only the marking module makes markers, and nothing imports it', () => {
  const all = [...sources('electron'), ...sources('src'), ...sources('shared')];
  const importers = all.filter((file) =>
    // Any specifier ending in the module's name, from any folder.
    /from\s+['"][^'"]*\/previewMarkers(\.js)?['"]/.test(fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(importers, [], 'the dev plugin requires it by path; no app module imports it');
  const callers = all.filter((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return /\b(serializePageMarked|markChunkHtml)\s*\(/.test(text.replace(/^\s*(\/\/|\*).*$/gm, ''));
  });
  assert.deepEqual(
    callers.map((file) => file.split(path.sep).join('/')).sort(),
    ['electron/parse/astroChunks.ts', 'electron/parse/astroParser.ts', 'electron/previewServer/previewMarkers.ts'],
    'the marked serializers are defined in the parser (markChunkHtml in its chunks module) ' + 'and called only by the marking module',
  );
  const marking = fs.readFileSync('electron/previewServer/previewMarkers.ts', 'utf8');
  assert.doesNotMatch(
    marking,
    /\b(writeFileSync|writeFile|appendFileSync|renameSync|createWriteStream|replaceFileAtomic)\b/,
    'the marking module reads and returns; it never writes',
  );
});
