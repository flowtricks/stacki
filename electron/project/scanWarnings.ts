// The warnings a project scan reports (shared/properties/projectScan.ts, `ScanWarning`).
//
// Why: a project that is odd must still open. When the scan cannot read something, or has to
// assume Astro's default for a setting it cannot read as text, the user is owed a specific
// sentence naming the file and the reason, not a blank panel and not silence. These builders
// turn what the scan met (walk problems, a computed config value, missing packages) into those
// warnings; the UI decides how they are shown.

import * as path from 'node:path';
import type { ScanWarning } from '../../shared/properties/projectScan';
import { ASTRO_SOURCE_DIRECTORY_DEFAULT } from '../../shared/properties/astroSourceDirectory';
import { packageManagerLabel, type PackageManager } from '../../shared/properties/packageManager';
import type { AstroPages } from '../lib/astroConfig';
import type { WalkProblem } from './projectWalk';

function relativeTo(projectPath: string, absolute: string): string {
  const relative = path.relative(projectPath, absolute).split(path.sep).join('/');
  // A path that leaves the project (it cannot, but a bad input must not break the contract) names the project itself.
  return relative.startsWith('..') ? '' : relative;
}

function withFile(file: string, warning: Omit<ScanWarning, 'file'>): ScanWarning {
  return file.length === 0 ? warning : { ...warning, file };
}

/** One warning per distinct folder or link the walk could not read. */
export function walkWarnings(projectPath: string, problems: readonly WalkProblem[]): readonly ScanWarning[] {
  const seen = new Set<string>();
  const warnings: ScanWarning[] = [];
  for (const problem of problems) {
    // A folder that is not there (no pages folder yet, or deleted while scanning) is an empty one, not a problem.
    if (problem.code === 'ENOENT' && problem.kind !== 'unreadable-link') {
      continue;
    }
    const file = relativeTo(projectPath, problem.path);
    const key = `${problem.kind}:${file}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    switch (problem.kind) {
      case 'unreadable-folder':
      case 'missing':
        warnings.push(
          withFile(file, {
            code: 'folder-unreadable',
            detail: problem.code,
            message: `${file.length === 0 ? 'The project folder' : file} could not be read (${problem.code}), so what it holds is not listed.`,
          }),
        );
        break;
      case 'unreadable-link':
        warnings.push(
          withFile(file, {
            code: 'link-broken',
            detail: problem.code,
            message: `${file} is a link to something that cannot be read (${problem.code}), so it is skipped.`,
          }),
        );
        break;
      case 'link-cycle':
        warnings.push(withFile(file, { code: 'link-cycle', message: `${file} is a link back into a folder that is already listed, so it is skipped.` }));
        break;
      default: {
        const exhaustive: never = problem.kind;
        throw new Error(`Assertion failed: unhandled walk problem ${String(exhaustive)}`);
      }
    }
  }
  return warnings;
}

/** What the astro.config says that Stacki could not use: unreadable, computed, or moved source folders. */
export function configWarnings(pages: AstroPages): readonly ScanWarning[] {
  const { configFile } = pages;
  if (configFile === undefined) {
    return [];
  }
  const warnings: ScanWarning[] = [];
  if (pages.unreadable !== undefined) {
    warnings.push({
      code: 'config-unreadable',
      file: configFile,
      detail: pages.unreadable,
      message: `${configFile} could not be read (${pages.unreadable}), so Astro's default folders are assumed.`,
    });
  }
  for (const setting of pages.computed) {
    warnings.push({
      code: 'config-computed',
      file: configFile,
      detail: setting,
      message: `${configFile} computes ${setting} in code, which Stacki does not run; Astro's default is assumed.`,
    });
  }
  const sourceFolder = pages.literals.srcDir;
  if (sourceFolder !== undefined && sourceFolder !== ASTRO_SOURCE_DIRECTORY_DEFAULT) {
    warnings.push({
      code: 'config-folder-custom',
      file: configFile,
      detail: `srcDir=${sourceFolder}`,
      message: `${configFile} sets srcDir to ${sourceFolder}: pages are read from ${pages.pagesFolder}.`,
    });
  }
  return warnings;
}

/** The packages are not installed: the preview cannot start until the project's manager installs them. */
export function dependencyWarning(manager: PackageManager): ScanWarning {
  return {
    code: 'dependencies-missing',
    detail: manager,
    message: `Astro is not installed for this project. Run ${packageManagerLabel(manager)} install to start the preview.`,
  };
}

/** A scan step threw: the step is named so the rest of the scan's results are still shown. */
export function stepFailedWarning(step: string, error: unknown): ScanWarning {
  const reason = error instanceof Error ? error.message : String(error);
  return { code: 'scan-step-failed', detail: step, message: `The ${step} could not be scanned: ${reason}` };
}
