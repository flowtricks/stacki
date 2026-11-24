import './assemble';
import { buildRelease, serializeRelease } from './releaseBundle';
import { findTrackingFailures } from './noTracking';
import { readNoTrackingInput } from './noTrackingTree';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = await buildRelease(root);
// GitHub and npm both publish this bundle, so one failure here blocks both. `release:bundle`
// builds first, which is why a missing dist is a failure here and not a skipped check.
const trackingFailures = findTrackingFailures(await readNoTrackingInput(root, 'required'));
if (trackingFailures.length > 0) {
  throw new Error(`Studio must not ship tracking:\n${trackingFailures.join('\n')}`);
}
// Fails before anything is written when the file is larger than installed clients accept.
const text = serializeRelease(release);
await mkdir(path.join(root, 'release'), { recursive: true });
const destination = path.join(root, 'release', `stacki-studio-${release.version}.json`);
await writeFile(destination, text);
console.log(destination);
