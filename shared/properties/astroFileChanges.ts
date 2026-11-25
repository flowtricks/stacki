import { pathText, record } from '../core/boundary';
import { assert } from '../core/assert';

export const ASTRO_FILES_MAX = 20_000;
export interface AstroFileChange {
  readonly kind: 'added' | 'removed';
  readonly file: string;
}

export function parseAstroFileChanges(input: unknown): readonly AstroFileChange[] {
  if (!Array.isArray(input) || input.length > ASTRO_FILES_MAX * 2) {
    throw new Error('Invalid Astro file changes');
  }
  return input.map((entry: unknown) => {
    const value = record(entry);
    const kind = value['kind'];
    const file = pathText(value['file']);
    if (kind !== 'added' && kind !== 'removed') {
      throw new Error('Invalid Astro file change kind');
    }
    if (!/^src\/.+\.astro$/i.test(file) || file.split('/').some((part) => part === '..')) {
      throw new Error('Invalid Astro file change path');
    }
    if (file.includes('\\')) {
      throw new Error('Astro file changes require project-relative POSIX paths');
    }
    return { kind, file };
  });
}

export function diffAstroFiles(previous: ReadonlySet<string>, current: ReadonlySet<string>): readonly AstroFileChange[] {
  assert(previous.size <= ASTRO_FILES_MAX, 'Previous Astro inventory exceeds limit');
  assert(current.size <= ASTRO_FILES_MAX, 'Current Astro inventory exceeds limit');
  const changes: AstroFileChange[] = [];
  let removedCount = 0;
  for (const file of previous) {
    if (!current.has(file)) {
      changes.push({ kind: 'removed', file });
      removedCount++;
    }
  }
  for (const file of current) {
    if (!previous.has(file)) {
      changes.push({ kind: 'added', file });
    }
  }
  assert(previous.size + changes.length - 2 * removedCount === current.size, 'Astro changes must account for the inventory size');
  return changes;
}

// A large agent operation gets a summary instead of evicting every useful notice in the stack.
export function astroChangeMessages(changes: readonly AstroFileChange[]): readonly string[] {
  assert(changes.length <= ASTRO_FILES_MAX * 2, 'Astro changes exceed inventory bounds');
  const messages: string[] = [];
  if (changes.length <= 3) {
    for (const { kind, file } of changes) {
      messages.push(`${kind === 'added' ? 'Added' : 'Removed'} ${file}`);
    }
    return messages;
  }
  for (const kind of ['added', 'removed'] as const) {
    let count = 0;
    const examples: string[] = [];
    for (const change of changes) {
      if (change.kind === kind) {
        count++;
        if (examples.length < 3) {
          examples.push(change.file);
        }
      }
    }
    if (count > 0) {
      messages.push(`${kind === 'added' ? 'Added' : 'Removed'} ${count} Astro files\n${examples.join('\n')}`);
    }
  }
  assert(messages.length <= 2, 'Each Astro operation has at most one summary');
  return messages;
}
