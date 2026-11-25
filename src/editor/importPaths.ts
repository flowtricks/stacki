// Resolve source-relative imports without platform-specific path rules in the renderer.
// Unknown aliases stay unresolved; callers must not mistake them for project paths.
export function resolveSourceImport(
  file: string,
  specifier: string,
  components: readonly { readonly file: string; readonly importPath?: string }[] = [],
): string | undefined {
  const configured = components.find((entry) => entry.importPath === specifier);
  if (configured) {
    return configured.file;
  }
  const source = specifier.startsWith('@/')
    ? 'src/' + specifier.slice(2)
    : specifier.startsWith('.')
      ? file.split('/').slice(0, -1).join('/') + '/' + specifier
      : undefined;
  if (!source) {
    return undefined;
  }
  const parts: string[] = [];
  for (const segment of source.split('/')) {
    if (segment === '..') {
      if (!parts.pop()) {
        return undefined;
      }
    } else if (segment !== '.') {
      parts.push(segment);
    }
  }
  return parts.join('/');
}
