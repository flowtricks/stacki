// Keep the runtime self-contained: content workers and icons are authored assets,
// copied beside compiled code so development and packaged paths stay identical.
import fileSystemPromises = require('node:fs/promises');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';
import { writeLinuxInstaller } from '../release/linuxInstaller';

const root = repositoryRoot();
// An explicit inventory bounds the copy and excludes signing material.
const files = [
  'electron/content/workers/introspect.mjs',
  'electron/content/workers/schemaTools.mjs',
  'electron/content/workers/stubAstroContent.mjs',
  'electron/content/workers/stubAstroLoaders.mjs',
  // The AI panel's pinned adapter lockfiles (electron/handlers/ai/agentRegistry.ts).
  'resources/agents/claude-agent-acp.lock.json',
  'resources/agents/codex-acp.lock.json',
  'resources/icon-dock.png',
  'resources/icon.icns',
  'resources/icon.ico',
  'resources/icon.png',
] as const;

// TypeScript's `lib.*.d.ts`, for the code editor's type checker. The packager leaves every `.d.ts` out of the app, so
// they are copied with another ending (electron/lib/codeIntel/typeFiles.ts reads them back).
const TYPESCRIPT_LIBRARIES_MAX = 400;

async function stageTypeScriptLibraries(): Promise<void> {
  const source = path.resolve(root, 'node_modules/typescript/lib');
  const target = path.resolve(root, 'dist/electron/typescript-lib');
  const libraries = (await fileSystemPromises.readdir(source)).filter((name) => /^lib(\..+)?\.d\.ts$/.test(name));
  if (libraries.length === 0 || libraries.length > TYPESCRIPT_LIBRARIES_MAX) {
    throw new Error(`Expected TypeScript's library files in ${source}; found ${libraries.length}.`);
  }
  await fileSystemPromises.mkdir(target, { recursive: true });
  for (const name of libraries) {
    await fileSystemPromises.copyFile(path.join(source, name), path.join(target, `${name}.txt`));
  }
}

async function main(): Promise<void> {
  for (const file of files) {
    const target = path.resolve(root, 'dist', file);
    await fileSystemPromises.mkdir(path.dirname(target), { recursive: true });
    await fileSystemPromises.copyFile(path.resolve(root, file), target);
  }
  writeLinuxInstaller(root);
  await stageTypeScriptLibraries();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
