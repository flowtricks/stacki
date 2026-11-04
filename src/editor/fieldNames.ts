// What a field's name says it holds, when nothing stronger says so: `heroImage`
// ends in a media word, so it holds an image; `ctaHref` ends in `href`, so it
// holds a link. Names are the weakest signal a control is chosen by (the
// declared type and the value come first), and the instance panel, the new
// property form and a list's item editor all read them the same way from here.
// Pure, so the words are pinned by tests without a renderer.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

/** The last words of a name that make it a media field: `src`, `heroImage`, `cover`. */
export const MEDIA_WORDS = new Set(['src', 'image', 'poster', 'icon', 'logo', 'avatar', 'thumb', 'thumbnail', 'photo', 'banner', 'cover', 'video', 'audio']);

/** The last word of a name, lower-cased: `heroImage` is `image`, `data-src` is `src`. */
export function mediaWord(name: string): string {
  const text = String(name || '');
  assert(text.length <= LIMITS.attrCharsMax, 'mediaWord: a name is bounded');
  const words = text
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
    .split(/\s+/);
  return words[words.length - 1] || '';
}

/** Whether a name says its field holds an image, a video or another media file. */
export function isMediaName(name: string): boolean {
  return MEDIA_WORDS.has(mediaWord(name));
}

/** Whether a name ends in `href`: an attribute or prop that holds a link. */
export function isHrefName(name: string): boolean {
  return lastWord(name) === 'href';
}

/** Whether a name says its field holds a link: it ends in `href`, `url` or `link`. */
export function isLinkName(name: string): boolean {
  const last = lastWord(name);
  return last === 'href' || last === 'url' || last === 'link';
}

function lastWord(name: string): string {
  const text = String(name);
  assert(text.length <= LIMITS.attrCharsMax, 'lastWord: a name is bounded');
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words[words.length - 1] ?? '';
}
