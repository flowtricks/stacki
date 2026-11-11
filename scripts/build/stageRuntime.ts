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

async function main(): Promise<void> {
  for (const file of files) {
    const target = path.resolve(root, 'dist', file);
    await fileSystemPromises.mkdir(path.dirname(target), { recursive: true });
    await fileSystemPromises.copyFile(path.resolve(root, file), target);
  }
  writeLinuxInstaller(root);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
