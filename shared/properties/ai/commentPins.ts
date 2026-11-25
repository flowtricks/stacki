// Comment pins: notes the person drops on elements of a page in comment mode (the AI panel's Modes menu),
// each a small message of its own with words and images, sent to the open chat together with "Send all".
// This file is the contract every side reads (docs/contracts.md, "Comment pins"): the board the renderer
// keeps and the main process stores, the brief a send carries on `ai:prompt`, what the transcript keeps of
// it, and the pure rules that decide which pins may run at the same time.
//
// Why the board lives outside the project: pins are one person's working notes, like chats, so they are kept
// under userData (electron/handlers/ai/pinBoardStore.ts) and never committed. Images are part of a pin (the
// crop of what it points at is the point), so unlike a composer draft they are stored, in files of their own
// beside the board, and removed with the pin.
import { assert } from '../../core/assert';
import type { Brand } from '../../core/brand';
import { toArray, toRecord } from '../../core/record';
import { AI_LIMITS } from './aiLimits';
import { PIN_LIMITS, PIN_SEND_MODES, type PinSendMode } from './commentPinBrief';
import { toChatId, toTurnId, type ChatId, type TurnId } from './chatModel';
import { isProjectRelativePath } from './mentions';

export type PinId = Brand<string, 'PinId'>;
export type PinImageId = Brand<string, 'PinImageId'>;

const PIN_ID = /^p[0-9a-f]{16}$/;
const IMAGE_ID = /^i[0-9a-f]{16}$/;

export function toPinId(value: string): PinId {
  if (!PIN_ID.test(value)) {
    throw new Error('PinId: expected p<16 hex>');
  }
  assert(value.length === 17, 'PinId: fixed length');
  return value as PinId;
}

export function toPinImageId(value: string): PinImageId {
  if (!IMAGE_ID.test(value)) {
    throw new Error('PinImageId: expected i<16 hex>');
  }
  assert(value.length === 17, 'PinImageId: fixed length');
  return value as PinImageId;
}

/** A point inside the element's box, 0 to 1 across and down, so it follows the element however it is drawn. */
export interface PinPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * What the pin is stuck to, on the canvas. `path` is the canvas path the click landed on (the open file's
 * child indexes, `<file>|` scoped inside an open component); `tag` and `text` are kept to find the element
 * again when an edit moved it to another path.
 */
export interface PinAnchor {
  readonly path: string;
  readonly occurrence: number;
  readonly at: PinPoint;
  readonly tag: string;
  readonly text: string | undefined;
}

/** Where the pin is, in words a person reads and in the paths the agent needs. */
export interface PinPlace {
  /** The page the canvas showed, relative to the project (`src/pages/index.astro`). */
  readonly page: string;
  readonly pageLabel: string;
  /** The component file open on the canvas when the pin was dropped, relative to the project; undefined on the page itself. */
  readonly scope: string | undefined;
  /** The file the element is written in, relative to the project. */
  readonly file: string;
  /** The element's child indexes in that file (`0.2`). */
  readonly locator: string;
  readonly elementLabel: string;
  /** The component file of an instance, when the element is one. */
  readonly componentFile: string | undefined;
  /** The canvas width the pin was dropped at, in CSS pixels; undefined for the fluid canvas. */
  readonly breakpointPx: number | undefined;
}

export const PIN_IMAGE_KINDS = ['crop', 'added'] as const;
/** `crop` is taken of the pinned area when the pin is dropped; `added` was pasted, dropped or picked. */
export type PinImageKind = (typeof PIN_IMAGE_KINDS)[number];

export const PIN_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type PinImageType = (typeof PIN_IMAGE_TYPES)[number];

/** A pin's image as the board names it; its bytes are stored beside the board (`PinImageData`). */
export interface PinImageRef {
  readonly id: PinImageId;
  readonly kind: PinImageKind;
  readonly name: string;
  readonly mimeType: PinImageType;
}

