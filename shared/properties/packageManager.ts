// The package managers Stacki runs for a project, and how package.json names one
// in its packageManager field: "pnpm@9.12.0", optionally followed by "+sha512.…".

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

const FIELD_CHARS_MAX = 256;

// The manager the field names, or undefined when it is absent, malformed or names
// one Stacki does not run, so detection falls back to the project's lockfile.
export function parsePackageManagerField(input: unknown): PackageManager | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  if (input.length > FIELD_CHARS_MAX) {
    return undefined;
  }
  const at = input.indexOf('@');
  const name = at === -1 ? input : input.slice(0, at);
  return PACKAGE_MANAGERS.find((manager) => manager === name);
}
