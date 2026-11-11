// Images pasted, dropped or picked into the composer, made ready to send: one
// of the four types agents accept, scaled to at most 1600 px and re-encoded as
// JPEG until it fits the attachment bound. Ported from Studio's chat
// (studio/src/features/ai/chatImages.ts), producing base64 for an ACP image block.
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import type { DraftAttachment } from './aiStore';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const IMAGE_BYTES_MAX = 20_000_000;
const IMAGE_EDGE_PX_MAX = 1600;
/** The data URL size a prepared image aims under; well inside AI_LIMITS.imageBase64CharsMax. */
const IMAGE_URL_CHARS_TARGET = 1_500_000;

export async function prepareImage(file: File): Promise<DraftAttachment> {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
  }
  if (file.size > IMAGE_BYTES_MAX) {
    throw new Error('Each image must be smaller than 20 MB.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, IMAGE_EDGE_PX_MAX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Could not prepare this image.');
    }
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.9, 0.75, 0.6, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= IMAGE_URL_CHARS_TARGET) {
        const data = url.slice(url.indexOf(',') + 1);
        assert(data.length <= AI_LIMITS.imageBase64CharsMax, 'prepareImage: within the attachment bound');
        return { id: crypto.randomUUID(), preview: url, attachment: { kind: 'image', name: file.name.slice(0, 200) || 'image', mimeType: 'image/jpeg', data } };
      }
    }
    throw new Error('This image is too detailed. Crop it or choose a smaller one.');
  } finally {
    bitmap.close();
  }
}
