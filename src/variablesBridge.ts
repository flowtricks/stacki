import type { Parser } from '../shared/boundary';
import type { Result } from '../shared/result';
import type { WireCell, WireColumn } from '../shared/ipc-results';
import {
  boolean,
  count,
  dictionary,
  nullable,
  object,
  optional,
  pathText,
  record,
  text,
} from '../shared/boundary';
import { toArray } from '../shared/record';
import { toProjectPath } from '../shared/brand';

export interface VariableSelection {
  readonly file: string;
  readonly index: number;
}
export interface VariableCell extends WireCell {
  readonly ref?: string | null;
  readonly resolved?: string | null;
  readonly color?: string | null;
  readonly unknownColor?: boolean;
  readonly kind?: string;
}
export interface VariableRow {
  readonly label: string;
  readonly name?: string;
  readonly cells: readonly (VariableCell | null)[];
}
interface VariableBlockBase {
  readonly title: string | null;
  readonly titleStart?: number;
  readonly titleEnd?: number;
  readonly rows: readonly VariableRow[];
}
export type VariableBlock = VariableBlockBase &
  (
    | { readonly kind: 'rows'; readonly columns?: readonly WireColumn[] }
    | { readonly kind: 'matrix'; readonly columns: readonly WireColumn[] }
  );
export interface VariableGroup {
  readonly kind: 'modes' | 'single';
  readonly label: string;
  readonly columns: readonly WireColumn[];
  readonly blocks: readonly VariableBlock[];
}
export interface VariableFile {
  readonly rel: string;
  readonly name: string;
  readonly groups: readonly VariableGroup[];
  readonly error?: string;
  readonly count?: number;
}
export interface VariablesSnapshot {
  readonly files: readonly VariableFile[];
  readonly values: Readonly<Record<string, string>>;
}
export const VARIABLES_LIMITS = { entriesMax: 100_000, fileCharsMax: 1_048_576 } as const;
const PRIVATE_VARIABLE_PREFIX = '--_';

export function parseCSSVariables(input: unknown): Result<VariablesSnapshot, string> {
  const source = record(input);
  const budget = new VariablesBudget();
  const files = budget.list(variableFileParser(budget))(source['files']);
  if (source['error'] !== undefined) {
    if (files.length !== 0) {
      throw new Error('CSSVariables: failed scan contains files');
    }
    return { ok: false, error: text(source['error']) };
  }
  return { ok: true, value: { files, values: dictionary(variableText)(source['values']) } };
}