export interface PinImageData {
  readonly id: PinImageId;
  readonly data: string;
}

/** Whether a pin is a draft, or was sent: to which chat, in which turn (none yet while it waits its turn in a `single` send). */
export type PinDelivery =
  | { readonly kind: 'draft' }
  | { readonly kind: 'sent'; readonly chat: ChatId; readonly turn: TurnId | undefined; readonly mode: PinSendMode; readonly at: number };

export interface CommentPin {
  readonly id: PinId;
  /** The number on the pin and in the message: unique on the board. */
  readonly number: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly comment: string;
  readonly images: readonly PinImageRef[];
  readonly anchor: PinAnchor;
  readonly place: PinPlace;
  /** Whether "Send all" takes it. */
  readonly included: boolean;
  readonly delivery: PinDelivery;
}

export interface PinBoard {
  readonly version: 1;
  readonly pins: readonly CommentPin[];
}

export const EMPTY_PIN_BOARD: PinBoard = { version: 1, pins: [] };

/**
 * The board as stored or sent over IPC. Total: anything that is not a board is the empty board, and a pin that
 * does not parse is left out alone, so a damaged file loses only what is damaged. A pin repeating an id or a
 * number already read is left out too; past `pinsMax` the rest are.
 */
export function parsePinBoard(input: unknown): PinBoard {
  const value = toRecord(input);
  const entries = value === undefined || value['version'] !== 1 ? undefined : toArray(value['pins']);
  if (entries === undefined) {
    return EMPTY_PIN_BOARD;
  }
  const pins: CommentPin[] = [];
  const ids = new Set<string>();
  const numbers = new Set<number>();
  for (const entry of entries.slice(0, PIN_LIMITS.pinsMax * 2)) {
    if (pins.length >= PIN_LIMITS.pinsMax) {
      break;
    }
    const pin = tryParse(() => parsePin(entry));
    if (pin !== undefined && !ids.has(pin.id) && !numbers.has(pin.number)) {
      ids.add(pin.id);
      numbers.add(pin.number);
      pins.push(pin);
    }
  }
  assert(pins.length <= PIN_LIMITS.pinsMax, 'parsePinBoard: the board is bounded');
  assert(ids.size === pins.length, 'parsePinBoard: ids are unique');
  return { version: 1, pins };
}

/**
 * A board a writer sends (`ai:pinsWrite`): unlike `parsePinBoard`, nothing is left out quietly; any damaged pin,
 * repeated id or number, or more than `pinsMax` pins refuses the whole board, because the writer built it and a
 * board saved with a pin missing would lose that pin for good.
 */
export function parsePinBoardStrict(input: unknown): PinBoard {
  const value = object(input, 'board');
  if (value['version'] !== 1) {
    throw new Error('board.version: expected 1');
  }
  const pins = list(value['pins'], PIN_LIMITS.pinsMax, 'board.pins').map(parsePin);
  if (new Set(pins.map((pin) => pin.id)).size !== pins.length) {
    throw new Error('board.pins: repeated id');
  }
  if (new Set(pins.map((pin) => pin.number)).size !== pins.length) {
    throw new Error('board.pins: repeated number');
  }
  return { version: 1, pins };
}

/** Images with their bytes, at most every image a full board names and at most `boardImageCharsMax` characters in all. */
export function parsePinImages(input: unknown): readonly PinImageData[] {
  const images = list(input, PIN_LIMITS.pinsMax * PIN_LIMITS.imagesPerPinMax, 'images').map(parsePinImageData);
  if (new Set(images.map((image) => image.id)).size !== images.length) {
    throw new Error('images: repeated image');
  }
  if (pinImageChars(images) > PIN_LIMITS.boardImageCharsMax) {
    throw new Error('images: exceed the board bound');
  }
  return images;
}

/** Base64 characters of `images` together. */
export function pinImageChars(images: readonly Pick<PinImageData, 'data'>[]): number {
  return images.reduce((sum, image) => sum + image.data.length, 0);
}

