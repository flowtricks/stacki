// A custom host on Desktop and Studio's server: the package.json scripts a deploy script is chosen from, and
// whether the chosen one is still there, asked before anything is built or pushed.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { packageScriptNames } from '../../shared/properties/publishDeployLink';

const PACKAGE_BYTES_MAX = 1_048_576;

/** The scripts to choose from. A missing, unreadable or oversized package.json offers none. */
export async function readPackageScripts(root: string): Promise<readonly string[]> {
  const file = path.join(root, 'package.json');
  try {
    if ((await stat(file)).size > PACKAGE_BYTES_MAX) {
      return [];
    }
    return packageScriptNames(await readFile(file, 'utf8'));
  } catch {
    return [];
  }
}

export async function checkDeployScript(root: string, script: string): Promise<Result<undefined, Described>> {
  const scripts = await readPackageScripts(root);
  return scripts.includes(script) ? ok(undefined) : err(described('publish.custom.script.missing', { script }));
}
