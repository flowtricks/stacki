// The `stacki` command line as one runnable file, `dist/cli/stacki.cjs`.
//
//   node dist/scripts/build/bundleStackiCli.js
//
// Why a separate bundle and a `stacki` bin, not a command of `astro-studio`: the CLI writes through the main process's document actors
// (electron/documents, electron/project/projectMetadata.ts), which Studio's vendored source does not ship, and moving them into the Studio package
// is a release-pipeline change of its own. CommonJS, because the sources reach `__filename` through the TypeScript compiler the editor's parsers bring. One esbuild bundle of the same sources keeps the rules in one place. The bundle is not published
// anywhere by this script; `package.json` names it as the `stacki` bin so a checkout can `npm link` it.
import esbuild = require('esbuild');
import fileSystem = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

function build(): void {
  const root = repositoryRoot();
  const outfile = path.join(root, 'dist/cli/stacki.cjs');
  esbuild.buildSync({
    entryPoints: [path.join(root, 'electron/project/cli/stackiMain.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    logLevel: 'info',
    external: ['electron'],
  });
  fileSystem.chmodSync(outfile, 0o755);
  const text = fileSystem.readFileSync(outfile, 'utf8');
  if (!text.startsWith('#!/usr/bin/env node')) {
    throw new Error('The stacki bundle lost its shebang line');
  }
  console.log(`Wrote ${path.relative(root, outfile)}.`);
}

build();
