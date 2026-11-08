import './assemble';
import { projectScripts } from './projectScripts';
import { RELEASE_DIRECTORIES, RELEASE_FILES } from './releaseFiles';
import { findTrackingFailures } from './noTracking';
import { readNoTrackingInput } from './noTrackingTree';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRelease, releaseVersion, RELEASE_FILES_MAX } from '../src/features/updates/release';
import { record } from '../src/shared/validation';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = releaseVersion(record(JSON.parse(await readFile(path.join(root, 'src/shared/release.json'), 'utf8')))['version']);
const files: { path: string; content: string }[] = [];
async function collect(relative: string): Promise<void> {
  if (relative.split('/').length > 20) {
    throw new Error('Release tree is too deep');
  }
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Release source must not contain symlinks');
    }
    if (entry.isDirectory()) {
      await collect(file);
    } else {
      if (files.length >= RELEASE_FILES_MAX) {
        throw new Error('Release file limit exceeded');
      }
      files.push({ path: file, content: await readFile(path.join(root, file), 'utf8') });
    }
  }
}
for (const directory of RELEASE_DIRECTORIES) {
  await collect(directory);
}
for (const file of RELEASE_FILES) {
  let content = await readFile(path.join(root, file), 'utf8');
  if (file === 'package.json' || file === 'package-lock.json') {
    const value = record(JSON.parse(content));
    value['version'] = version;
    if (file === 'package.json') {
      value['scripts'] = projectScripts;
    }
    if (file === 'package-lock.json') {
      record(record(value['packages'])[''])['version'] = version;
    }
    content = JSON.stringify(value, null, 2) + '\n';
  }
  if (file === '.gitignore') {
    content = content.replace('vendor/stacki/\n', '');
  }
  files.push({ path: file, content });
}
const release = parseRelease({
  format: 1,
  version,
  files: files.sort((left, right) => left.path.localeCompare(right.path)),
});
// GitHub and npm both publish this bundle, so one failure here blocks both. `release:bundle`
// builds first, which is why a missing dist is a failure here and not a skipped check.
const trackingFailures = findTrackingFailures(await readNoTrackingInput(root, 'required'));
if (trackingFailures.length > 0) {
  throw new Error(`Studio must not ship tracking:\n${trackingFailures.join('\n')}`);
}
await mkdir(path.join(root, 'release'), { recursive: true });
const destination = path.join(root, 'release', `stacki-studio-${version}.json`);
await writeFile(destination, JSON.stringify(release));
console.log(destination);
