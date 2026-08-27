#!/usr/bin/env node
//
// Run the whole test suite.
//
//   node scripts/test.js                — everything under test/
//   node scripts/test.js focus color    — only files whose name contains a term
//   node scripts/test.js --jobs=4       — cap the number of parallel workers
//
// `npm test` used to be a && chain of 105 `npm run` links: a fresh npm per
// file, strictly serial, dead at the first failure — and a hand-edit in two
// places for every new test. This discovers test/*.js instead, so a new test
// file is in the gate the moment it exists. Files run in parallel (they all
// use listen(0) and mkdtemp, so they don't collide), every failure is
// reported rather than the first, and the exit code says whether any failed.
//
// The per-file npm scripts (test:focus, …) remain for running one at a time.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const TEST_DIR = path.join(__dirname, '..', 'test');

// A few files need a different launcher than plain `node file`:
//  - *.test.js are node:test suites and want the test runner's reporter
//  - thumbs.js exercises Electron's nativeImage, so it needs the real binary
// Everything else runs as a plain script; the --disable-warning flag keeps
// the typeless-package.json warning out of a hundred captured outputs.
function commandFor(file) {
  if (file.endsWith('.test.js')) {
    return [process.execPath, ['--test', path.join('test', file)]];
  }
  if (file === 'thumbs.js') {
    return [require('electron'), [path.join('test', file)]];
  }
  return [
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join('test', file)],
  ];
}

function runOne(file) {
  return new Promise((resolve) => {
    const [bin, args] = commandFor(file);
    const started = Date.now();
    const child = spawn(bin, args, {
      cwd: path.join(__dirname, '..'),
      env: process.env,
    });
    const chunks = [];
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => chunks.push(d));
    child.on('error', (err) => {
      resolve({ file, ok: false, output: String(err), ms: Date.now() - started });
    });
    child.on('close', (code) => {
      resolve({
        file,
        ok: code === 0,
        output: Buffer.concat(chunks).toString('utf8'),
        ms: Date.now() - started,
      });
    });
  });
}

async function main() {
  const terms = [];
  let jobs = Math.min(8, os.availableParallelism());
  for (const arg of process.argv.slice(2)) {
    const m = /^--jobs=(\d+)$/.exec(arg);
    if (m) jobs = Math.max(1, Number(m[1]));
    else terms.push(arg.toLowerCase());
  }

  let files = fs
    .readdirSync(TEST_DIR)
    .filter((f) => f.endsWith('.js'))
    .sort();
  if (terms.length) {
    files = files.filter((f) => terms.some((t) => f.toLowerCase().includes(t)));
  }
  if (!files.length) {
    console.error(`no test files match: ${terms.join(' ')}`);
    process.exit(1);
  }

  const failures = [];
  let done = 0;
  const queue = files.slice();
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      const result = await runOne(file);
      done += 1;
      const count = `[${String(done).padStart(String(files.length).length)}/${files.length}]`;
      if (result.ok) {
        console.log(`${count} ok    ${file} (${result.ms}ms)`);
      } else {
        failures.push(result);
        console.log(`${count} FAIL  ${file} (${result.ms}ms)`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

  for (const f of failures) {
    console.log(`\n=== ${f.file} ===`);
    console.log(f.output.trimEnd());
  }
  console.log(
    `\n${files.length - failures.length} passed, ${failures.length} failed` +
      (failures.length ? `: ${failures.map((f) => f.file).join(', ')}` : '')
  );
  process.exit(failures.length ? 1 : 0);
}

main();
