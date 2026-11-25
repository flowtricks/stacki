// The project scan: what 'project:scan' returns. pages/layouts/components are
// separate arrays in the payload; the contract keeps them separate so the
// renderer can never confuse a page route with a component folder.

import { LIMITS } from '../core/limits';
import { parseComponentOrigin, type ComponentOrigin } from './componentSources';
import { parseField, type PropField } from './propSchema';
import { parseLengthUnit, type LengthUnit } from './lengthUnit';
import { PACKAGE_MANAGERS, type PackageManager } from './packageManager';

export interface ScanPage {
  readonly path: string;
  /** POSIX path relative to src/pages — the route's file identity. */
  readonly name: string;
  readonly route: string;
  /** Literal layout title for display; name remains the route file identity. */
  readonly title?: string | undefined;
  /** Wrapper's literal title, used when a live page removes its own override. */
  readonly inheritedTitle?: string | undefined;
}

export interface RenderTag {
  readonly tag?: string;
  readonly prop?: string;
}

/**
 * What a scan could not do, or did by assumption, and which file it concerns. A warning never
 * blocks the project: everything else is still listed. The code is stable and machine-readable
 * (the UI picks its wording and its action from it); `message` is the English sentence naming
 * the file and the reason, for a log or a UI with nothing better.
 */
export const SCAN_WARNING_CODES = [
  /** The project's packages are not installed (`detail`: the package manager that would install them). */
  'dependencies-missing',
  /** A folder could not be listed (`detail`: the system error code). Its contents are missing from the lists. */
  'folder-unreadable',
  /** A symbolic link points at nothing or at something unreadable (`detail`: the error code). It is skipped. */
  'link-broken',
  /** A symbolic link leads back into a folder already listed. It is skipped, so the walk ends. */
  'link-cycle',
  /** The astro.config exists but could not be read (`detail`: the error code). Astro's defaults are assumed. */
  'config-unreadable',
  /** The astro.config computes a setting (`detail`: its name) that Stacki reads as text. Astro's default is assumed. */
  'config-computed',
  /** The astro.config moves a source folder away from its default (`detail`: `srcDir=website`). */
  'config-folder-custom',
  /** One step of the scan failed (`detail`: the step). The other steps' results are still here. */
  'scan-step-failed',
] as const;
export type ScanWarningCode = (typeof SCAN_WARNING_CODES)[number];

export interface ScanWarning {
  readonly code: ScanWarningCode;
  readonly message: string;
  /** The project-relative POSIX path the warning is about; absent when it concerns the project as a whole. */
  readonly file?: string | undefined;
  readonly detail?: string | undefined;
}

export interface ScanComponent {
  readonly origin?: ComponentOrigin;
  readonly path: string;
  /** Project-relative, `/`-separated (`src/ui/Card.astro`). Absent for a package component and from an older host. */
  readonly file?: string;
  readonly name: string;
  readonly folder: string;
  readonly isLayout?: boolean;
  readonly instances?: number;
  /**
   * Where `instances` come from: each file that uses the component and how often, files with none
   * left out, summing to `instances`. Absent from an older host. The Components panel swaps the open
   * file's share for its live tree's count, so an edit shows in the count in the frame it is made in.
   */
  readonly uses?: readonly ScanComponentUse[];
  // safeSchema output — absent when the component's source could not be read.
  readonly schema?: readonly PropField[];
  readonly extendsTag?: string | undefined;
  readonly slots?: readonly string[];
  readonly slotText?: boolean;
  readonly renderTag?: RenderTag | undefined;
  /** The component the template opens with (`Section` for `<Section>…`), when the root is one. */
  readonly rootComponent?: string | undefined;
  readonly hasRest?: boolean;
}

/** One file's share of a component's instance count (ScanComponent.uses). */
export interface ScanComponentUse {
  /** Project-relative and `/`-separated on every platform (`src/pages/index.astro`). */
  readonly file: string;
  /** At least one: a file that uses the component none is not listed. */
  readonly count: number;
}

export interface ScanResult {
  readonly pages: readonly ScanPage[];
  readonly pageFolders: readonly string[];
  readonly layouts: readonly ScanComponent[];
  readonly components: readonly ScanComponent[];
  readonly trailingSlash?: string;
  /** What the style panel writes lengths in (lengthUnit.ts). Absent from an older host → px. */
  readonly lengthUnit?: LengthUnit;
  /** Where Astro reads pages: `<srcDir>/pages` from astro.config. Absent from an older host → src/pages. */
  readonly pagesFolder?: string;
  /** The astro.config file Astro loads, project-relative; absent when there is none. */
  readonly astroConfig?: string;
  /** The package manager the project uses (package.json's `packageManager`, else its lockfile, else npm), looking through parent folders. */
  readonly packageManager?: PackageManager;
  /** What the scan could not read or had to assume; absent from an older host, empty when nothing. */
  readonly warnings?: readonly ScanWarning[];
}