export async function readCSSVariables(
  projectPath: string,
): Promise<Result<VariablesSnapshot, string>> {
  const path = toProjectPath(projectPath);
  let response: unknown;
  try {
    response = await window.avb.cssVariables(path);
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  // Invalid wire shapes indicate a contract bug, so parsing stays outside the I/O catch.
  const result = parseCSSVariables(response);
  return result.ok ? { ok: true, value: variablesForPanel(result.value) } : result;
}

// A leading underscore marks a private implementation token. The values map stays
// complete because visible variables may resolve through private variables even though
// the private declarations themselves do not belong in the panel.
function variablesForPanel(snapshot: VariablesSnapshot): VariablesSnapshot {
  const files = snapshot.files.map(variableFileForPanel);
  return { files, values: snapshot.values };
}

function variableFileForPanel(file: VariableFile): VariableFile {
  if (file.error !== undefined) {
    return file;
  }
  const groups = file.groups
    .map((group) => ({
      ...group,
      blocks: group.blocks
        .map(variableBlockForPanel)
        .filter((block): block is VariableBlock => block !== undefined),
    }))
    .filter((group) => variableGroupCount(group) > 0);
  const count = groups.reduce((total, group) => total + variableGroupCount(group), 0);
  return { ...file, groups, count };
}

function variableGroupCount(group: VariableGroup): number {
  return group.blocks.reduce(
    (blockTotal, block) =>
      blockTotal +
      block.rows.reduce(
        (rowTotal, row) => rowTotal + row.cells.filter((cell) => cell !== null).length,
        0,
      ),
    0,
  );
}

function variableBlockForPanel(block: VariableBlock): VariableBlock | undefined {
  const rows = block.rows
    .map(variableRowForPanel)
    .filter((row): row is VariableRow => row !== undefined);
  if (block.rows.length > 0 && rows.length === 0) {
    return undefined;
  }
  if (block.kind === 'matrix') {
    return { ...block, rows };
  }
  return { ...block, rows };
}

function variableRowForPanel(row: VariableRow): VariableRow | undefined {
  const cells = row.cells.map((cell) =>
    cell?.name.startsWith(PRIVATE_VARIABLE_PREFIX) ? null : cell,
  );
  if (!cells.some((cell) => cell !== null)) {
    return undefined;
  }
  return { ...row, cells };
}

// One budget covers all nested collections, so separate small arrays cannot evade the cap.
class VariablesBudget {
  private remaining = VARIABLES_LIMITS.entriesMax;
  list<T>(parse: Parser<T>): Parser<readonly T[]> {
    return (input) => {
      const values = toArray(input);
      if (!values) {
        throw new Error('CSSVariables: expected array');
      }
      if (values.length > this.remaining) {
        throw new Error('CSSVariables: entry limit exceeded');
      }
      this.remaining -= values.length;
      return values.map(parse);
    };
  }
}
function variableText(input: unknown): string {
  const value = text(input);
  if (value.length > VARIABLES_LIMITS.fileCharsMax) {
    throw new Error('CSSVariables: text limit exceeded');
  }
  return value;
}
function sourceOffset(input: unknown): number {
  const value = count(input);
  if (value > VARIABLES_LIMITS.fileCharsMax) {
    throw new Error('CSSVariables: source offset limit exceeded');
  }
  return value;
}
function blockKind(input: unknown): VariableBlock['kind'] {
  if (input === 'rows' || input === 'matrix') {
    return input;
  }
  throw new Error('CSSVariables: invalid block kind');
}
function groupKind(input: unknown): VariableGroup['kind'] {
  if (input === 'modes' || input === 'single') {
    return input;
  }
  throw new Error('CSSVariables: invalid group kind');
}
const cellShape = object({
  name: variableText,
  value: variableText,
  file: pathText,
  selector: variableText,
  valueStart: sourceOffset,
  valueEnd: sourceOffset,
  line: count,
  column: variableText,
  ref: optional(nullable(variableText)),
  resolved: optional(nullable(variableText)),
  color: optional(nullable(variableText)),
  unknownColor: optional(boolean),
  kind: optional(variableText),
});
function parseVariableCell(input: unknown): VariableCell {
  const cell = cellShape(input);
  if (cell.valueEnd < cell.valueStart) {
    throw new Error('CSSVariables: reversed value range');
  }
  return cell;
}
function columnParser(budget: VariablesBudget): Parser<WireColumn> {
  return object({
    id: variableText,
    label: variableText,
    selector: variableText,
    context: budget.list(variableText),
    line: count,
  });
}
function variableFileParser(budget: VariablesBudget): Parser<VariableFile> {
  const column = columnParser(budget);
  const row = object({
    label: variableText,
    name: optional(variableText),
    cells: budget.list(nullable(parseVariableCell)),
  });
  const blockShape = object({
    kind: blockKind,
    title: nullable(variableText),
    titleStart: optional(sourceOffset),
    titleEnd: optional(sourceOffset),
    rows: budget.list(row),
    columns: optional(budget.list(column)),
  });
  const block = (input: unknown): VariableBlock => {
    const parsed = blockShape(input);
    if (parsed.titleStart !== undefined && parsed.titleEnd !== undefined) {
      if (parsed.titleEnd < parsed.titleStart) {
        throw new Error('CSSVariables: reversed title range');
      }
    }
    if (parsed.kind === 'matrix') {
      if (parsed.columns === undefined) {
        throw new Error('CSSVariables: matrix columns are required');
      }
      return { ...parsed, kind: 'matrix', columns: parsed.columns };
    }
    return { ...parsed, kind: 'rows' };
  };
  const group = object({
    kind: groupKind,
    label: variableText,
    columns: budget.list(column),
    blocks: budget.list(block),
  });
  return object({
    rel: pathText,
    name: variableText,
    groups: budget.list(group),
    error: optional(variableText),
    count: optional(count),
  });
}