/** What `ai:pinsRead` answers: the board and the bytes of each image it names that is still on disk. */
export interface PinBoardRead {
  readonly board: PinBoard;
  readonly images: readonly PinImageData[];
}

export function parsePinBoardRead(input: unknown): PinBoardRead {
  const value = object(input, 'pinsRead');
  return { board: parsePinBoardStrict(value['board']), images: parsePinImages(value['images']) };
}

/** Every image id the board names. */
export function boardImageIds(board: PinBoard): ReadonlySet<PinImageId> {
  return new Set(board.pins.flatMap((pin) => pin.images.map((image) => image.id)));
}

/** One pin; throws on any shape the type does not allow. */
export function parsePin(input: unknown): CommentPin {
  const value = object(input, 'pin');
  const createdAt = count(value['createdAt'], 'pin.createdAt');
  const updatedAt = count(value['updatedAt'], 'pin.updatedAt');
  if (updatedAt < createdAt) {
    throw new Error('pin.updatedAt: earlier than createdAt');
  }
  const images = list(value['images'], PIN_LIMITS.imagesPerPinMax, 'pin.images').map(parsePinImageRef);
  if (new Set(images.map((image) => image.id)).size !== images.length) {
    throw new Error('pin.images: repeated image');
  }
  const pin: CommentPin = {
    id: toPinId(text(value['id'], 17, 'pin.id')),
    number: pinNumber(value['number']),
    createdAt,
    updatedAt,
    comment: text(value['comment'], PIN_LIMITS.commentCharsMax, 'pin.comment'),
    images,
    anchor: parsePinAnchor(value['anchor']),
    place: parsePinPlace(value['place']),
    included: flag(value['included'], 'pin.included'),
    delivery: parsePinDelivery(value['delivery']),
  };
  assert(pin.number >= 1, 'parsePin: numbers start at one');
  return pin;
}

export function parsePinAnchor(input: unknown): PinAnchor {
  const value = object(input, 'anchor');
  const at = object(value['at'], 'anchor.at');
  return {
    path: nonEmpty(value['path'], PIN_LIMITS.canvasPathCharsMax, 'anchor.path'),
    occurrence: bounded(count(value['occurrence'], 'anchor.occurrence'), PIN_LIMITS.occurrenceMax, 'anchor.occurrence'),
    at: { x: fraction(at['x'], 'anchor.at.x'), y: fraction(at['y'], 'anchor.at.y') },
    tag: nonEmpty(value['tag'], PIN_LIMITS.tagCharsMax, 'anchor.tag'),
    text: value['text'] === undefined ? undefined : text(value['text'], PIN_LIMITS.textCharsMax, 'anchor.text'),
  };
}

export function parsePinPlace(input: unknown): PinPlace {
  const value = object(input, 'place');
  const breakpoint = value['breakpointPx'];
  return {
    page: projectFile(value['page'], 'place.page'),
    pageLabel: nonEmpty(value['pageLabel'], PIN_LIMITS.labelCharsMax, 'place.pageLabel'),
    scope: value['scope'] === undefined ? undefined : projectFile(value['scope'], 'place.scope'),
    file: projectFile(value['file'], 'place.file'),
    locator: locator(value['locator']),
    elementLabel: nonEmpty(value['elementLabel'], PIN_LIMITS.labelCharsMax, 'place.elementLabel'),
    componentFile: value['componentFile'] === undefined ? undefined : projectFile(value['componentFile'], 'place.componentFile'),
    breakpointPx: breakpoint === undefined ? undefined : positive(breakpoint, PIN_LIMITS.breakpointPxMax, 'place.breakpointPx'),
  };
}

