// The project scan: what 'project:scan' returns. pages/layouts/components are
// separate arrays in the payload; the contract keeps them separate so the
// renderer can never confuse a page route with a component folder.

import { LIMITS } from '../core/limits';
import { parseComponentOrigin, type ComponentOrigin } from './componentSources';
import { parseField, type PropField } from './propSchema';
import { parseLengthUnit, type LengthUnit } from './lengthUnit';

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

export interface ScanComponent {
  readonly origin?: ComponentOrigin;
  readonly path: string;
  readonly name: string;
  readonly folder: string;
  readonly isLayout?: boolean;
  readonly instances?: number;
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

export interface ScanResult {
  readonly pages: readonly ScanPage[];
  readonly pageFolders: readonly string[];
  readonly layouts: readonly ScanComponent[];
  readonly components: readonly ScanComponent[];
  readonly trailingSlash?: string;
  /** What the style panel writes lengths in (lengthUnit.ts). Absent from an older host → px. */
  readonly lengthUnit?: LengthUnit;
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

function parseComponent(input: unknown, where: string): ScanComponent {
  const record = asRecord(input, where);
  const out: Record<string, unknown> = {
    ...(record['origin'] === undefined ? {} : { origin: parseComponentOrigin(record['origin']) }),
    path: asString(record['path'], `${where}.path`),
    name: asString(record['name'], `${where}.name`),
    folder: asString(record['folder'], `${where}.folder`),
  };
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
  return result as unknown as ScanResult;
}

export function parseScanPages(input: unknown): readonly ScanPage[] {
  return asArray(input, 'pages', LIMITS.scanEntriesMax).map((entry, index) => parsePage(entry, `pages[${index}]`));
}
