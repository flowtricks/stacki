// The path spellings code intelligence works in: absolute paths with forward slashes, as TypeScript spells them.
import * as path from 'node:path';

export function slashed(value: string): string {
  return value.replace(/\\/g, '/');
}

export function joined(...parts: readonly string[]): string {
  return slashed(path.resolve(...parts));
}

export function folderOf(file: string): string {
  return slashed(path.dirname(file));
}

export function nameOf(file: string): string {
  return path.posix.basename(slashed(file));
}

export function extensionOf(file: string): string {
  return path.posix.extname(slashed(file)).toLowerCase();
}

/** Whether `file` is `folder` or inside it. */
export function within(folder: string, file: string): boolean {
  return file === folder || file.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

/** The specifier from one folder to a file, always starting `./` or `../`. */
export function relativeSpecifier(fromFolder: string, target: string): string {
  const relative = path.posix.relative(fromFolder, target);
  return relative.startsWith('../') ? relative : `./${relative}`;
}
