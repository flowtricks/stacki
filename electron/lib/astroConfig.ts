// The project's astro.config as the project scan needs it: which file Astro loads, where it
// says pages live (`srcDir`), and which structural settings it computes instead of writing.
// The config is read as text and never run (shared/properties/astroConfigText.ts).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { readConfigText, settingOf, type ConfigReading } from '../../shared/properties/astroConfigText';
import { ASTRO_CONFIG_FILES, pagesFolderOf, projectFolderOfLiteral, sourceDirectoryFromConfig } from '../../shared/properties/astroSourceDirectory';

/** The settings that decide where a project's own files are; a computed one is surfaced, not guessed. */
export const ASTRO_STRUCTURE_SETTINGS = ['srcDir', 'publicDir', 'outDir', 'root', 'cacheDir'] as const;
export type AstroStructureSetting = (typeof ASTRO_STRUCTURE_SETTINGS)[number];

export interface AstroPages {
  /** Project-relative: `src/pages`, or `<srcDir>/pages`. */
  readonly pagesFolder: string;
  /** The config file Astro loads, project-relative; undefined when the project has none. */
  readonly configFile: string | undefined;
  /** Set when the config file exists but could not be read: the error code (`EACCES`, `EISDIR`). */
  readonly unreadable?: string;
  /** Structure settings the config computes (an environment read, a variable, a spread): Astro's default is assumed. */
  readonly computed: readonly AstroStructureSetting[];
  /** Structure settings written as plain text, as written, so the scan can say where they differ from the default. */
  readonly literals: Readonly<Partial<Record<AstroStructureSetting, string>>>;
}

export function readAstroPages(projectPath: string): AstroPages {
  assert(projectPath.length > 0, 'readAstroPages: the project is named');
  for (const file of ASTRO_CONFIG_FILES) {
    const full = path.join(projectPath, file);
    if (!fs.existsSync(full)) {
      continue;
    }
    // The first config that exists is the one Astro loads, even when it cannot be read.
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
      return { pagesFolder: pagesFolderOf(undefined), configFile: file, unreadable: code, computed: [], literals: {} };
    }
    const reading = readConfigText(text);
    return {
      pagesFolder: pagesFolderOf(sourceDirectoryFromConfig(text)),
      configFile: file,
      computed: computedSettings(reading),
      literals: literalSettings(reading),
    };
  }
  return { pagesFolder: pagesFolderOf(undefined), configFile: undefined, computed: [], literals: {} };
}

function computedSettings(reading: ConfigReading): readonly AstroStructureSetting[] {
  return ASTRO_STRUCTURE_SETTINGS.filter((key) => settingOf(reading, key).kind === 'computed');
}

function literalSettings(reading: ConfigReading): Readonly<Partial<Record<AstroStructureSetting, string>>> {
  const literals: Partial<Record<AstroStructureSetting, string>> = {};
  for (const key of ASTRO_STRUCTURE_SETTINGS) {
    const setting = settingOf(reading, key);
    if (setting.kind === 'literal') {
      literals[key] = projectFolderOfLiteral(setting.value) ?? setting.value;
    }
  }
  return literals;
}

/** The absolute pages folder Astro reads: `<project>/<srcDir>/pages`. */
export function pagesDirectoryOf(projectPath: string): string {
  return path.join(projectPath, ...readAstroPages(projectPath).pagesFolder.split('/'));
}
