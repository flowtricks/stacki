// The full copies of the images sent in a chat, so each can be opened large later, after a restart too (the
// transcript itself holds only the small preview, chatModel's `thumbnail`). Beside the project's chats, under
// userData and never in the project:
//
//   userData/ai/projects/<sha256>/images/<chat>/<32 hex of the bytes' sha256>.<png|jpg|webp|gif>
//
// Bounds (AI_LIMITS): `chatImagesMax` files and `chatImagesBytesMax` bytes a chat, `projectImagesMax` and
// `projectImagesBytesMax` a project. Past a bound the oldest go first, never the one just written; a message
// whose copy is gone still shows its preview. A chat's folder goes with the chat. The same bytes sent twice
// are one file. A copy that cannot be written is only a missing copy: sending never fails for it.
//
// The only names read are a parsed chat id and a parsed image id, neither of which can name a path, and only
// a regular file is read, so a link planted in the folder is never followed out of it.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import type { ChatImageReply, PromptAttachment } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { toChatId, toChatImageId, type ChatId, type ChatImageId } from '../../../shared/properties/ai/chatModel';

export type KeptImage = Pick<Extract<PromptAttachment, { readonly kind: 'image' }>, 'mimeType' | 'data'>;

export interface ImageBounds {
  readonly filesMax: number;
  readonly bytesMax: number;
}

const CHAT_BOUNDS: ImageBounds = { filesMax: AI_LIMITS.chatImagesMax, bytesMax: AI_LIMITS.chatImagesBytesMax };
const PROJECT_BOUNDS: ImageBounds = { filesMax: AI_LIMITS.projectImagesMax, bytesMax: AI_LIMITS.projectImagesBytesMax };
/** The largest file read back: what the largest accepted image decodes to. */
const IMAGE_FILE_BYTES_MAX = Math.ceil((AI_LIMITS.imageBase64CharsMax * 3) / 4);

const EXTENSIONS: Readonly<Record<KeptImage['mimeType'], string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const TYPES: Readonly<Record<string, KeptImage['mimeType']>> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

export function saveChatImage(projectDirectory: string, chat: ChatId, image: KeptImage): ChatImageId | undefined {
  assert(path.isAbsolute(projectDirectory), 'saveChatImage: an absolute project folder');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length === 0 || bytes.length > IMAGE_FILE_BYTES_MAX) {
    return undefined;
  }
  const id = toChatImageId(`${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${EXTENSIONS[image.mimeType]}`);
  const folder = chatFolder(projectDirectory, chat);
  const file = path.join(folder, id);
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Replaced whole, so a crash leaves no half image; rewriting an image sent again also makes it the newest.
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
    pruneImages(listImages(folder), CHAT_BOUNDS, file);
    pruneImages(projectImages(projectDirectory), PROJECT_BOUNDS, file);
  } catch (error: unknown) {
    console.warn(`[ai] a sent image could not be kept: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
  return id;
}

/** The kept image, or undefined when it is gone, too large, or not a regular file. */
export function readChatImage(projectDirectory: string, chat: ChatId, image: ChatImageId): ChatImageReply | undefined {
  const file = path.join(chatFolder(projectDirectory, chat), toChatImageId(image));
  const mimeType = TYPES[path.extname(file).slice(1)];
  assert(mimeType !== undefined, 'readChatImage: a parsed image id has a known type');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > IMAGE_FILE_BYTES_MAX) {
      return undefined;
    }
    return { mimeType, data: fs.readFileSync(file).toString('base64') };
  } catch {
    return undefined;
  }
}

export function deleteChatImages(projectDirectory: string, chat: ChatId): void {
  fs.rmSync(chatFolder(projectDirectory, chat), { recursive: true, force: true });
}

/** A fork's own copies, so deleting either chat leaves the other's images. */
export function copyChatImages(projectDirectory: string, source: ChatId, target: ChatId): void {
  assert(source !== target, 'copyChatImages: two chats');
  const images = listImages(chatFolder(projectDirectory, source));
  if (images.length === 0) {
    return;
  }
  const folder = chatFolder(projectDirectory, target);
  try {
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    // Oldest first, so the copies age in the order their originals did.
    for (const image of [...images].sort((left, right) => left.modifiedMs - right.modifiedMs)) {
      const copy = path.join(folder, path.basename(image.file));
      fs.copyFileSync(image.file, copy, fs.constants.COPYFILE_FICLONE);
    }
    pruneImages(projectImages(projectDirectory), PROJECT_BOUNDS, undefined);
  } catch (error: unknown) {
    console.warn(`[ai] a fork's images could not be copied: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface StoredImage {
  readonly file: string;
  readonly bytes: number;
  readonly modifiedMs: number;
}

/** Removes the oldest of `images` until both bounds hold; `keep` is never removed. */
export function pruneImages(images: readonly StoredImage[], bounds: ImageBounds, keep: string | undefined): void {
  assert(bounds.filesMax >= 1, 'pruneImages: room for an image');
  let files = images.length;
  let bytes = images.reduce((sum, image) => sum + image.bytes, 0);
  for (const image of [...images].sort((left, right) => left.modifiedMs - right.modifiedMs)) {
    if (files <= bounds.filesMax && bytes <= bounds.bytesMax) {
      return;
    }
    if (image.file !== keep) {
      fs.rmSync(image.file, { force: true });
      files -= 1;
      bytes -= image.bytes;
    }
  }
}

function chatFolder(projectDirectory: string, chat: ChatId): string {
  return path.join(projectDirectory, 'images', toChatId(chat));
}

// At most a project's chats, each pruned to its own bound at every write.
function projectImages(projectDirectory: string): readonly StoredImage[] {
  const base = path.join(projectDirectory, 'images');
  return names(base).flatMap((chat) => listImages(path.join(base, chat)));
}

function listImages(folder: string): readonly StoredImage[] {
  return names(folder).flatMap((name) => {
    const file = path.join(folder, name);
    const stat = fs.lstatSync(file);
    return stat.isFile() ? [{ file, bytes: stat.size, modifiedMs: stat.mtimeMs }] : [];
  });
}

function names(folder: string): readonly string[] {
  try {
    return fs.readdirSync(folder);
  } catch {
    return []; // Nothing was ever kept there.
  }
}
