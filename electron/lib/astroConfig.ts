// The project's astro.config as the pages folder needs it: which file Astro
// loads, and the `srcDir` it sets as a literal (shared/properties/astroSourceDirectory.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { ASTRO_CONFIG_FILES, pagesFolderOf, sourceDirectoryFromConfig } from '../../shared/properties/astroSourceDirectory';

/** A config larger than this is not read for `srcDir`; Astro's default applies. */
const ASTRO_CONFIG_BYTES_MAX = 1024 * 1024;

export interface AstroPages {
  /** Project-relative: `src/pages`, or `<srcDir>/pages`. */
  readonly pagesFolder: string;
  /** The config file Astro loads, project-relative; undefined when the project has none. */
  readonly configFile: string | undefined;
}

export function readAstroPages(projectPath: string): AstroPages {
  assert(projectPath.length > 0, 'readAstroPages: the project is named');
  for (const file of ASTRO_CONFIG_FILES) {
    const full = path.join(projectPath, file);
    let text: string;
    try {
      if (fs.statSync(full).size > ASTRO_CONFIG_BYTES_MAX) {
        return { pagesFolder: pagesFolderOf(undefined), configFile: file };
      }
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    // The first config that exists is the one Astro loads.
    return { pagesFolder: pagesFolderOf(sourceDirectoryFromConfig(text)), configFile: file };
  }
  return { pagesFolder: pagesFolderOf(undefined), configFile: undefined };
}
