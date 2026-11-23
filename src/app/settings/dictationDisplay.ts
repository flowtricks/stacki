// How Settings → Dictation names and shortens what the engine knows: a model by its friendly name, a folder
// path by its two ends. Pure, so the page stays a layout and a test reads the rules directly. Nothing here is
// a message: a model's name is a proper noun, the same in every language.
import { assert } from '../../../shared/core/assert';
import { installOf } from '../../../shared/properties/voice/dictationModel';
import type { WhisperModel, WhisperModelId } from '../../../shared/properties/voice/whisperModels';
import type { DictationSnapshot } from '../../features/ai/voice/dictationStore';

/** The quality cards, left to right: the quickest first, so the one that costs more reads as the step up. */
export const QUALITY_ORDER: readonly WhisperModelId[] = ['base', 'small', 'turbo'];

const WHISPER_SIZE_NAMES = {
  turbo: 'large v3 turbo',
  small: 'small',
  base: 'base',
} as const satisfies { readonly [Id in WhisperModelId]: string };

const ENCODER_BITS = { fp16: '16-bit', q8: '8-bit', q4f16: '4-bit' } as const satisfies { readonly [Encoder in WhisperModel['encoder']]: string };

/** "Whisper large v3 turbo, 4-bit": the model's family, size and the precision of its larger half. */
export function modelDisplayName(model: WhisperModel): string {
  return `Whisper ${WHISPER_SIZE_NAMES[model.id]}, ${ENCODER_BITS[model.encoder]}`;
}

/** Characters of a folder path shown before the middle is cut: room for a user folder and the model's own. */
export const PATH_CHARS_SHOWN = 44;

/**
 * `text` cut in the middle to at most `charsMax` characters, with an ellipsis where it was cut: a path's two ends
 * (where it starts and what it is) say more than its middle.
 */
export function shortenMiddle(text: string, charsMax: number): string {
  assert(Number.isSafeInteger(charsMax), 'shortenMiddle: the limit is a whole number');
  assert(charsMax >= 5, 'shortenMiddle: the limit leaves room for both ends and the ellipsis');
  const characters = [...text];
  if (characters.length <= charsMax) {
    return text;
  }
  const keep = charsMax - 1;
  const head = Math.ceil(keep / 3);
  const tail = keep - head;
  const shortened = `${characters.slice(0, head).join('')}…${characters.slice(characters.length - tail).join('')}`;
  assert([...shortened].length === charsMax, 'shortenMiddle: the result fits the limit exactly');
  return shortened;
}

/** The folder a model lives in, as the person knows it: the models folder and the model's own name, never its commit. */
export function modelFolder(directory: string, id: WhisperModelId): string {
  assert(directory.length > 0, 'modelFolder: the models folder is named');
  const separator = directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/u, '')}${separator}${id}`;
}

/** What the status card says: one state at a time, with the bytes only the states that have them carry. */
export type DictationPageStatus =
  | { readonly kind: 'loading' }
  | { readonly kind: 'notInstalled' }
  | { readonly kind: 'partial'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'downloading'; readonly receivedBytes: number; readonly totalBytes: number }
  | { readonly kind: 'ready'; readonly sizeBytes: number };

/**
 * The chosen model's state for the status card. A download the engine reports wins over what the disk said last,
 * which is out of date until the download ends and main is asked again; before main first answers nothing is known.
 */
export function dictationPageStatus(snapshot: DictationSnapshot): DictationPageStatus {
  const engine = snapshot.engine;
  if (engine.kind === 'downloading') {
    return { kind: 'downloading', receivedBytes: engine.receivedBytes, totalBytes: engine.totalBytes };
  }
  if (snapshot.status === undefined) {
    return { kind: 'loading' };
  }
  const install = installOf(snapshot.status, snapshot.model);
  switch (install.kind) {
    case 'notInstalled':
      return { kind: 'notInstalled' };
    case 'partial':
    case 'downloading':
      return { kind: install.kind, receivedBytes: install.receivedBytes, totalBytes: install.totalBytes };
    case 'installed':
      return { kind: 'ready', sizeBytes: install.sizeBytes };
    default: {
      const exhaustive: never = install;
      return exhaustive;
    }
  }
}
