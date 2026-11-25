import { record, sourcePath, string } from '../../shared/validation';

export const CURSOR_INTERVAL = 50;
export const CURSOR_MESSAGE_LIMIT = 160;
export interface CursorPosition {
  readonly x: number;
  readonly y: number;
  readonly anchor?: {
    readonly path: string;
    readonly occurrence: number;
    readonly x: number;
    readonly y: number;
  };
}
export interface CursorState {
  readonly page: string;
  readonly cursor: CursorPosition | null;
  readonly text: string;
  readonly typing: boolean;
}
export interface CursorPacket extends CursorState {
  readonly id: string;
  readonly name: string;
  readonly color: number;
}
export function parseCursorState(input: unknown): CursorState {
  const value = record(input);
  return {
    page: sourcePath(string(value['page'], 500)),
    cursor: value['cursor'] === null ? null : parsePosition(value['cursor']),
    text: string(value['text'] ?? '', CURSOR_MESSAGE_LIMIT),
    typing: value['typing'] === true,
  };
}
export function parseCursorPacket(input: unknown): CursorPacket {
  const value = record(input);
  return {
    ...parseCursorState(value),
    id: string(value['id'], 100),
    name: string(value['name'], 100),
    color: colorIndex(value['color']),
  };
}
export function colorIndex(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4095) {
    throw new Error('Invalid collaborator color');
  }
  return value;
}
function parsePosition(input: unknown): CursorPosition {
  const value = record(input);
  const anchor = value['anchor'] === undefined ? undefined : record(value['anchor']);
  return {
    x: fraction(value['x']),
    y: fraction(value['y']),
    ...(anchor ? { anchor: parseAnchor(anchor) } : {}),
  };
}
function parseAnchor(value: Record<string, unknown>): NonNullable<CursorPosition['anchor']> {
  const path = string(value['path'], 500);
  const occurrence = value['occurrence'];
  if (!/^\d+(\.\d+)*$/.test(path) || typeof occurrence !== 'number' || !Number.isInteger(occurrence) || occurrence < 0 || occurrence > 10000) {
    throw new Error('Invalid cursor anchor');
  }
  return { path, occurrence, x: fraction(value['x']), y: fraction(value['y']) };
}
function fraction(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Invalid cursor position');
  }
  return value;
}
