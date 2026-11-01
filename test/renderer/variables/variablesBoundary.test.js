// Exercise actual CSS parser output through the renderer boundary, then corrupt
// each nested contract. Scripted bridge failures pin the operating-error channel.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readVariables } = require('#dist/electron/project/cssVars.js');

// A boundary can receive null — JSON, structured clone and postMessage all carry it —
// so the negative space below includes it. It is read from JSON, because our own
// code never writes a null.
const PLATFORM_NULL = JSON.parse('null');
const { parseCSSVariables, readCSSVariables, VARIABLES_LIMITS } = require('../../helpers/rendererModule')('src/features/variables/variablesBridge.ts');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-variable-boundary-'));
let wire;
try {
  fs.mkdirSync(path.join(directory, 'src/styles'), { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'src/styles/tokens.css'),
    ':root { /* Palette */ --brand: #0af; --accent: var(--brand); --gap: 1rem; }\n' + '.dark { --brand: #111; --accent: var(--brand); --gap: 2rem; }\n',
  );
  fs.writeFileSync(path.join(directory, 'src/styles/broken.css'), ':root { --broken:');
  wire = readVariables(directory);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
const result = parseCSSVariables(wire);
assert.equal(result.ok, true);
assert.deepEqual(result.value, wire, 'derived color/reference metadata survives the real wire');
assert.deepEqual(parseCSSVariables({ files: [], values: {} }), {
  ok: true,
  value: { files: [], values: {} },
});
assert.deepEqual(parseCSSVariables({ files: [], error: 'unavailable' }), {
  ok: false,
  error: 'unavailable',
});
const good = () => structuredClone(wire);
const validFile = (snapshot) => snapshot.files.find((file) => !file.error);
const group = (snapshot) => validFile(snapshot).groups[0];
const block = (snapshot) => group(snapshot).blocks[0];
const row = (snapshot) => block(snapshot).rows[0];
const cell = (snapshot) => row(snapshot).cells.find(Boolean);
for (const mutate of [
  (snapshot) => {
    snapshot.files = PLATFORM_NULL;
  },
  (snapshot) => {
    snapshot.values = [];
  },
  (snapshot) => {
    snapshot.values['--brand'] = 2;
  },
  (snapshot) => {
    snapshot.error = 'cannot contain successful files';
  },
  (snapshot) => {
    validFile(snapshot).rel = 'bad\0path';
  },
  (snapshot) => {
    validFile(snapshot).count = -1;
  },
  (snapshot) => {
    validFile(snapshot).groups = PLATFORM_NULL;
  },
  (snapshot) => {
    group(snapshot).kind = 'matrix';
  },
  (snapshot) => {
    group(snapshot).columns[0].line = 1.5;
  },
  (snapshot) => {
    group(snapshot).columns[0].context = [false];
  },
  (snapshot) => {
    block(snapshot).kind = 'single';
  },
  (snapshot) => {
    block(snapshot).title = 2;
  },
  (snapshot) => {
    block(snapshot).titleStart = -1;
  },
  (snapshot) => {
    block(snapshot).rows = PLATFORM_NULL;
  },
  (snapshot) => {
    row(snapshot).cells = {};
  },
  (snapshot) => {
    row(snapshot).label = PLATFORM_NULL;
  },
  (snapshot) => {
    cell(snapshot).value = 1;
  },
  (snapshot) => {
    cell(snapshot).valueStart = -1;
  },
  (snapshot) => {
    cell(snapshot).valueEnd = 0;
  },
  (snapshot) => {
    cell(snapshot).valueEnd = VARIABLES_LIMITS.fileCharsMax + 1;
  },
  (snapshot) => {
    cell(snapshot).resolved = false;
  },
  (snapshot) => {
    cell(snapshot).color = [];
  },
  (snapshot) => {
    cell(snapshot).unknownColor = 'true';
  },
  (snapshot) => {
    cell(snapshot).value = 'x'.repeat(VARIABLES_LIMITS.fileCharsMax + 1);
  },
  (snapshot) => {
    group(snapshot).columns = Array(VARIABLES_LIMITS.entriesMax + 1).fill(PLATFORM_NULL);
  },
  (snapshot) => {
    snapshot.files = Array(VARIABLES_LIMITS.entriesMax + 1).fill(PLATFORM_NULL);
  },
]) {
  const invalid = good();
  mutate(invalid);
  assert.throws(() => parseCSSVariables(invalid));
}
const matrix = good();
block(matrix).kind = 'matrix';
assert.throws(() => parseCSSVariables(matrix), /matrix columns are required/);
block(matrix).columns = group(matrix).columns;
assert.equal(parseCSSVariables(matrix).ok, true);
block(matrix).titleStart = 30;
block(matrix).titleEnd = 20;
assert.throws(() => parseCSSVariables(matrix), /reversed title range/);
const holes = good();
row(holes).cells[0] = undefined;
assert.equal(parseCSSVariables(holes).ok, true, 'matrix holes are valid');
for (const invalid of [PLATFORM_NULL, [], {}, { files: [] }, { files: [], error: false }]) {
  assert.throws(() => parseCSSVariables(invalid));
}
(async () => {
  global.window = {
    avb: {
      cssVariables: async (project) => {
        assert.equal(project, '/project');
        return wire;
      },
    },
  };
  assert.deepEqual(await readCSSVariables('/project'), result);
  window.avb.cssVariables = async () => {
    throw new Error('disk unavailable');
  };
  assert.deepEqual(await readCSSVariables('/project'), { ok: false, error: 'disk unavailable' });
  window.avb.cssVariables = async () => PLATFORM_NULL;
  await assert.rejects(() => readCSSVariables('/project'));
  console.log('variables-boundary: real parser round trip, nested bounds and failure channels passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
