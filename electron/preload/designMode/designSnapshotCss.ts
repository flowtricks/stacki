// Design mode (experimental, removable: src/app/designMode/REMOVE.md): the stylesheet text rewrites a
// snapshot needs. Pure string functions and one bounded cache, so a test runs them without a browser.

const URL_PATTERN = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
/** A CSS text is walked once per pattern; a stylesheet past this is left as it is. */
const CSS_CHARS_MAX = 20_000_000;

/** `url(...)` references made absolute against `base`, the stylesheet's own address. Data, blob and fragment URLs are kept. */
export function rebaseCssURLs(text: string, base: string): string {
  if (text.length > CSS_CHARS_MAX) {
    return text;
  }
  return text.replace(URL_PATTERN, (whole, quote: string, reference: string) => {
    const trimmed = reference.trim();
    if (trimmed.startsWith('data:') || trimmed.startsWith('#') || trimmed.startsWith('blob:')) {
      return whole;
    }
    try {
      return `url(${quote}${new URL(trimmed, base).href}${quote})`;
    } catch {
      return whole;
    }
  });
}

// A length in vh, svh, lvh or dvh: a number right before the unit, the unit not followed by a letter.
const VIEWPORT_HEIGHT = /(^|[^\w.-])(-?(?:\d+\.?\d*|\.\d+))(?:s|l|d)?vh(?![\w-])/g;

/**
 * Viewport-height units bound to `--design-vh`, 1% of the frame's chosen viewport height. A frame is as tall as
 * its page, and a `100vh` hero inside it would otherwise grow with the frame it sets the height of.
 */
export function freezeViewportUnits(text: string): string {
  if (text.length > CSS_CHARS_MAX || !text.includes('vh')) {
    return text;
  }
  return text.replace(VIEWPORT_HEIGHT, (_whole, before: string, amount: string) => `${before}calc(${amount} * var(--design-vh, 1vh))`);
}

const FONT_FACE = /@font-face\s*\{[^}]*\}/g;

/**
 * The fonts one snapshot inlines, within a count and a character budget shared by all of its stylesheets.
 * A font that cannot be fetched, or would pass the budget, keeps its address.
 */
export class FontInliner {
  private charsLeft: number;
  private countLeft: number;
  private readonly fetched = new Map<string, string | undefined>();

  private readonly fetchDataURL: (url: string) => Promise<string | undefined>;

  constructor(charsMax: number, countMax: number, fetchDataURL: (url: string) => Promise<string | undefined>) {
    this.fetchDataURL = fetchDataURL;
    if (charsMax < 0 || countMax < 0) {
      throw new Error('Assertion failed: FontInliner: budgets are never negative');
    }
    this.charsLeft = charsMax;
    this.countLeft = countMax;
  }

  /** `text` with every `url()` inside an `@font-face` replaced by the font's bytes, while the budget lasts. */
  async inline(text: string): Promise<string> {
    if (text.length > CSS_CHARS_MAX || !text.includes('@font-face')) {
      return text;
    }
    for (const match of text.matchAll(FONT_FACE)) {
      for (const url of [...match[0].matchAll(URL_PATTERN)].map((found) => found[2]?.trim() ?? '')) {
        if (/^https?:\/\//.test(url)) {
          await this.fetchOnce(url);
        }
      }
    }
    return text.replace(FONT_FACE, (block) =>
      block.replace(URL_PATTERN, (whole, quote: string, reference: string) => {
        const data = this.fetched.get(reference.trim());
        return data === undefined ? whole : `url(${quote}${data}${quote})`;
      }),
    );
  }

  private async fetchOnce(url: string): Promise<void> {
    if (this.fetched.has(url) || this.countLeft <= 0) {
      return;
    }
    this.countLeft -= 1;
    let data: string | undefined;
    try {
      data = await this.fetchDataURL(url);
    } catch {
      data = undefined;
    }
    if (data !== undefined && data.length <= this.charsLeft) {
      this.charsLeft -= data.length;
      this.fetched.set(url, data);
    } else {
      this.fetched.set(url, undefined);
    }
  }
}