function fail(where: string, what: string): never {
  throw new Error(`ScanResult.${where}: ${what}`);
}

/** The scan payload carries each component's schema as an ARRAY of fields —
 * the shape the project:scan handler assembles and the props panel reads. Validate every field
 * with the same parser the Map shape uses, so both stay in agreement. */
function parseSchemaArray(input: unknown, where: string): readonly PropField[] {
  if (!Array.isArray(input)) {
    fail(where, 'expected array of fields');
  }
  if (input.length > LIMITS.propSchemaFieldsMax) {
    fail(where, `exceeds ${LIMITS.propSchemaFieldsMax} fields`);
  }
  return input.map((field, index) => parseField(field, `${where}[${index}]`)) as readonly PropField[];
}

function asString(value: unknown, where: string): string {
  if (typeof value !== 'string') {
    fail(where, 'expected string');
  }
  if (value.length > LIMITS.ipcFieldCharsMax) {
    fail(where, `exceeds ${LIMITS.ipcFieldCharsMax} chars`);
  }
  return value;
}

function asArray(input: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(input)) {
    fail(where, 'expected array');
  }
  if (input.length > max) {
    fail(where, `exceeds ${max} entries`);
  }
  return input;
}

function asRecord(input: unknown, where: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    fail(where, 'expected object');
  }
  return input as Record<string, unknown>;
}

function parsePage(input: unknown, where: string): ScanPage {
  const record = asRecord(input, where);
  return {
    path: asString(record['path'], `${where}.path`),
    name: asString(record['name'], `${where}.name`),
    route: asString(record['route'], `${where}.route`),
    ...(record['title'] === undefined ? {} : { title: asString(record['title'], `${where}.title`) }),
    ...(record['inheritedTitle'] === undefined ? {} : { inheritedTitle: asString(record['inheritedTitle'], `${where}.inheritedTitle`) }),
  };
}

function parseComponentUses(input: unknown, where: string): readonly ScanComponentUse[] {
  const files = new Set<string>();
  return asArray(input, where, LIMITS.scanEntriesMax).map((entry, index) => {
    const record = asRecord(entry, `${where}[${index}]`);
    const file = asString(record['file'], `${where}[${index}].file`);
    if (file.length === 0 || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..')) {
      fail(`${where}[${index}]`, 'file: expected a project-relative, /-separated path');
    }
    if (files.has(file)) {
      fail(`${where}[${index}]`, 'file: listed twice');
    }
    files.add(file);
    const count = record['count'];
    if (typeof count !== 'number' || !Number.isSafeInteger(count)) {
      fail(`${where}[${index}]`, 'count: expected an integer');
    }
    if (count < 1) {
      fail(`${where}[${index}]`, 'count: a file that uses the component none is left out');
    }
    return { file, count };
  });
}

function parseComponent(input: unknown, where: string): ScanComponent {
  const record = asRecord(input, where);
  const out: Record<string, unknown> = {
    ...(record['origin'] === undefined ? {} : { origin: parseComponentOrigin(record['origin']) }),
    path: asString(record['path'], `${where}.path`),
    name: asString(record['name'], `${where}.name`),
    folder: asString(record['folder'], `${where}.folder`),
  };
  if (record['file'] !== undefined) {
    const file = asString(record['file'], `${where}.file`);
    if (file.length === 0 || file.startsWith('/') || file.split('/').includes('..')) {
      fail(where, 'file: expected a project-relative path');
    }
    out['file'] = file;
  }
  if (record['isLayout'] !== undefined) {
    if (record['isLayout'] !== true) {
      fail(where, 'isLayout: only true is ever written');
    }
    out['isLayout'] = true;
  }
  if (record['instances'] !== undefined) {
    if (!Number.isSafeInteger(record['instances']) || Number(record['instances']) < 0) {
      fail(where, 'instances: expected nonnegative integer');
    }
    out['instances'] = record['instances'];
  }
  if (record['uses'] !== undefined) {
    if (out['instances'] === undefined) {
      fail(where, 'uses: written only beside instances');
    }
    const uses = parseComponentUses(record['uses'], `${where}.uses`);
    // The pair the panel's arithmetic stands on: the shares add up to the total they explain.
    if (uses.reduce((total, use) => total + use.count, 0) !== out['instances']) {
      fail(where, 'uses: counts do not sum to instances');
    }
    out['uses'] = uses;
  }
  if (record['schema'] !== undefined) {
    out['schema'] = parseSchemaArray(record['schema'], `${where}.schema`);
  }
  if (record['extendsTag'] !== undefined) {
    out['extendsTag'] = asString(record['extendsTag'], `${where}.extendsTag`);
  }
  if (record['renderTag'] !== undefined) {
    const renderTag = asRecord(record['renderTag'], `${where}.renderTag`);
    const tag = renderTag['tag'];
    if (tag !== undefined && typeof tag !== 'string') {
      fail(where, 'renderTag.tag: expected string');
    }
    const prop = renderTag['prop'];
    if (prop !== undefined && typeof prop !== 'string') {
      fail(where, 'renderTag.prop: expected string');
    }
    out['renderTag'] = { tag, prop };
  }
  if (record['rootComponent'] !== undefined) {
    const rootComponent = asString(record['rootComponent'], `${where}.rootComponent`);
    if (rootComponent.length === 0) {
      fail(where, 'rootComponent: expected non-empty string');
    }
    if (rootComponent.length > LIMITS.tagNameCharsMax) {
      fail(where, `rootComponent: exceeds ${LIMITS.tagNameCharsMax} chars`);
    }
    out['rootComponent'] = rootComponent;
  }
  if (record['slots'] !== undefined) {
    const slots = asArray(record['slots'], `${where}.slots`, LIMITS.propOptionsMax);
    if (!slots.every((slot) => typeof slot === 'string')) {
      fail(where, 'slots: expected strings');
    }
    out['slots'] = slots as readonly string[];
  }
  if (record['slotText'] !== undefined) {
    if (typeof record['slotText'] !== 'boolean') {
      fail(where, 'slotText: expected boolean');
    }
    out['slotText'] = record['slotText'];
  }
  if (record['hasRest'] !== undefined) {
    if (typeof record['hasRest'] !== 'boolean') {
      fail(where, 'hasRest: expected boolean');
    }
    out['hasRest'] = record['hasRest'];
  }
  return out as unknown as ScanComponent;
}

