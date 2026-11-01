import { BOUNDARY_LIMITS } from '../../shared/core/boundary';
import { parsePageText, type PageText } from '../../shared/properties/pageText';

export function renderedPageText(document: Document): PageText {
  // Social titles remain stable when a site's visibility handler changes its tab title.
  const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? document.querySelector('title')?.textContent ?? undefined;
  const description =
    document.querySelector('meta[name="description"]')?.getAttribute('content') ??
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ??
    undefined;
  return parsePageText({
    title: renderedPageTextBounded(title),
    description: renderedPageTextBounded(description),
  });
}

function renderedPageTextBounded(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length <= BOUNDARY_LIMITS.textLengthMax ? value : undefined;
}
