import esbuild = require('esbuild');
import childProcess = require('node:child_process');
import fs = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

function versionOf(file: string): string {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof value !== 'object' || value === null || !('version' in value)) {
    throw new Error('Missing package version');
  }
  const version = value.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('Expected a stable package version');
  }
  return version;
}

// The Studio demo's browser files go into the package under dist/demo/, because stacki.build
// bakes its /demo from the newest create-stacki on npm (stacki-marketing-site/scripts/npm-demo.ts)
// and refuses a package without them. They are the same files the release uploads, named
// stacki-demo-<file> with stacki-demo-manifest.json listing each one's checksum.
function packDemo(root: string, directory: string): void {
  const studio = path.join(root, 'studio');
  childProcess.execFileSync('npm', ['run', 'release:demo'], { cwd: studio, stdio: 'inherit' });
  const source = path.join(studio, '.studio/demo-release/upload');
  const target = path.join(directory, 'dist/demo');
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const names = fs.readdirSync(source);
  if (!names.includes('stacki-demo-manifest.json')) {
    throw new Error('The Studio demo build wrote no manifest');
  }
  for (const name of names) {
    fs.copyFileSync(path.join(source, name), path.join(target, name));
  }
  console.log(`Packed ${names.length} Studio demo files into create-stacki.`);
}

function build(): void {
  const root = repositoryRoot();
  const directory = path.join(root, 'packages/create-stacki');
  const version = versionOf(path.join(root, 'package.json'));
  if (versionOf(path.join(directory, 'package.json')) !== version) {
    throw new Error('create-stacki and Stacki versions must match before packaging');
  }
  const release = path.join(root, 'studio/release', `stacki-studio-${version}.json`);
  if (versionOf(release) !== version) {
    throw new Error('Studio bundle version does not match create-stacki');
  }
  const output = path.join(directory, 'dist');
  fs.mkdirSync(output, { recursive: true });
  esbuild.buildSync({
    entryPoints: [path.join(root, 'studio/scripts/createStacki/cli.ts')],
    outfile: path.join(output, 'cli.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    logLevel: 'info',
  });
  fs.chmodSync(path.join(output, 'cli.mjs'), 0o755);
  fs.copyFileSync(release, path.join(output, 'stacki-studio.json'));
  packDemo(root, directory);
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
  console.log(`Prepared create-stacki ${version} with its bundled Studio release.`);
}

build();
