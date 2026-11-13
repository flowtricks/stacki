// i18n-ignore-file: the English source of the audit sentences; each is translated by its reference in the catalog (audits.detail, audits.fix, audits.measure).
// The English of every audit sentence that is not a check's title or reason: a finding's detail line, a fix's button words and a
// measurement. `shared/page` may import only `core`, so it cannot read the English catalog; it keeps the English here, beside the
// reference the renderer translates, and a test holds this table equal to `shared/properties/i18n/messages/en/audits.ts` key for key.
// A message cannot hold a literal `<tag>`, so a tag arrives as a parameter (AUDIT_TAGS in auditFindings.ts).
import { assert } from '../core/assert';
import { formatMessage, type MessageParams, type MessageValue } from '../core/i18n/catalog';
import type { MessageRef } from '../core/i18n/messageReference';

export const AUDIT_TEXT = {
  'audits.detail.alsoOn': '"{value}" is also on {routes}',
  'audits.detail.alsoOnMore': '"{value}" is also on {routes} and {more} more',
  'audits.detail.ariaHiddenFocusable': 'aria-hidden="true" on a focusable element',
  'audits.detail.autoplayWithoutOne': 'Autoplays without {first}',
  'audits.detail.autoplayWithoutTwo': 'Autoplays without {first} or {second}',
  'audits.detail.canonicalNotURL': 'href="{href}" is not a URL',
  'audits.detail.canonicalPointsAt': 'Points at {path}, not {route}',
  'audits.detail.contrastRatio': '{ratio}:1, needs {required}:1 ({color} on {background})',
  'audits.detail.descriptionEmpty': 'The meta description is empty',
  'audits.detail.descriptionLength': '{length} characters (aim for {min}–{max})',
  'audits.detail.headNoCanonical': '{head} has no canonical link',
  'audits.detail.headNoDescription': '{head} has no meta description',
  'audits.detail.headNoTitle': '{head} has no {title}',
  'audits.detail.htmlNoLang': '{html} has no lang',
  'audits.detail.idReferenced': 'id="{id}" (referenced, so renaming needs a choice)',
  'audits.detail.idRepeatsInLoop': 'id="{id}" repeats on every item of a loop',
  'audits.detail.idRepeatsOnPage': 'id="{id}" appears more than once on the page',
  'audits.detail.imageMarkedDecorative': '{detail} (marked decorative)',
  'audits.detail.imageSize': '{source} is {kilobytes} KB',
  'audits.detail.langEmpty': 'lang is empty',
  'audits.detail.launchNo404': 'No src/pages/404 page',
  'audits.detail.launchNoAnalytics': 'No analytics snippet in any page, and no analytics integration',
  'audits.detail.launchNoFavicon': 'No page links an icon, and public/ has no favicon',
  'audits.detail.noRobots': 'Neither public/robots.txt, a robots.txt endpoint nor a robots integration',
  'audits.detail.noSitemap': 'No sitemap integration, sitemap endpoint or served sitemap',
  'audits.detail.noSocialImage': 'No og:image on {route}',
  'audits.detail.noStructuredData': 'No page writes application/ld+json structured data',
  'audits.detail.noindexLayout': 'content="{content}" hides every page using this layout',
  'audits.detail.perfImageSize': '{name}: {natural}px wide, shown at {shown}px (on {route})',
  'audits.detail.perfLcp': '{seconds} s to the largest paint (on {route})',
  'audits.detail.perfOnRoute': '{detail} (on {route})',
  'audits.detail.perfTbt': '{milliseconds} ms of blocking script (on {route})',
  'audits.detail.perfWeight': '{megabytes} MB in {requests} requests (dev server) (on {route})',
  'audits.detail.renderedH1Count': 'The page renders {total} {h1} elements',
  'audits.detail.renderedNoCanonical': 'The page renders no canonical link',
  'audits.detail.renderedNoDescription': 'The page renders no meta description',
  'audits.detail.renderedNoH1': 'The page renders no {h1}',
  'audits.detail.renderedNoTitle': 'The page renders no {title}',
  'audits.detail.renderedTitleEmpty': 'The rendered {title} is empty',
  'audits.detail.secondH1': 'A second {h1} in this file',
  'audits.detail.socialImageBroken': '{url} does not load (on {route})',
  'audits.detail.socialMissing': 'Missing {tags}',
  'audits.detail.styleNoLayer': '{styleGlobal} with no @layer',
  'audits.detail.styleNotGlobal': '{style} without is:global or is:inline',
  'audits.detail.titleEmpty': '{title} is empty',
  'audits.detail.writtenByComponent': '{detail} (written by the component here)',
  'audits.fix.addAltEmpty': 'Add alt=""',
  'audits.fix.addCanonical': 'Add canonical link',
  'audits.fix.addDimensions': 'Add width="{width}" height="{height}"',
  'audits.fix.addFetchpriority': 'Add fetchpriority="high"',
  'audits.fix.addHeight': 'Add height="{height}"',
  'audits.fix.addLang': 'Add lang="{value}"',
  'audits.fix.addLazy': 'Add loading="lazy"',
  'audits.fix.addMetaDescription': 'Add meta description',
  'audits.fix.addNoopener': 'Add rel="noopener"',
  'audits.fix.addOne': 'Add {first}',
  'audits.fix.addTitle': 'Add {title}',
  'audits.fix.addTitleFromSource': 'Add title from its source',
  'audits.fix.addTwo': 'Add {first} and {second}',
  'audits.fix.addWidth': 'Add width="{width}"',
  'audits.fix.linkTo': 'Link to {route}',
  'audits.fix.makeHeadingH1': 'Make this heading an h1',
  'audits.fix.makeIdsUnique': 'Make ids unique per instance',
  'audits.fix.removeTabindex': 'Remove tabindex',
  'audits.fix.renameTo': 'Rename to "{name}"',
  'audits.fix.setAltEmpty': 'Set alt=""',
  'audits.fix.setTabindexZero': 'Set tabindex="0"',
  'audits.fix.setValue': 'Set {property} to {value}',
  'audits.fix.useVariable': 'Use {variable}',
  'audits.measure.characters': { one: '{count} character', other: '{count} characters' },
} as const satisfies Record<string, MessageValue>;

export type AuditTextKey = keyof typeof AUDIT_TEXT;

/** A sentence in English with the reference the renderer translates it by. */
export interface AuditSentence {
  readonly text: string;
  readonly ref: MessageRef<AuditTextKey>;
}

/** The English for `key` with its parameters filled in, and the reference. Asserts that the parameters fit the message. */
export function auditSentence(key: AuditTextKey, params?: MessageParams): AuditSentence {
  const filled = formatMessage('en', AUDIT_TEXT[key], params ?? {});
  assert(filled.ok, `auditSentence: "${key}" formats with the parameters passed`);
  return { text: filled.value, ref: params === undefined ? { key } : { key, params } };
}
