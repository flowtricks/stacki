// Verify an alias against its first existing target before emitting it. Merely
// having @/* in tsconfig does not prove it resolves to this component.
import fs from 'node:fs';
import path from 'node:path';
import { aliasMap } from '../content/cmsRefs';
import { packageComponentImport } from '../lib/componentSources';

export function componentSpecifier(root: string, file: string): string | undefined {
  const installed = packageComponentImport(root, file);
  if (installed !== undefined) {
    return installed;
  }
  const absolute = path.resolve(root, file);
  const aliases = aliasMap(root);
  for (const alias of aliases) {
    if (!alias.wildcard) {
      continue;
    }
    for (const target of alias.targets) {
      const relative = path.relative(target, absolute).split(path.sep).join('/');
      if (relative.startsWith('../') || path.isAbsolute(relative)) {
        continue;
      }
      const specifier = alias.prefix + relative;
      const effective = aliases.find((entry) => (entry.wildcard ? specifier.startsWith(entry.prefix) : specifier === entry.prefix));
      const resolved = effective?.targets
        .map((directory) => path.resolve(directory, specifier.slice(effective.prefix.length)))
        .find((candidate) => fs.existsSync(candidate));
      if (resolved !== undefined && fs.realpathSync(resolved) === fs.realpathSync(absolute)) {
        return specifier;
      }
    }
  }
  return undefined;
}
