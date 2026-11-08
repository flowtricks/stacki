// What a Studio release carries. `demo/` is not here on purpose: the static demo ships
// as separate release assets, so an install can never contain it (test/demoRelease.test.ts).
export const RELEASE_DIRECTORIES = ['src', 'scripts', 'vendor', 'docs', 'templates'] as const satisfies readonly string[];

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
