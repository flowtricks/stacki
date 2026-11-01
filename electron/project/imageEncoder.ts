import sharp from 'sharp';
import type { ImageFormat } from '../../shared/ipc/assetConversion';
import type { Result } from '../../shared/core/result';

export const IMAGE_BYTES_MAX = 50 * 1024 * 1024;
const IMAGE_PIXELS_MAX = 40_000_000;

// Chromium canvas does not guarantee AVIF encoding. Sharp provides both codecs,
// orientation handling and decode limits, with a portable WASM packaging fallback.
export async function encodeImage(bytes: Buffer, format: ImageFormat): Promise<Result<Buffer, string>> {
  if (bytes.length > IMAGE_BYTES_MAX) {
    return { ok: false, error: 'Choose an image smaller than 50 MB.' };
  }
  try {
    const input = sharp(bytes, { limitInputPixels: IMAGE_PIXELS_MAX, failOn: 'warning' });
    const metadata = await input.metadata();
    if ((metadata.pages ?? 1) > 1) {
      return { ok: false, error: 'Animated and multipage images are not converted.' };
    }
    if (!metadata.width || !metadata.height) {
      return { ok: false, error: 'The image dimensions could not be read.' };
    }
    const rotated = metadata.orientation !== undefined && metadata.orientation >= 5;
    const width = Math.max(1, Math.round((rotated ? metadata.height : metadata.width) * 0.95));
    const height = Math.max(1, Math.round((rotated ? metadata.width : metadata.height) * 0.95));
    const output = input
      .rotate()
      .resize(width, height, { fit: 'fill', withoutEnlargement: true })
      .toFormat(format, { quality: 95, effort: 2 })
      .timeout({ seconds: 30 });
    const result = await output.toBuffer();
    if (result.length > IMAGE_BYTES_MAX) {
      return { ok: false, error: 'The converted image exceeds 50 MB.' };
    }
    return { ok: true, value: result };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
