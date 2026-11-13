// An Image property's default, and the type it gives the prop. Astro has two
// ways to name an image, and the default picks which one the prop is:
//
//   import placeholder from "../assets/placeholder.svg";
//   interface Props { image?: ImageMetadata; }
//   const { image = placeholder } = Astro.props;
//
// A file in src/ is imported, and Astro hands the component its ImageMetadata
// (`src`, `width`, `height`, `format`), which astro:assets' <Image> optimises
// and sizes. A file in public/, or an image hosted elsewhere, is a URL: the
// prop is a `string` and its default is that URL. The default is the asset
// path as the new property form writes it (assetValueFor in ui/assetPath.ts):
// relative to the component for a file in src/ (`../assets/hero.png`, or an
// alias `@/assets/hero.png`), rooted for one in public/ (`/hero.png`), or a
// full URL. Pure, so the rules are pinned by tests without a renderer.

import { assert } from '../../shared/core/assert';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../shared/properties/i18n/messageRef';
import { err, ok, type Result } from '../../shared/core/result';

/** What an Image property's default names: an imported file in src/, or a URL. */
export type ImageDefault = { readonly kind: 'asset'; readonly specifier: string; readonly base: string } | { readonly kind: 'url'; readonly url: string };

/** The type an imported image is, and where it is imported from. */
// i18n-ignore: the name of Astro's type, code written into the component.
export const IMAGE_TYPE = { name: 'ImageMetadata', path: 'astro' } as const;

export const IMAGE_LIMITS = { sourceCharsMax: 2048, baseCharsMax: 48 } as const satisfies Record<string, number>;

// The image files Astro's asset pipeline imports as ImageMetadata.
const IMPORTABLE = /\.(png|jpe?g|webp|avif|gif|svg|tiff?)$/i;
const RELATIVE = /^(\.\.?\/|[@~]\/)/;
const URL_LIKE = /^(https?:\/\/|\/\/|\/|data:image\/)/i;

/** What `source` names as an Image property's default; an error says why it names none. */
export function imageDefaultOf(source: string, translate: Translator = ENGLISH_TRANSLATE): Result<ImageDefault, string> {
  const text = source.trim();
  if (text === '') {
    return err(translate('editor.imageDefault.choose'));
  }
  if (text.length > IMAGE_LIMITS.sourceCharsMax) {
    return err(translate('editor.imageDefault.tooLong'));
  }
  if (/["'`\\\n]/.test(text)) {
    return err(translate('editor.imageDefault.invalid'));
  }
  if (RELATIVE.test(text)) {
    if (!IMPORTABLE.test(text)) {
      return err(translate('editor.imageDefault.notImportable'));
    }
    const out: ImageDefault = { kind: 'asset', specifier: text, base: importBase(text) };
    assert(/^[A-Za-z_$][\w$]*$/.test(out.base), 'imageDefaultOf: an import is named by an identifier');
    return ok(out);
  }
  if (URL_LIKE.test(text)) {
    return ok({ kind: 'url', url: text });
  }
  return err(translate('editor.imageDefault.chooseOrUrl'));
}

/** The type the prop is declared with: the imported image's metadata, or a URL's string. */
export function imageTypeText(image: ImageDefault): string {
  switch (image.kind) {
    case 'asset':
      return IMAGE_TYPE.name;
    case 'url':
      return 'string';
    default: {
      const exhaustive: never = image;
      return exhaustive;
    }
  }
}

/** Whether a declared type is an imported image: `ImageMetadata`, alone or in a union. */
export function isImageType(typeText: string): boolean {
  assert(typeText.length <= IMAGE_LIMITS.sourceCharsMax, 'isImageType: a type is bounded');
  return typeText.split('|').some((part) => part.trim() === IMAGE_TYPE.name);
}

// The name the import is read by: the file's name in camelCase, `hero-shot.png`
// is `heroShot`, and one starting with a digit is prefixed (`image2x`).
function importBase(specifier: string): string {
  const file = (specifier.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
  const words = file.split(/[^A-Za-z0-9]+/).filter((word) => word !== '');
  const joined = words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join('');
  const named = joined === '' ? 'image' : /^\d/.test(joined) ? `image${joined}` : joined;
  return named.slice(0, IMAGE_LIMITS.baseCharsMax);
}
