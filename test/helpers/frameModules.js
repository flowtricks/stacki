// The preload's region and iteration modules, bundled together for a test in
// jsdom, so they share one module state as they do in the frame. The modules
// read the page through the global `document`, which the test sets.
const { buildSync } = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoPath } = require('./sources.js');

module.exports = function loadFrameModules() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-frame-modules-'));
  const output = path.join(directory, 'frame.cjs');
  try {
    buildSync({
      stdin: {
        contents: ["export * from './frameRegions';", "export * from './frameIterations';"].join('\n'),
        resolveDir: repoPath('electron/preload'),
        loader: 'ts',
      },
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    return require(output);
  } finally {
    delete require.cache[output];
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
