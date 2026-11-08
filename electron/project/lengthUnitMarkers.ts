// Reads the files a project's length unit is derived from — package.json,
// LUMOS.md and the global stylesheets in src/styles — and derives it
// (shared/properties/lengthUnit.ts). Desktop's scan and Studio's project scan
// both call this, so the two can never disagree about a project.
//
// Every read is bounded and every failure is absence: a missing or unreadable
// file says nothing about the project, and the scan must not fail over it.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { detectLengthUnit, LENGTH_UNIT_LIMITS, type LengthUnit } from '../../shared/properties/lengthUnit';

/** The project's length unit: rem for a Lumos project, px otherwise. */
export function readLengthUnit(root: string): LengthUnit {
  assert(path.isAbsolute(root), 'readLengthUnit: the project root is absolute');
  const manifest = readBounded(path.join(root, 'package.json'), LENGTH_UNIT_LIMITS.manifestCharsMax);
  const lumosGuide = isPlainFile(path.join(root, 'LUMOS.md'));
  const stylesheets = lumosGuide || manifest !== undefined ? readStylesheets(path.join(root, 'src', 'styles')) : [];
  assert(stylesheets.length <= LENGTH_UNIT_LIMITS.stylesheetsMax, 'readLengthUnit: stylesheet count is bounded');
  return detectLengthUnit({ manifest, lumosGuide, stylesheets });
}

// The top-level .css files of src/styles, sorted so the result does not depend on
// the directory's order. Lumos keeps its root rules there (global.css, base.css).
function readStylesheets(directory: string): readonly string[] {
  let names: readonly string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const sheets = names
    .filter((name) => name.endsWith('.css'))
    .sort()
    .slice(0, LENGTH_UNIT_LIMITS.stylesheetsMax);
  return sheets.flatMap((name) => {
    const text = readBounded(path.join(directory, name), LENGTH_UNIT_LIMITS.stylesheetCharsMax);
    return text === undefined ? [] : [text];
  });
}

// A regular file's text, or undefined when it is absent, a link, too large or unreadable.
function readBounded(file: string, charsMax: number): string | undefined {
  if (!isPlainFile(file)) {
    return undefined;
  }
  try {
    if (fs.statSync(file).size > charsMax * 4) {
      return undefined; // UTF-8 spends at most four bytes on a character.
    }
    const text = fs.readFileSync(file, 'utf8');
    return text.length > charsMax ? undefined : text;
  } catch {
    return undefined;
  }
}

// Symbolic links are refused: a project-authored link must not point the scan elsewhere.
function isPlainFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}
