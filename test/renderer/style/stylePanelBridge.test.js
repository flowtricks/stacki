// Goal: StylePanel receives bounded stylesheet records rather than trusting
// preload replies. Methodology: parse valid and invalid shapes, then exercise
// both endpoints through a scripted transport failure and payload capture.
const test = require('node:test');
const assert = require('node:assert/strict');
const bridge = require('../../helpers/rendererModule')('src/features/style/stylePanelBridge.ts');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');

const file = { rel: 'src/styles/site.css', name: 'site.css', path: '/project/site.css', size: 12 };

test('style file parser accepts complete records and rejects invalid bounds', () => {
  assert.deepEqual(bridge.parseStyleFiles({ files: [file] }), [file]);
  for (const value of [PLATFORM_NULL, { files: PLATFORM_NULL }, { files: [{ ...file, size: -1 }] }, { files: [{ ...file, path: 'bad\0path' }] }]) {
    assert.throws(() => bridge.parseStyleFiles(value));
  }
  // No size limit: a project with more stylesheets than the old cap lists them all.
  assert.equal(bridge.parseStyleFiles({ files: Array(100_001).fill(file) }).length, 100_001);
});

test('style file reads validate payloads and preserve operating failures', async () => {
  const calls = [];
  global.window = {
    avb: {
      listStyleFiles: async (payload) => {
        calls.push(['css', payload]);
        return { files: [file] };
      },
      listAstroStyleFiles: async (payload) => {
        calls.push(['astro', payload]);
        return { files: [] };
      },
    },
  };
  assert.deepEqual(await bridge.readStyleFiles('/project'), { ok: true, value: [file] });
  assert.deepEqual(await bridge.readAstroStyleFiles('/project'), { ok: true, value: [] });
  assert.deepEqual(calls, [
    ['css', '/project'],
    ['astro', '/project'],
  ]);
  global.window.avb.listStyleFiles = async () => {
    throw new Error('disk offline');
  };
  assert.deepEqual(await bridge.readStyleFiles('/project'), {
    ok: false,
    error: 'disk offline',
  });
  global.window.avb.listStyleFiles = async () => ({ files: [{ ...file, size: 'large' }] });
  await assert.rejects(() => bridge.readStyleFiles('/project'));
});
