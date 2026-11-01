// Fast feedback before launching development: use the same tools as CI,
// including structural tests that do not need a build or an Electron window.
import path from 'node:path';
import { repositoryRoot, runEslint, runSourcePathCheck, runTypeCheck } from './checks.mts';
import { runChild, type ChildResult } from './child.mts';
import { checkStudio } from './studioChecks.mts';

const root = repositoryRoot();
const typesOnly = process.argv.includes('--types');
const checks: readonly {
  readonly name: string;
  readonly run: () => ChildResult;
}[] = [
  { name: 'TypeScript (all Desktop build targets)', run: () => runTypeCheck(root) },
  ...(typesOnly
    ? []
    : [
        { name: 'ESLint', run: () => runEslint(root, ['.']) },
        {
          name: 'Prettier',
          run: () => runChild(process.execPath, [path.join(root, 'node_modules/prettier/bin/prettier.cjs'), '--check', '.'], { cwd: root }),
        },
        {
          name: 'Repository policy',
          run: () => runChild(process.execPath, ['scripts/policy/scan.mts'], { cwd: root }),
        },
        { name: 'Test source paths', run: () => runSourcePathCheck(root) },
        { name: 'Studio compiler, lint and formatting', run: () => checkStudio(root, 'check') },
      ]),
];

for (const check of checks) {
  console.log(`[check:local] ${check.name}`);
  const result = check.run();
  if (result.status !== 0) {
    console.error(result.stdout + result.stderr);
    process.exitCode = 1;
    break;
  }
}
