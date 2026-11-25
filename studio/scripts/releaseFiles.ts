// What a Studio release carries. `demo/` is not here on purpose: the static demo ships
// as separate release assets, so an install can never contain it (test/demoRelease.test.ts).
export const RELEASE_DIRECTORIES = ['src', 'scripts', 'vendor', 'docs', 'templates'] as const satisfies readonly string[];

// Files inside the release directories that build the demo and import from `demo/`.
// An install has no `demo/`, so shipping them would fail Studio's type check on install
// (1.0.16 caught this before publishing). The `release:demo` script runs them from the
// repository only.
export const RELEASE_EXCLUDED_FILES = ['scripts/buildDemoAssets.ts'] as const satisfies readonly string[];

export const RELEASE_FILES = [
  'package.json',
  'package-lock.json',
  'Dockerfile',
  '.dockerignore',
  '.gitignore',
  'tsconfig.json',
  'tsconfig.worker.json',
  'README.md',
  'AGENTS.md',
  'LICENSE',
] as const satisfies readonly string[];
