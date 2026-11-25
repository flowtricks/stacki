// Source paths use forward slashes on every host. Keeping these helpers platform
// independent lets the editor resolve instance schemas without a filesystem shim.
export interface ComponentImport {
  readonly file: string;
  readonly importPath?: string;
}

export function componentImport(page: string, component: ComponentImport): string {
  return component.importPath ?? relativeImport(page, component.file);
}

export function relativeImport(page: string, component: string) {
  const parent = page.split('/').slice(0, -1);
  const target = component.split('/');
  while (parent.length && parent[0] === target[0]) {
    parent.shift();
    target.shift();
  }
  return (parent.length ? '../'.repeat(parent.length) : './') + target.join('/');
}
export function resolveImport(page: string, specifier: string | undefined, components: readonly ComponentImport[] = []): string | undefined {
  if (!specifier) {
    return undefined;
  }
  const configured = components.find((component) => component.importPath === specifier);
  if (configured) {
    return configured.file;
  }
  const path = specifier.startsWith('@/')
    ? 'src/' + specifier.slice(2)
    : specifier.startsWith('.')
      ? page.split('/').slice(0, -1).join('/') + '/' + specifier
      : undefined;
  if (!path) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) {
        return undefined;
      }
      parts.pop();
    } else if (part !== '.' && part) {
      parts.push(part);
    }
  }
  return parts.join('/');
}
