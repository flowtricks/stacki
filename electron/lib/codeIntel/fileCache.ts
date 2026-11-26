// Files read once per change: the value made from a file is kept until its size or modification time moves.
import * as fs from 'node:fs';

export interface FileStamp {
  readonly sizeBytes: number;
  readonly stamp: string;
}

export function fileStamp(file: string): FileStamp | undefined {
  try {
    const stats = fs.statSync(file);
    return stats.isFile() ? { sizeBytes: stats.size, stamp: `${stats.mtimeMs}:${stats.size}` } : undefined;
  } catch {
    return undefined;
  }
}

export function readText(file: string, sizeBytesMax: number): string | undefined {
  const found = fileStamp(file);
  if (found === undefined || found.sizeBytes > sizeBytesMax) {
    return undefined;
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function fileCache<T>(
  bounds: { readonly entriesMax: number; readonly sizeBytesMax: number },
  make: (file: string, text: string) => T,
): (file: string) => T | undefined {
  const { entriesMax, sizeBytesMax } = bounds;
  const entries = new Map<string, { readonly stamp: string; readonly value: T }>();
  return (file) => {
    const found = fileStamp(file);
    if (found === undefined || found.sizeBytes > sizeBytesMax) {
      entries.delete(file);
      return undefined;
    }
    const kept = entries.get(file);
    if (kept?.stamp === found.stamp) {
      return kept.value;
    }
    const text = readText(file, sizeBytesMax);
    if (text === undefined) {
      return undefined;
    }
    const value = make(file, text);
    entries.delete(file);
    entries.set(file, { stamp: found.stamp, value });
    const oldest = entries.keys().next();
    if (entries.size > entriesMax && oldest.done !== true) {
      entries.delete(oldest.value);
    }
    return value;
  };
}
