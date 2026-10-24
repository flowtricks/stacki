import { string } from './primitiveValidation';
export { MAX_SOURCE, record, string } from './primitiveValidation';
export function filePath(value: unknown): string {
  const path = string(value, 500);
  if (isDefaultsCanvas(path) || Object.values(METADATA_FILES).some((file) => file === path)) {
    return path;
  }
  if (
    !/^(src|public)\/[\w./ \[\]-]+$/.test(path) ||
    path.split('/').some((part) => part === '..' || part.startsWith('.'))
  ) {
    throw new Error('Invalid project path');
  }
  return path;
}
export function sourcePath(value: unknown): string {
  const path = filePath(value);
  if (
    !/\.(astro|json|md|mdx|mdoc|markdown|css|scss|sass|less|[cm]?[jt]sx?|yaml|yml|toml|csv|ndjson)$/i.test(
      path,
    )
  ) {
    throw new Error('Unsupported source file');
  }
  return path;
}
export function textChange(before: string, after: string) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  return {
    start,
    remove: before.length - start - end,
    insert: after.slice(start, after.length - end),
  };
}
import { METADATA_FILES } from '../../vendor/stacki/shared/properties/projectMetadata';
import { isDefaultsCanvas } from '../../vendor/stacki/shared/properties/defaultsCanvas';
