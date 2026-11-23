// The small preview kept beside a sent image's name in its chat, so the transcript can show the picture
// after a restart, when the full image (which only travels to the agent) is long gone. Why here: the main
// process has the image's bytes at the moment the message is recorded, so capture and the composer stay
// untouched. A JPEG 320 px wide is a few KB; one that would not fit the bound, or an image Electron cannot
// decode, gives no thumbnail, and the transcript falls back to the plain label.
import { nativeImage } from 'electron';
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { THUMBNAIL_PREFIX } from '../../../shared/properties/ai/chatModel';
import type { PromptAttachment } from '../../../shared/ipc/aiChat';

const JPEG_QUALITIES = [70, 50, 30] as const;

/** A JPEG data URL of `attachment`, at most `AI_LIMITS.thumbnailEdgePx` wide, or undefined when it cannot be made within the bound. */
export function attachmentThumbnail(attachment: Extract<PromptAttachment, { readonly kind: 'image' }>): string | undefined {
  const source = nativeImage.createFromBuffer(Buffer.from(attachment.data, 'base64'));
  if (source.isEmpty()) {
    return undefined;
  }
  const size = source.getSize();
  const scaled = size.width > AI_LIMITS.thumbnailEdgePx ? source.resize({ width: AI_LIMITS.thumbnailEdgePx, quality: 'good' }) : source;
  for (const quality of JPEG_QUALITIES) {
    const url = `${THUMBNAIL_PREFIX}${scaled.toJPEG(quality).toString('base64')}`;
    if (url.length <= AI_LIMITS.thumbnailCharsMax) {
      assert(url.startsWith(THUMBNAIL_PREFIX), 'attachmentThumbnail: a JPEG data URL');
      return url;
    }
  }
  return undefined;
}
