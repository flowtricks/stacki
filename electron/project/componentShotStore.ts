import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { COMPONENT_SHOT_LIMITS, parseComponentShotMeta, SHOT_DATA_URL_CHARS_MAX, type ComponentShotMeta } from '../../shared/properties/componentShots';
import { keyFor } from './thumbs';

// The cache of component photographs: userData/component-shots/<project key>/, one JPEG per
// component and a meta.json that says which component each belongs to and what the project looked
// like when the run finished. The meta is parsed on every read, since a file on disk is not ours to trust.

const META_FILE = 'meta.json';

export const shotsDirectory = (userDataPath: string, projectPath: string): string => path.join(userDataPath, 'component-shots', keyFor(projectPath));

/** The image file name for a component: stable, so a new photograph replaces the old one. */
export function shotFileName(component: string): string {
  return crypto.createHash('sha1').update(component).digest('hex').slice(0, 16) + '.jpg';
}

export function readShotMeta(userDataPath: string, projectPath: string): ComponentShotMeta | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(shotsDirectory(userDataPath, projectPath), META_FILE), 'utf8'));
    return parseComponentShotMeta(raw);
  } catch {
    // Missing, unreadable or malformed: the cache is empty, and the next run rebuilds it.
    return undefined;
  }
}

export function writeShotMeta(userDataPath: string, projectPath: string, meta: ComponentShotMeta): void {
  const directory = shotsDirectory(userDataPath, projectPath);
  fs.mkdirSync(directory, { recursive: true });
  // Written beside and renamed over, so a reader never sees half a file.
  const temporary = path.join(directory, `${META_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(parseComponentShotMeta(meta)));
  fs.renameSync(temporary, path.join(directory, META_FILE));
}

export function writeShotImage(userDataPath: string, projectPath: string, file: string, bytes: Uint8Array): void {
  const directory = shotsDirectory(userDataPath, projectPath);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, file), bytes);
}

/** The photograph of `component` as a data URL, or undefined when the cache has none. */
export function readShotImage(userDataPath: string, projectPath: string, component: string): string | undefined {
  const shot = readShotMeta(userDataPath, projectPath)?.shots.find((entry) => entry.component === component);
  if (shot === undefined) {
    return undefined;
  }
  try {
    const url = 'data:image/jpeg;base64,' + fs.readFileSync(path.join(shotsDirectory(userDataPath, projectPath), shot.file)).toString('base64');
    return url.length > SHOT_DATA_URL_CHARS_MAX ? undefined : url;
  } catch {
    return undefined;
  }
}

const SHOT_FILE = /^[0-9a-f]{16}\.jpg$/;

/**
 * Deletes the photographs in the project's cache folder that `meta` no longer names. Only files that carry a
 * photograph's name are touched, and only so many are looked at, so a folder with something else in it is left alone.
 */
export function pruneShotImages(userDataPath: string, projectPath: string, meta: ComponentShotMeta): void {
  const directory = shotsDirectory(userDataPath, projectPath);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return;
  }
  const named = new Set(meta.shots.map((shot) => shot.file));
  for (const name of names.slice(0, COMPONENT_SHOT_LIMITS.componentsMax * 4)) {
    if (SHOT_FILE.test(name) && !named.has(name)) {
      fs.rmSync(path.join(directory, name), { force: true });
    }
  }
}