export function parsePinImageRef(input: unknown): PinImageRef {
  const value = object(input, 'image');
  return {
    id: toPinImageId(text(value['id'], 17, 'image.id')),
    kind: oneOf(value['kind'], PIN_IMAGE_KINDS, 'image.kind'),
    name: nonEmpty(value['name'], PIN_LIMITS.imageNameCharsMax, 'image.name'),
    mimeType: oneOf(value['mimeType'], PIN_IMAGE_TYPES, 'image.mimeType'),
  };
}

/** An image's bytes as base64, bounded as one prompt image is. */
export function parsePinImageData(input: unknown): PinImageData {
  const value = object(input, 'imageData');
  const data = text(value['data'], AI_LIMITS.imageBase64CharsMax, 'imageData.data');
  if (data.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('imageData.data: expected base64');
  }
  return { id: toPinImageId(text(value['id'], 17, 'imageData.id')), data };
}

export function parsePinDelivery(input: unknown): PinDelivery {
  const value = object(input, 'delivery');
  if (value['kind'] === 'draft') {
    return { kind: 'draft' };
  }
  if (value['kind'] !== 'sent') {
    throw new Error('delivery.kind: unknown kind');
  }
  return {
    kind: 'sent',
    chat: toChatId(text(value['chat'], 32, 'delivery.chat')),
    turn: value['turn'] === undefined ? undefined : toTurnId(text(value['turn'], 32, 'delivery.turn')),
    mode: oneOf(value['mode'], PIN_SEND_MODES, 'delivery.mode'),
    at: count(value['at'], 'delivery.at'),
  };
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function tryParse<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined; // A damaged pin is left out alone.
  }
}

function pinNumber(input: unknown): number {
  const value = count(input, 'pin.number');
  if (value < 1 || value > PIN_LIMITS.numberMax) {
    throw new Error('pin.number: out of range');
  }
  return value;
}

function object(input: unknown, name: string): Record<string, unknown> {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${name}: expected object`);
  }
  return value;
}

function list(input: unknown, max: number, name: string): readonly unknown[] {
  const values = toArray(input);
  if (values === undefined) {
    throw new Error(`${name}: expected array`);
  }
  if (values.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return values;
}

function text(input: unknown, max: number, name: string): string {
  if (typeof input !== 'string') {
    throw new Error(`${name}: expected string`);
  }
  if (input.length > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return input;
}

function nonEmpty(input: unknown, max: number, name: string): string {
  const value = text(input, max, name);
  if (value.trim().length === 0) {
    throw new Error(`${name}: expected non-empty text`);
  }
  return value;
}

function projectFile(input: unknown, name: string): string {
  const value = text(input, PIN_LIMITS.canvasPathCharsMax, name);
  if (!isProjectRelativePath(value)) {
    throw new Error(`${name}: expected a project-relative path`);
  }
  return value;
}

function locator(input: unknown): string {
  const value = text(input, PIN_LIMITS.canvasPathCharsMax, 'locator');
  if (!/^\d+(?:\.\d+)*$/u.test(value)) {
    throw new Error('locator: expected child indexes');
  }
  return value;
}

function count(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < 0) {
    throw new Error(`${name}: expected nonnegative integer`);
  }
  return input;
}

function bounded(value: number, max: number, name: string): number {
  if (value > max) {
    throw new Error(`${name}: exceeds limit`);
  }
  return value;
}

function positive(input: unknown, max: number, name: string): number {
  const value = bounded(count(input, name), max, name);
  if (value === 0) {
    throw new Error(`${name}: expected a positive width`);
  }
  return value;
}

function fraction(input: unknown, name: string): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || input > 1) {
    throw new Error(`${name}: expected a number from 0 to 1`);
  }
  return input;
}

function flag(input: unknown, name: string): boolean {
  if (typeof input !== 'boolean') {
    throw new Error(`${name}: expected boolean`);
  }
  return input;
}

function oneOf<T extends string>(input: unknown, allowed: readonly T[], name: string): T {
  const found = allowed.find((candidate) => candidate === input);
  if (found === undefined) {
    throw new Error(`${name}: unknown value`);
  }
  return found;
}
