// What the dev server loads has to be a real file on disk.
//
//   node test/scripts/release/unpackedParser.test.js
//
// The preview runs on a config Stacki generates into the project, and that
// config requires this app's own parser — the thing that puts the markers in
// the page. The process doing the requiring is the Astro dev server: plain
// Node, not Electron, and plain Node cannot read inside app.asar. So the parser
// is listed in build.asarUnpack, which leaves a real copy beside the archive.
//
// A copy of ONE file. `astroParser.js` requires `./htmlText`, which stayed in
// the archive — so in the packaged app the require threw, the config never
// loaded, and the preview came up on the project's own config with no markers
// in it. Nothing on the canvas could be selected, hovered or outlined, while
// the same code run from source was fine, because there is no archive there.
//
// The rule is not "unpack the parser". It is "unpack everything the parser
// pulls in", and nobody adding an import to it is going to remember that. So
// it is checked: the require closure is walked, every file in it has to be
// covered by asarUnpack, and the whole thing has to load in a directory that
// holds those files and nothing else — which is exactly what the packaged app
// hands it. The component preview configuration also loads a helper outside
// Electron, so its dependency closure must obey the same rule.
// Load the generated config too: computed requires can escape the static closure,
// as the package-component reader did when it stayed inside the application archive.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { renderMarkerConfig } = require('#dist/electron/preview/markerConfig.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const ENTRIES = [
  'dist/electron/parse/astroParser.js',
  'dist/electron/previewServer/componentPreview.js',
  'dist/electron/previewServer/previewMarkers.js',
  'dist/electron/lib/componentSources.js',
  'dist/electron/previewServer/studioEntry.js',
  'dist/electron/previewServer/previewWarmup.js',
];

// The parser uses TypeScript's syntax tree for arbitrary callback bodies. Its
// existing runtime dependency must also be available to plain Node outside ASAR.
const PARSER_PACKAGES = ['node_modules/typescript/package.json',
  'node_modules/typescript/lib/typescript.js'];

// Every local file the entry pulls in, transitively. Only relative requires:
// bare package dependencies are listed above and copied beside this closure,
// because the project's Node process cannot use Electron's ASAR loader.
// A require chain in the built app runs a dozen modules deep; one past this is
// a resolution loop the `seen` set failed to stop.
const CLOSURE_LIMITS = { requireDepthMax: 64 };

function closureOf(rel, seen = new Set(), depth = 0) {
  assert.ok(depth <= CLOSURE_LIMITS.requireDepthMax, 'closureOf: depth limit');
  rel = rel.split(path.sep).join('/');
  if (seen.has(rel)) {
    return seen;
  }
  seen.add(rel);
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    let next = path.join(path.dirname(rel), match[1]).split(path.sep).join('/');
    if (!fs.existsSync(path.join(ROOT, next))) {
      next += '.js';
    }
    if (!fs.existsSync(path.join(ROOT, next))) {
      check(
        `the require ${JSON.stringify(match[1])} in ${rel} resolves`,
        false,
        'nothing on disk answers to it',
      );
      continue;
    }
    closureOf(next, seen, depth + 1);
  }
  return seen;
}

const covers = (pattern, rel) => {
  if (pattern === rel) {
    return true;
  }
  // The globs electron-builder takes, as far as this needs to read them.
  const re = new RegExp(
    '^' +
      pattern
        .split('**')
        .map((part) =>
          part
            .split('*')
            .map((pattern) => pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
            .join('[^/]*'),
        )
        .join('.*') +
      '$',
  );
  return re.test(rel);
};

const pkg = JSON.parse(fs.readFileSync(repoPath('package.json'), 'utf8'));
const patterns = pkg.build?.asarUnpack || [];
const files = [...ENTRIES.reduce((seen, entry) => closureOf(entry, seen), new Set()),
  ...PARSER_PACKAGES];
// Main finds the preview's files through runtimePaths; the parser, through
// the generated configuration main writes.
const main = [
  'dist/electron/main.js',
  'dist/electron/lib/runtimePaths.js',
  'dist/electron/preview/markerConfig.js',
]
  .map((file) => fs.readFileSync(repoPath(file), 'utf8'))
  .join('\n');

for (const entry of ENTRIES) {
  check(
    `${entry} is referenced by the generated preview configuration`,
    main.includes(path.basename(entry)),
  );
  check(`${entry} pulls in its supporting modules`, closureOf(entry).size > 1);
}
for (const rel of files) {
  check(
    `${rel} is unpacked, so plain Node can read it`,
    patterns.some((pattern) => covers(pattern, rel)),
    `no asarUnpack pattern covers it — ${patterns.join(' , ')}`,
  );
}

// And the whole of it loads with nothing else around, which is the packaged
// condition: app.asar.unpacked holds these files and no others.
{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-unpacked-'));
  // Only what asarUnpack actually names — anything else is still inside the
  // archive as far as this process is concerned, which is the whole point.
  const unpacked = files.filter((rel) => patterns.some((pattern) => covers(pattern, rel)));
  for (const rel of unpacked) {
    const to = path.join(directory, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), to);
  }
  for (const entry of ENTRIES) {
    let error = '';
    try {
      execFileSync(
        process.execPath,
        ['-e', `require(${JSON.stringify(path.join(directory, entry))})`],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          encoding: 'utf8',
        },
      );
    } catch (thrown) {
      error =
        String(thrown.stderr || thrown.message)
          .split('\n')
          .find((line) => /Error/.test(line)) || 'it threw';
    }
    check(`the unpacked ${entry} copy loads on its own`, !error, error);
  }
  checkGeneratedConfig(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

function checkGeneratedConfig(directory) {
  const local = (file) => JSON.stringify(path.join(directory, file));
  const source = renderMarkerConfig([
    'const userConfig = {};',
    local('dist/electron/previewServer/previewMarkers.js'),
    local('dist/electron/previewServer/componentPreview.js'),
    local('dist/electron/previewServer/studioEntry.js'),
    local('dist/electron/previewServer/previewWarmup.js'),
    JSON.stringify([directory]),
    JSON.stringify(''),
    JSON.stringify(''),
    local('preview.astro'),
    local('paths.js'),
    local('data.js'),
    local('value.js'),
  ]);
  const config = path.join(directory, 'astro.config.mjs');
  fs.writeFileSync(config, source);
  let error = '';
  try {
    execFileSync(process.execPath, [config], {
      cwd: directory,
      timeout: 10000,
      stdio: ['ignore', 'ignore', 'pipe'],
      encoding: 'utf8',
    });
  } catch (thrown) {
    error = String(thrown.stderr || thrown.message);
  }
  check('the generated preview config loads using only unpacked files', !error, error);
}

if (failures.length) {
  console.error(
    `\nunpacked-parser: ${failures.length} failed, ${checked - failures.length} passed\n`,
  );
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`unpacked-parser: ${checked} passed  [what the dev server loads is on disk]`);
