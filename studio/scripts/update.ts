import { open } from 'node:fs/promises';
import path from 'node:path';
import { downloadRelease, latestRelease } from '../src/features/updates/catalog';
import { installRelease } from '../src/features/updates/install';
import { parseRelease, RELEASE_BYTES_MAX } from '../src/features/updates/release';

export async function updateStudio(args: readonly string[]) {
  const [project, versionOrFile, acceptance, ...extra] = args;
  if (!project || !versionOrFile || acceptance !== '--replace-customizations' || extra.length) {
    throw new Error(
      'Usage: astro-studio update <project> <exact-version-or-release.json> --replace-customizations\nThis replaces all Studio code and customizations. Stop the local Studio server first.',
    );
  }
  const release = versionOrFile.endsWith('.json') ? parseRelease(JSON.parse(await localRelease(versionOrFile))) : await downloadRelease(versionOrFile);
  const result = await installRelease(path.join(path.resolve(project), 'studio'), release);
  console.log(`Installed Stacki Studio ${result.version}.`);
  if (result.backup) {
    console.log(`Previous Studio code: ${result.backup}`);
  }
  console.log('Connection settings, secrets and drafts were retained. Deploy the updated Studio to activate it online.');
}
async function localRelease(file: string) {
  const handle = await open(path.resolve(file), 'r');
  try {
    if ((await handle.stat()).size > RELEASE_BYTES_MAX) {
      throw new Error('Release file is too large');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}
export async function checkStudioUpdate() {
  const latest = await latestRelease();
  console.log(latest ? `Stacki Studio ${latest.version}: ${latest.url}` : 'No Studio release is published yet.');
}