export function parseScanResult(input: unknown): ScanResult {
  const record = asRecord(input, 'root');
  const result: Record<string, unknown> = {
    pages: parseScanPages(record['pages']),
    pageFolders: asArray(record['pageFolders'], 'pageFolders', LIMITS.scanFoldersMax).map((folder, index) => asString(folder, `pageFolders[${index}]`)),
    layouts: asArray(record['layouts'], 'layouts', LIMITS.scanEntriesMax).map((entry, index) => parseComponent(entry, `layouts[${index}]`)),
    components: asArray(record['components'], 'components', LIMITS.scanEntriesMax).map((entry, index) => parseComponent(entry, `components[${index}]`)),
  };
  if (record['trailingSlash'] !== undefined) {
    result['trailingSlash'] = asString(record['trailingSlash'], 'trailingSlash');
  }
  if (record['lengthUnit'] !== undefined) {
    result['lengthUnit'] = parseLengthUnit(record['lengthUnit']);
  }
  for (const key of ['pagesFolder', 'astroConfig'] as const) {
    if (record[key] !== undefined) {
      const value = asString(record[key], key);
      if (value.length === 0 || value.startsWith('/') || value.split('/').includes('..')) {
        fail(key, 'expected a project-relative path');
      }
      result[key] = value;
    }
  }
  if (record['packageManager'] !== undefined) {
    const manager = PACKAGE_MANAGERS.find((candidate) => candidate === record['packageManager']);
    if (manager === undefined) {
      fail('packageManager', `expected ${PACKAGE_MANAGERS.join(', ')}`);
    }
    result['packageManager'] = manager;
  }
  if (record['warnings'] !== undefined) {
    result['warnings'] = parseScanWarnings(record['warnings']);
  }
  return result as unknown as ScanResult;
}

export function parseScanWarnings(input: unknown): readonly ScanWarning[] {
  return asArray(input, 'warnings', LIMITS.scanEntriesMax).map((entry, index) => parseScanWarning(entry, `warnings[${index}]`));
}

function parseScanWarning(input: unknown, where: string): ScanWarning {
  const record = asRecord(input, where);
  const code = SCAN_WARNING_CODES.find((candidate) => candidate === record['code']);
  if (code === undefined) {
    fail(`${where}.code`, `expected one of ${SCAN_WARNING_CODES.join(', ')}`);
  }
  const message = asString(record['message'], `${where}.message`);
  if (message.length === 0) {
    fail(`${where}.message`, 'expected a sentence naming the problem');
  }
  const file = record['file'] === undefined ? undefined : asString(record['file'], `${where}.file`);
  if (file !== undefined && (file.length === 0 || file.startsWith('/') || file.split('/').includes('..'))) {
    fail(`${where}.file`, 'expected a project-relative path');
  }
  const detail = record['detail'] === undefined ? undefined : asString(record['detail'], `${where}.detail`);
  return { code, message, ...(file === undefined ? {} : { file }), ...(detail === undefined ? {} : { detail }) };
}

export function parseScanPages(input: unknown): readonly ScanPage[] {
  return asArray(input, 'pages', LIMITS.scanEntriesMax).map((entry, index) => parsePage(entry, `pages[${index}]`));
}
