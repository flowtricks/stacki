// The package managers Stacki runs for a project, and how package.json names one
// in its packageManager field: "pnpm@9.12.0", optionally followed by "+sha512.…".

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// The managers a new site can be created with: those tested end to end so far. Yarn's newer
// versions skip node_modules by default, which the preview has not been checked against.
export const CREATE_PACKAGE_MANAGERS = ['npm', 'pnpm'] as const satisfies readonly PackageManager[];
export type CreatePackageManager = (typeof CREATE_PACKAGE_MANAGERS)[number];

const FIELD_CHARS_MAX = 256;

export function parseCreatePackageManager(input: unknown): CreatePackageManager {
  const manager = CREATE_PACKAGE_MANAGERS.find((candidate) => candidate === input);
  if (manager === undefined) {
    throw new Error(`Package manager: expected ${CREATE_PACKAGE_MANAGERS.join(' or ')}`);
  }
  return manager;
}

// The name people know each manager by, for messages.
export function packageManagerLabel(manager: PackageManager): string {
  switch (manager) {
    case 'npm':
      return 'npm';
    case 'pnpm':
      return 'pnpm';
    case 'yarn':
      // i18n-ignore: package manager brand name, shown as the tool writes it.
      return 'Yarn';
    case 'bun':
      // i18n-ignore: package manager brand name, shown as the tool writes it.
      return 'Bun';
    default: {
      const exhaustive: never = manager;
      return exhaustive;
    }
  }
}

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
