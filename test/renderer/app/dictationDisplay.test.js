// Goal: the words and shortenings Settings → Dictation shows are right and bounded: a model is named for what it is, a
// long folder is cut in the middle (both ends kept) to a stated length and never longer, the commit hash is never part of a
// shown folder, and the status card reads one state from the store: loading until main answers, a running download over
// what the disk said, otherwise the chosen model's own install.
// Method: the real src/app/settings/dictationDisplay.ts, bundled with esbuild and called directly; known-good values, then
// the negative space (a path already short, the limit's edges, a bad limit that asserts, both path separators).
const test = require('node:test');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/dictation-display.cjs');
esbuild.buildSync({
  stdin: {
    contents: [
      "export * from './src/app/settings/dictationDisplay';",
      "export { WHISPER_MODELS } from './shared/properties/voice/whisperModels';",
      "export { ENGINE_NOT_INSTALLED } from './shared/properties/voice/dictationEngine';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const display = require(output);

test('a model is named for its family, size and precision', () => {
  assert.equal(display.modelDisplayName(display.WHISPER_MODELS.turbo), 'Whisper large v3 turbo, 4-bit');
  assert.equal(display.modelDisplayName(display.WHISPER_MODELS.small), 'Whisper small, 16-bit');
  assert.equal(display.modelDisplayName(display.WHISPER_MODELS.base), 'Whisper base, 16-bit');
  for (const model of Object.values(display.WHISPER_MODELS)) {
    assert.ok(!display.modelDisplayName(model).includes(model.revision), 'a name never carries the commit');
  }
});

test('the cards run quickest first and cover every model once', () => {
  assert.deepEqual([...display.QUALITY_ORDER], ['base', 'small', 'turbo']);
  assert.deepEqual([...display.QUALITY_ORDER].sort(), Object.keys(display.WHISPER_MODELS).sort());
});

test('a long path is cut in its middle to exactly the limit; a short one is left alone', () => {
  const folder = '/Users/designer/Library/Application Support/Stacki/models/whisper/turbo';
  const cut = display.shortenMiddle(folder, display.PATH_CHARS_SHOWN);
  assert.equal([...cut].length, display.PATH_CHARS_SHOWN);
  assert.match(cut, /^\/Users\/designer….*\/models\/whisper\/turbo$/u, 'the start and the end survive');
  assert.equal(display.shortenMiddle('/short/path', 44), '/short/path');
  assert.equal(display.shortenMiddle('x'.repeat(44), 44), 'x'.repeat(44), 'exactly the limit is not cut');
  assert.equal([...display.shortenMiddle('x'.repeat(45), 44)].length, 44, 'one past the limit is');
  assert.equal(display.shortenMiddle('日本語のフォルダー/モデル/whisper', 8).length, 8, 'counts characters, not UTF-16 units');
  assert.throws(() => display.shortenMiddle('abcdefghij', 4), /Assertion failed: shortenMiddle: the limit leaves room/);
  assert.throws(() => display.shortenMiddle('abcdefghij', 6.5), /Assertion failed: shortenMiddle: the limit is a whole number/);
});

test('a model folder is the models folder and the model, never its commit, with either separator', () => {
  assert.equal(display.modelFolder('/data/models/whisper', 'turbo'), '/data/models/whisper/turbo');
  assert.equal(display.modelFolder('/data/models/whisper/', 'base'), '/data/models/whisper/base');
  assert.equal(display.modelFolder('C:\\Users\\a\\models\\whisper', 'small'), 'C:\\Users\\a\\models\\whisper\\small');
  assert.throws(() => display.modelFolder('', 'turbo'), /Assertion failed: modelFolder/);
});

test('the status card reads one state: loading, a running download over the disk, then the chosen model', () => {
  const idle = display.ENGINE_NOT_INSTALLED;
  const snapshot = (fields) => ({ words: { vocabulary: [], snippets: [] }, engine: idle, status: undefined, model: 'turbo', language: 'auto', ...fields });
  const status = (turbo) => ({
    directory: '/d',
    models: [
      { id: 'turbo', install: turbo },
      { id: 'base', install: { kind: 'installed', sizeBytes: 5 } },
    ],
  });
  assert.deepEqual(display.dictationPageStatus(snapshot({})), { kind: 'loading' }, 'nothing is known before main answers');
  assert.deepEqual(display.dictationPageStatus(snapshot({ status: status({ kind: 'notInstalled' }) })), { kind: 'notInstalled' });
  assert.deepEqual(display.dictationPageStatus(snapshot({ status: status({ kind: 'partial', receivedBytes: 4, totalBytes: 9 }) })), {
    kind: 'partial',
    receivedBytes: 4,
    totalBytes: 9,
  });
  assert.deepEqual(display.dictationPageStatus(snapshot({ status: status({ kind: 'installed', sizeBytes: 9 }) })), { kind: 'ready', sizeBytes: 9 });
  assert.deepEqual(
    display.dictationPageStatus(snapshot({ model: 'base', status: status({ kind: 'notInstalled' }) })),
    { kind: 'ready', sizeBytes: 5 },
    'it follows the chosen model, not the first one listed',
  );
  const downloading = { kind: 'downloading', receivedBytes: 3, totalBytes: 10 };
  assert.deepEqual(display.dictationPageStatus(snapshot({ engine: downloading })), downloading, 'a download shows even before main has answered');
  assert.deepEqual(
    display.dictationPageStatus(snapshot({ engine: downloading, status: status({ kind: 'installed', sizeBytes: 9 }) })),
    downloading,
    'and wins over a stale disk read',
  );
});
