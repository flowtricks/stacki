import { record, string } from './studioValidation';

export const RELEASE_BYTES_MAX = 32_000_000;
export const RELEASE_FILES_MAX = 1500;
export interface StudioRelease {
  readonly format: 1;
  readonly version: string;
  readonly files: readonly ReleaseFile[];
}
export interface ReleaseFile {
  readonly path: string;
  readonly content: string;
}
export function releaseVersion(value: unknown): string {
  const version = string(value, 40);
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('Expected an exact stable Stacki version');
  }
  return version;
}
export function isNewerRelease(candidate: string, current: string): boolean {
  const next = releaseVersion(candidate).split('.').map(Number);
  const previous = releaseVersion(current).split('.').map(Number);
  for (const [index, value] of next.entries()) {
    const before = previous[index] ?? 0;
    if (value !== before) {
      return value > before;
    }
  }
  return false;
}
export function retainedPath(file: string): boolean {
  const first = file.split('/')[0] ?? '';
  return ['.studio', '.wrangler', 'cloudflare', '.studio-state'].includes(first) || /^\.(env|dev\.vars)(\.|$)/.test(first);
}
export function releasePath(value: unknown): string {
  const file = string(value, 500);
  if (
    !/^[\w.-]+(?:\/[\w.-]+)*$/.test(file) ||
    file.split('/').some((part) => part === '.' || part === '..') ||
    retainedPath(file) ||
    (!/^(src|scripts|vendor|docs|templates)\//.test(file) &&
      ![
        'package.json',
        'package-lock.json',
        'Dockerfile',
        '.dockerignore',
        '.gitignore',
        'tsconfig.json',
        'tsconfig.worker.json',
        'README.md',
        'AGENTS.md',
        'LICENSE',
      ].includes(file))
  ) {
    throw new Error('Invalid replaceable Studio file: ' + file);
  }
  return file;
}
export function parseRelease(input: unknown): StudioRelease {
  const value = record(input);
  if (value['format'] !== 1 || !Array.isArray(value['files']) || value['files'].length === 0 || value['files'].length > RELEASE_FILES_MAX) {
    throw new Error('Unsupported Studio release');
  }
  const version = releaseVersion(value['version']);
  const names = new Set<string>();
  let bytes = 0;
  const files = value['files'].map((input: unknown) => {
    const file = record(input);
    const name = releasePath(file['path']);
    if (names.has(name.toLowerCase())) {
      throw new Error('Duplicate Studio file');
    }
    names.add(name.toLowerCase());
    const content = string(file['content'], 2_000_000);
    bytes += new TextEncoder().encode(content).byteLength;
    if (bytes > RELEASE_BYTES_MAX) {
      throw new Error('Studio release is too large');
    }
    return { path: name, content };
  });
  for (const required of ['package.json', 'package-lock.json', 'Dockerfile', 'scripts/build.ts', 'src/shared/release.json', 'vendor/stacki/LICENSE']) {
    if (!names.has(required.toLowerCase())) {
      throw new Error('Incomplete Studio release');
    }
  }
  for (const file of files) {
    if (file.path === 'package.json' || file.path === 'src/shared/release.json') {
      if (record(JSON.parse(file.content))['version'] !== version) {
        throw new Error('Studio release version mismatch');
      }
    }
  }
  return { format: 1, version, files };
}
