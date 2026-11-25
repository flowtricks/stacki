// Where a project's comment pins are kept (docs/contracts.md, "Comment pins"): beside its chats, under
// userData, never in the project, so nothing about them is committed.
//
//   userData/ai/projects/<sha256(realpath)>/pins/board.json         the board, replaced whole
//   userData/ai/projects/<sha256(realpath)>/pins/images/<id>.bin    each image's bytes, written once
//
// Why images apart from the board: the board is rewritten after every pause in typing, and the images (a
// crop per pin and what the person added) are most of its weight; written once each, they cost nothing
// on the next save. An image the board stops naming is removed with the save that drops it.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assert } from '../../../shared/core/assert';
import {
  boardImageIds,
  parsePinBoard,
  toPinImageId,
  type PinBoard,
  type PinBoardRead,
  type PinImageData,
  type PinImageId,
} from '../../../shared/properties/ai/commentPins';
import { PIN_LIMITS } from '../../../shared/properties/ai/commentPinBrief';

const IMAGE_SUFFIX = '.bin';

/** Base64 characters of `bytes` bytes: what an image weighs against `boardImageCharsMax`. */
function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

export class PinBoardStore {
  /** `directory` is the project's folder in the chat store (ChatStore.projectDirectory). */
  constructor(private readonly directory: (projectPath: string) => string) {}

  read(projectPath: string): PinBoardRead {
    const folder = this.folder(projectPath);
    let source: string | undefined;
    try {
      source = fs.readFileSync(path.join(folder, 'board.json'), 'utf8');
    } catch {
      source = undefined; // No board yet.
    }
    const parsed = source === undefined ? parsePinBoard(undefined) : parsePinBoard(safeJson(source));
    const images: PinImageData[] = [];
    let chars = 0;
    const loaded = new Set<PinImageId>();
    for (const id of boardImageIds(parsed)) {
      const data = readImage(folder, id);
      if (data !== undefined && chars + data.length <= PIN_LIMITS.boardImageCharsMax) {
        images.push({ id, data });
        loaded.add(id);
        chars += data.length;
      }
    }
    // An image whose bytes are gone (or past the bound) leaves its pin, so the board never names a picture it cannot show.
    const board: PinBoard = { version: 1, pins: parsed.pins.map((pin) => ({ ...pin, images: pin.images.filter((image) => loaded.has(image.id)) })) };
    assert(images.length === loaded.size, 'read: one image per loaded id');
    assert(chars <= PIN_LIMITS.boardImageCharsMax, 'read: the images are bounded');
    return { board, images };
  }

  /**
   * Stores `board` whole. `images` are the bytes of images not stored yet; one the board does not name is ignored.
   * Refused (false) when the board's images would pass `boardImageCharsMax`; nothing is changed then.
   */
  write(projectPath: string, board: PinBoard, images: readonly PinImageData[]): boolean {
    assert(board.pins.length <= PIN_LIMITS.pinsMax, 'write: the board is bounded');
    const folder = this.folder(projectPath);
    const named = boardImageIds(board);
    const fresh = images.filter((image) => named.has(image.id) && readSize(folder, image.id) === undefined);
    let chars = fresh.reduce((sum, image) => sum + image.data.length, 0);
    for (const id of named) {
      const size = readSize(folder, id);
      chars += size === undefined ? 0 : base64Chars(size);
    }
    if (chars > PIN_LIMITS.boardImageCharsMax) {
      return false;
    }
    fs.mkdirSync(path.join(folder, 'images'), { recursive: true });
    for (const image of fresh) {
      replaceWhole(imageFile(folder, image.id), Buffer.from(image.data, 'base64'));
    }
    replaceWhole(path.join(folder, 'board.json'), `${JSON.stringify(board)}\n`);
    this.sweep(folder, named);
    const stored = parsePinBoard(safeJson(fs.readFileSync(path.join(folder, 'board.json'), 'utf8')));
    assert(stored.pins.length === board.pins.length, 'write: the stored board reads back whole');
    return true;
  }

  private folder(projectPath: string): string {
    const folder = path.join(this.directory(projectPath), 'pins');
    assert(path.isAbsolute(folder), 'folder: absolute');
    return folder;
  }

  // Images the board no longer names, and any stray file in the images folder, are removed. Bounded by the folder's
  // listing, which a full board keeps at `pinsMax × imagesPerPinMax` plus what a crash left half written.
  private sweep(folder: string, named: ReadonlySet<PinImageId>): void {
    let entries: readonly string[];
    try {
      entries = fs.readdirSync(path.join(folder, 'images'));
    } catch {
      return;
    }
    for (const entry of entries) {
      const id = imageIdOf(entry);
      if (id === undefined || !named.has(id)) {
        fs.rmSync(path.join(folder, 'images', entry), { force: true });
      }
    }
  }
}

function imageFile(folder: string, id: PinImageId): string {
  return path.join(folder, 'images', `${id}${IMAGE_SUFFIX}`);
}

function imageIdOf(entry: string): PinImageId | undefined {
  if (!entry.endsWith(IMAGE_SUFFIX)) {
    return undefined;
  }
  try {
    return toPinImageId(entry.slice(0, -IMAGE_SUFFIX.length));
  } catch {
    return undefined;
  }
}

function readSize(folder: string, id: PinImageId): number | undefined {
  try {
    return fs.statSync(imageFile(folder, id)).size;
  } catch {
    return undefined;
  }
}

function readImage(folder: string, id: PinImageId): string | undefined {
  try {
    const bytes = fs.readFileSync(imageFile(folder, id));
    return bytes.length === 0 ? undefined : bytes.toString('base64');
  } catch {
    return undefined;
  }
}

function safeJson(source: string): unknown {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed;
  } catch {
    return undefined; // A torn or damaged board reads as an empty one; parsePinBoard says what survives.
  }
}

function replaceWhole(file: string, contents: string | Buffer): void {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temporary, contents, { flag: 'wx' });
  fs.renameSync(temporary, file);
}
