// `/studio/api/component-usage` from the demo's own sources: how many times each
// component is used, and where. The same answer the server's scan gives
// (componentUsageServer.ts), counted from the parsed pages instead of the disk.
import { flatten, parsePage } from '../src/features/source/source';
import { componentImports } from './pageChange';

const FILES_MAX = 2_000;

export interface UsageFile {
  readonly rel: string;
  readonly path: string;
  readonly kind: 'page' | 'layout' | 'component' | 'file';
  readonly count: number;
}

export interface ComponentUsage {
  readonly file: string;
  readonly files: readonly UsageFile[];
  readonly total: number;
}

function usageKind(file: string): UsageFile['kind'] {
  if (file.startsWith('src/pages/')) {
    return 'page';
  }
  if (file.startsWith('src/layouts/')) {
    return 'layout';
  }
  return file.startsWith('src/components/') ? 'component' : 'file';
}

/** Each component file's instances, file by file. */
export function componentUsage(sources: ReadonlyMap<string, string>, selected: string | undefined): readonly ComponentUsage[] {
  const files = [...sources.keys()].filter((file) => file.endsWith('.astro')).slice(0, FILES_MAX);
  const targets = selected === undefined ? files.filter((file) => !file.startsWith('src/pages/')) : [selected];
  const counts = new Map<string, Map<string, number>>();
  for (const file of files) {
    const text = sources.get(file) ?? '';
    const parsed = parsePage(text);
    const imports = componentImports(file, text);
    const perFile = new Map<string, number>();
    for (const node of parsed.editable ? flatten(parsed.model.nodes) : []) {
      const target = node.kind === 'component' ? imports.get(node.name ?? '') : undefined;
      if (target !== undefined) {
        perFile.set(target, (perFile.get(target) ?? 0) + 1);
      }
    }
    counts.set(file, perFile);
  }
  return targets.map((target) => {
    const using = [...counts]
      .flatMap(([file, perFile]) => {
        const count = file === target ? 0 : (perFile.get(target) ?? 0);
        return count > 0 ? [{ rel: file, path: file, kind: usageKind(file), count }] : [];
      })
      .sort((left, right) => right.count - left.count || left.rel.localeCompare(right.rel));
    return { file: target, files: using, total: using.reduce((sum, file) => sum + file.count, 0) };
  });
}
