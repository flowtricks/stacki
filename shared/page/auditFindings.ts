// i18n-ignore-file: AUDIT_CHECKS is the English source beside each check's titleRef and whyRef; the renderer translates by reference (useAuditText).
// The audit model: what the Audits panel finds in a project's pages and
// components, how it ranks it, and the fixes it can make on its own. Every
// check is named once in AUDIT_CHECKS, with its title, priority, category and
// the WCAG success criterion or SEO reason a fix answers to, so the panel, the
// Settings tab and the hand-off prompt all describe a finding the same way.
//
// A finding names where it is by file and by the element's structural path in
// that file's parse (the index path the parser's `n0.2.1` ids spell), never by
// a session handle: a path survives a re-read of the same bytes, so a finding
// found on disk can still be fixed or selected once the file is open.
//
// A fix is a plan, not a write: attribute patches and inserted elements on
// nodes named by path. The renderer turns a plan into edit gestures, so every
// byte still goes through the intent path (src/features/audits/auditFixes.ts).
import { assert } from '../core/assert';
import type { MessageParams } from '../core/i18n/catalog';
import type { MessageRef } from '../core/i18n/messageReference';
import { auditSentence, type AuditTextKey } from './auditText';
import type { Attr } from './pageNodeTypes';

/** A check's reference: the catalog key of its title or reason, with the parameters its sentence needs. */
function checkRef(key: string, params?: MessageParams): MessageRef {
  return params === undefined ? { key } : { key, params };
}

/** Bounds of one audit run, enforced where findings accumulate. */
export const AUDIT_LIMITS = {
  /** Files one run reads: a site past this is audited in part, and says so. */
  filesMax: 2_000,
  /** Findings one run keeps; the rest are counted, not listed. */
  findingsMax: 5_000,
  /** Findings one file contributes, so one generated page cannot crowd out the rest. */
  findingsPerFileMax: 400,
  /** Elements one file's walk visits: the page-tree bound. */
  elementsPerFileMax: 20_000,
  /** Characters of one finding's detail line. */
  detailCharsMax: 240,
  /** Edits one fix plans. */
  fixEditsMax: 64,
  /** Pages one rendered pass fetches. */
  renderedPagesMax: 200,
  /** Characters of one rendered page's HTML. */
  renderedHtmlCharsMax: 4_000_000,
} as const satisfies Record<string, number>;

export const AUDIT_CATEGORIES = ['accessibility', 'seo', 'content', 'tokens', 'performance'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

/** High first: the order the panel's groups are drawn in. */
export const AUDIT_PRIORITIES = ['high', 'medium', 'low'] as const;
export type AuditPriority = (typeof AUDIT_PRIORITIES)[number];

/** How a finding was seen: in the source, or in the page the dev server rendered. */
export type AuditSource = 'static' | 'rendered';

export const AUDIT_CHECK_IDS = [
  'img-alt',
  'img-decorative',
  'link-name',
  'button-name',
  'svg-button-label',
  'control-label',
  'heading-order',
  'h1-count',
  'html-lang',
  'duplicate-id',
  'aria-role',
  'aria-hidden-focusable',
  'tabindex-positive',
  'video-autoplay',
  'contrast',
  'iframe-title',
  'title-missing',
  'title-duplicate',
  'description-missing',
  'description-duplicate',
  'description-short',
  'description-long',
  'canonical',
  'social-tags',
  'noindex',
  'img-dimensions',
  'link-broken',
  'sitemap',
  'robots',
  'link-text',
  'structured-data',
  'img-large',
  'link-noopener',
  'placeholder-text',
  'placeholder-image',
  'launch-favicon',
  'launch-404',
  'launch-social-image',
  'launch-analytics',
  'token-color',
  'token-value',
  'token-unit',
  'style-global',
  'style-layer',
  'perf-lcp',
  'perf-cls',
  'perf-tbt',
  'perf-weight',
  'perf-blocking',
  'perf-image-size',
  'perf-image-format',
  'perf-lazy',
  'perf-fetchpriority',
  'perf-font-display',
  'perf-third-party',
] as const;
export type AuditCheckId = (typeof AUDIT_CHECK_IDS)[number];

export interface AuditCheckInfo {
  readonly title: string;
  /** The translatable form of `title`: the renderer shows it with `useTranslateRef`; `title` stays for logs, search and the prompt. */
  readonly titleRef: MessageRef;
  readonly category: AuditCategory;
  readonly priority: AuditPriority;
  /** One line: why it matters, for the row. */
  readonly why: string;
  readonly whyRef: MessageRef;
  /** The WCAG success criterion, or the SEO reason, the hand-off prompt cites. */
  readonly reference: string;
}

/** Every check's description. Total over AUDIT_CHECK_IDS: a new check is a compile error here until described. */
export const AUDIT_CHECKS: Readonly<Record<AuditCheckId, AuditCheckInfo>> = {
  'img-alt': {
    title: 'Missing alt text',
    titleRef: checkRef('audits.check.imgAlt.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'Screen readers announce the file name, or nothing, instead of what the image shows.',
    whyRef: checkRef('audits.check.imgAlt.why'),
    reference: 'WCAG 2.2 SC 1.1.1 Non-text Content (A)',
  },
  'img-decorative': {
    title: 'Decorative image has alt',
    titleRef: checkRef('audits.check.imgDecorative.title'),
    category: 'accessibility',
    priority: 'low',
    why: 'An image marked decorative is still announced while its alt text is not empty.',
    whyRef: checkRef('audits.check.imgDecorative.why'),
    reference: 'WCAG 2.2 SC 1.1.1 Non-text Content (A)',
  },
  'link-name': {
    title: 'Unnamed link',
    titleRef: checkRef('audits.check.linkName.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'Assistive technology announces only "link", so nobody can tell where it goes.',
    whyRef: checkRef('audits.check.linkName.why'),
    reference: 'WCAG 2.2 SC 2.4.4 Link Purpose (A), SC 4.1.2 Name, Role, Value (A)',
  },
  'button-name': {
    title: 'Unnamed button',
    titleRef: checkRef('audits.check.buttonName.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'A button with no text or label is announced as "button" with no purpose.',
    whyRef: checkRef('audits.check.buttonName.why'),
    reference: 'WCAG 2.2 SC 4.1.2 Name, Role, Value (A)',
  },
  'svg-button-label': {
    title: 'Unlabelled icon button',
    titleRef: checkRef('audits.check.svgButtonLabel.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'The icon is drawn, not read: without a label the control has no name.',
    whyRef: checkRef('audits.check.svgButtonLabel.why'),
    reference: 'WCAG 2.2 SC 1.1.1 Non-text Content (A), SC 4.1.2 Name, Role, Value (A)',
  },
  'control-label': {
    title: 'Unlabelled field',
    titleRef: checkRef('audits.check.controlLabel.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'People using screen readers or voice control cannot tell what to enter.',
    whyRef: checkRef('audits.check.controlLabel.why'),
    reference: 'WCAG 2.2 SC 1.3.1 Info and Relationships (A), SC 3.3.2 Labels or Instructions (A)',
  },
  'heading-order': {
    title: 'Skipped heading level',
    titleRef: checkRef('audits.check.headingOrder.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'Skipping levels breaks the outline people navigate a page by.',
    whyRef: checkRef('audits.check.headingOrder.why'),
    reference: 'WCAG 2.2 SC 1.3.1 Info and Relationships (A)',
  },
  'h1-count': {
    title: 'Missing or extra h1',
    titleRef: checkRef('audits.check.h1Count.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'One top heading tells readers and search engines what the page is about.',
    whyRef: checkRef('audits.check.h1Count.why'),
    reference: 'WCAG 2.2 SC 2.4.6 Headings and Labels (AA); search engines read the h1 as the main topic',
  },
  'html-lang': {
    title: 'Missing lang',
    titleRef: checkRef('audits.check.htmlLang.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'Screen readers pick the wrong voice and pronunciation without a lang attribute.',
    whyRef: checkRef('audits.check.htmlLang.why'),
    reference: 'WCAG 2.2 SC 3.1.1 Language of Page (A)',
  },
  'duplicate-id': {
    title: 'Duplicate id',
    titleRef: checkRef('audits.check.duplicateId.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'Labels, anchors and ARIA references point at the first element only.',
    whyRef: checkRef('audits.check.duplicateId.why'),
    reference: 'WCAG 2.2 SC 4.1.2 Name, Role, Value (A); HTML requires unique ids',
  },
  'aria-role': {
    title: 'Invalid role',
    titleRef: checkRef('audits.check.ariaRole.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'An unknown role is ignored, or misleads assistive technology about the element.',
    whyRef: checkRef('audits.check.ariaRole.why'),
    reference: 'WCAG 2.2 SC 4.1.2 Name, Role, Value (A)',
  },
  'aria-hidden-focusable': {
    title: 'Hidden but focusable',
    titleRef: checkRef('audits.check.ariaHiddenFocusable.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'Keyboard focus lands on something screen readers were told does not exist.',
    whyRef: checkRef('audits.check.ariaHiddenFocusable.why'),
    reference: 'WCAG 2.2 SC 4.1.2 Name, Role, Value (A), SC 2.4.3 Focus Order (A)',
  },
  'tabindex-positive': {
    title: 'Positive tabindex',
    titleRef: checkRef('audits.check.tabindexPositive.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'A positive tabindex jumps the element ahead of the page’s reading order.',
    whyRef: checkRef('audits.check.tabindexPositive.why'),
    reference: 'WCAG 2.2 SC 2.4.3 Focus Order (A)',
  },
  'video-autoplay': {
    title: 'Autoplaying video',
    titleRef: checkRef('audits.check.videoAutoplay.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'Sound that starts on its own, or motion with no way to stop it, gets in the way.',
    whyRef: checkRef('audits.check.videoAutoplay.why'),
    reference: 'WCAG 2.2 SC 1.4.2 Audio Control (A), SC 2.2.2 Pause, Stop, Hide (A)',
  },
  contrast: {
    title: 'Low contrast',
    titleRef: checkRef('audits.check.contrast.title'),
    category: 'accessibility',
    priority: 'high',
    why: 'Low-contrast text is hard to read, in sunlight and for people with low vision.',
    whyRef: checkRef('audits.check.contrast.why'),
    reference: 'WCAG 2.2 SC 1.4.3 Contrast (Minimum) (AA)',
  },
  'iframe-title': {
    title: 'Untitled iframe',
    titleRef: checkRef('audits.check.iframeTitle.title'),
    category: 'accessibility',
    priority: 'medium',
    why: 'Screen readers list frames by title; an untitled frame is a mystery.',
    whyRef: checkRef('audits.check.iframeTitle.why'),
    reference: 'WCAG 2.2 SC 4.1.2 Name, Role, Value (A)',
  },
  'title-missing': {
    title: 'Missing title',
    titleRef: checkRef('audits.check.titleMissing.title'),
    category: 'seo',
    priority: 'high',
    why: 'The title is the tab name, the bookmark and the search result headline.',
    whyRef: checkRef('audits.check.titleMissing.why'),
    reference: 'Search engines show <title> as the result headline; WCAG 2.2 SC 2.4.2 Page Titled (A)',
  },
  'title-duplicate': {
    title: 'Duplicate title',
    titleRef: checkRef('audits.check.titleDuplicate.title'),
    category: 'seo',
    priority: 'medium',
    why: 'Pages with the same title compete with each other in search results.',
    whyRef: checkRef('audits.check.titleDuplicate.why'),
    reference: 'Unique titles help search engines tell pages apart',
  },
  'description-missing': {
    title: 'Missing description',
    titleRef: checkRef('audits.check.descriptionMissing.title'),
    category: 'seo',
    priority: 'medium',
    why: 'Without one, search engines pick a snippet from the page, often a poor one.',
    whyRef: checkRef('audits.check.descriptionMissing.why'),
    reference: 'The meta description is the search result snippet',
  },
  'description-duplicate': {
    title: 'Duplicate description',
    titleRef: checkRef('audits.check.descriptionDuplicate.title'),
    category: 'seo',
    priority: 'low',
    why: 'The same snippet on many pages makes every result look alike.',
    whyRef: checkRef('audits.check.descriptionDuplicate.why'),
    reference: 'Unique descriptions help search engines tell pages apart',
  },
  'description-short': {
    title: 'Description too short',
    titleRef: checkRef('audits.check.descriptionShort.title'),
    category: 'seo',
    priority: 'low',
    why: 'Search results pad a short description with text taken from the page.',
    whyRef: checkRef('audits.check.descriptionShort.why'),
    reference: 'Search snippets show roughly 50 to 160 characters',
  },
  'description-long': {
    title: 'Description too long',
    titleRef: checkRef('audits.check.descriptionLong.title'),
    category: 'seo',
    priority: 'low',
    why: 'Search results cut a long description off mid-sentence.',
    whyRef: checkRef('audits.check.descriptionLong.why'),
    reference: 'Search snippets show roughly 50 to 160 characters',
  },
  canonical: {
    title: 'Canonical link',
    titleRef: checkRef('audits.check.canonical.title'),
    category: 'seo',
    priority: 'low',
    why: 'Without a canonical URL, duplicate addresses split a page’s ranking.',
    whyRef: checkRef('audits.check.canonical.why'),
    reference: 'rel="canonical" names the preferred URL for search engines',
  },
  'social-tags': {
    title: 'Missing social tags',
    titleRef: checkRef('audits.check.socialTags.title'),
    category: 'seo',
    priority: 'low',
    why: 'Shared links show no title, description or image in social previews.',
    whyRef: checkRef('audits.check.socialTags.why'),
    reference: 'Open Graph and Twitter card metadata drive link previews',
  },
  noindex: {
    title: 'Hidden from search',
    titleRef: checkRef('audits.check.noindex.title'),
    category: 'seo',
    priority: 'high',
    why: 'A noindex robots tag keeps the page out of every search engine.',
    whyRef: checkRef('audits.check.noindex.why'),
    reference: '<meta name="robots" content="noindex"> removes a page from search results',
  },
  'img-dimensions': {
    title: 'Image without size',
    titleRef: checkRef('audits.check.imgDimensions.title'),
    category: 'seo',
    priority: 'medium',
    why: 'The page jumps when the image loads (layout shift), which hurts Core Web Vitals.',
    whyRef: checkRef('audits.check.imgDimensions.why'),
    reference: 'Cumulative Layout Shift (Core Web Vitals)',
  },
  'link-broken': {
    title: 'Broken link',
    titleRef: checkRef('audits.check.linkBroken.title'),
    category: 'seo',
    priority: 'high',
    why: 'Visitors and crawlers land on a 404.',
    whyRef: checkRef('audits.check.linkBroken.why'),
    reference: 'Broken internal links waste crawl budget and lose visitors',
  },
  sitemap: {
    title: 'No sitemap',
    titleRef: checkRef('audits.check.sitemap.title'),
    category: 'seo',
    priority: 'medium',
    why: 'A sitemap tells search engines which pages exist.',
    whyRef: checkRef('audits.check.sitemap.why'),
    reference: '@astrojs/sitemap generates sitemap-index.xml at build',
  },
  robots: {
    title: 'No robots.txt',
    titleRef: checkRef('audits.check.robots.title'),
    category: 'seo',
    priority: 'low',
    why: 'Crawlers look for robots.txt first, and for the sitemap it names.',
    whyRef: checkRef('audits.check.robots.why'),
    reference: 'robots.txt points crawlers at the sitemap',
  },
  'link-text': {
    title: 'Vague link text',
    titleRef: checkRef('audits.check.linkText.title'),
    category: 'seo',
    priority: 'low',
    why: '"Click here" says nothing out of context, to people or to search engines.',
    whyRef: checkRef('audits.check.linkText.why'),
    reference: 'WCAG 2.2 SC 2.4.4 Link Purpose (A); link text is a ranking signal',
  },
  'structured-data': {
    title: 'No structured data',
    titleRef: checkRef('audits.check.structuredData.title'),
    category: 'seo',
    priority: 'low',
    why: 'Schema markup can earn rich results such as breadcrumbs and articles.',
    whyRef: checkRef('audits.check.structuredData.why'),
    reference: 'schema.org JSON-LD in <script type="application/ld+json">',
  },
  'img-large': {
    title: 'Large image',
    titleRef: checkRef('audits.check.imgLarge.title'),
    category: 'seo',
    priority: 'medium',
    why: 'Large images slow the page’s first paint, most of all on mobile.',
    whyRef: checkRef('audits.check.imgLarge.why'),
    reference: 'Largest Contentful Paint (Core Web Vitals)',
  },
  'link-noopener': {
    title: 'New tab without noopener',
    titleRef: checkRef('audits.check.linkNoopener.title'),
    category: 'seo',
    priority: 'low',
    why: 'A page opened in a new tab can reach back into this one through window.opener.',
    whyRef: checkRef('audits.check.linkNoopener.why'),
    reference: 'rel="noopener" cuts the opener reference',
  },
  'placeholder-text': {
    title: 'Placeholder text',
    titleRef: checkRef('audits.check.placeholderText.title'),
    category: 'content',
    priority: 'high',
    why: 'Lorem ipsum and template copy look unfinished and say nothing to readers or search engines.',
    whyRef: checkRef('audits.check.placeholderText.why'),
    reference: 'Pages should ship with their real copy',
  },
  'placeholder-image': {
    title: 'Placeholder image',
    titleRef: checkRef('audits.check.placeholderImage.title'),
    category: 'content',
    priority: 'medium',
    why: 'A stock placeholder image is not the picture the page needs.',
    whyRef: checkRef('audits.check.placeholderImage.why'),
    reference: 'Pages should ship with their real images',
  },
  'launch-favicon': {
    title: 'No favicon',
    titleRef: checkRef('audits.check.launchFavicon.title'),
    category: 'seo',
    priority: 'medium',
    why: 'Tabs, bookmarks and search results show a blank icon.',
    whyRef: checkRef('audits.check.launchFavicon.why'),
    reference: 'Launch checklist: <link rel="icon">',
  },
  'launch-404': {
    title: 'No 404 page',
    titleRef: checkRef('audits.check.launch404.title'),
    category: 'seo',
    priority: 'medium',
    why: 'A missing page shows the host’s bare error instead of a way back into the site.',
    whyRef: checkRef('audits.check.launch404.why'),
    reference: 'Launch checklist: src/pages/404',
  },
  'launch-social-image': {
    title: 'No social image',
    titleRef: checkRef('audits.check.launchSocialImage.title'),
    category: 'seo',
    priority: 'medium',
    why: 'Links shared on social media show no picture, or a broken one.',
    whyRef: checkRef('audits.check.launchSocialImage.why'),
    reference: 'Launch checklist: og:image / twitter:image that loads',
  },
  'launch-analytics': {
    title: 'No analytics',
    titleRef: checkRef('audits.check.launchAnalytics.title'),
    category: 'seo',
    priority: 'low',
    why: 'Without analytics nobody can tell how the site is used after launch.',
    whyRef: checkRef('audits.check.launchAnalytics.why'),
    reference: 'Launch checklist: an analytics snippet or integration',
  },
  'token-color': {
    title: 'Raw colour',
    titleRef: checkRef('audits.check.tokenColor.title'),
    category: 'tokens',
    priority: 'medium',
    why: 'A colour written by hand drifts from the palette; a variable keeps every use in step.',
    whyRef: checkRef('audits.check.tokenColor.why'),
    reference: 'Design tokens: colours come from variables',
  },
  'token-value': {
    title: 'Raw value',
    titleRef: checkRef('audits.check.tokenValue.title'),
    category: 'tokens',
    priority: 'low',
    why: 'Spacing, radius and type written by hand drift from the scale the variables define.',
    whyRef: checkRef('audits.check.tokenValue.why'),
    reference: 'Design tokens: sizes come from variables',
  },
  'token-unit': {
    title: 'Unit outside a variable',
    titleRef: checkRef('audits.check.tokenUnit.title'),
    category: 'tokens',
    priority: 'low',
    why: 'The project keeps this unit inside variable definitions only.',
    whyRef: checkRef('audits.check.tokenUnit.why'),
    reference: 'Design tokens: unit rules from .stacki/audits.json',
  },
  'style-global': {
    title: 'Style block not global',
    titleRef: checkRef('audits.check.styleGlobal.title'),
    category: 'tokens',
    priority: 'medium',
    why: 'A scoped <style> only reaches this file’s own markup; the project writes global styles.',
    whyRef: checkRef('audits.check.styleGlobal.why', { style: '<style>' }),
    reference: 'Stacki projects write <style is:global>',
  },
  'style-layer': {
    title: 'Global styles outside @layer',
    titleRef: checkRef('audits.check.styleLayer.title'),
    category: 'tokens',
    priority: 'low',
    why: 'Unlayered global rules outrank every layer, so components cannot override them.',
    whyRef: checkRef('audits.check.styleLayer.why'),
    reference: 'Global styles sit inside an @layer',
  },
  'perf-lcp': {
    title: 'Slow largest paint',
    titleRef: checkRef('audits.check.perfLcp.title'),
    category: 'performance',
    priority: 'high',
    why: 'The biggest element takes long to appear, so the page feels slow to load.',
    whyRef: checkRef('audits.check.perfLcp.why'),
    reference: 'Largest Contentful Paint (Core Web Vitals): good under 2.5 s',
  },
  'perf-cls': {
    title: 'Layout shift',
    titleRef: checkRef('audits.check.perfCls.title'),
    category: 'performance',
    priority: 'high',
    why: 'Content jumps as the page loads, and people click the wrong thing.',
    whyRef: checkRef('audits.check.perfCls.why'),
    reference: 'Cumulative Layout Shift (Core Web Vitals): good under 0.1',
  },
  'perf-tbt': {
    title: 'Long tasks',
    titleRef: checkRef('audits.check.perfTbt.title'),
    category: 'performance',
    priority: 'medium',
    why: 'Script work blocks the page from answering clicks and typing.',
    whyRef: checkRef('audits.check.perfTbt.why'),
    reference: 'Total Blocking Time: good under 200 ms',
  },
  'perf-weight': {
    title: 'Heavy page',
    titleRef: checkRef('audits.check.perfWeight.title'),
    category: 'performance',
    priority: 'medium',
    why: 'Many or large downloads slow the page on mobile connections.',
    whyRef: checkRef('audits.check.perfWeight.why'),
    reference: 'Page weight and request count',
  },
  'perf-blocking': {
    title: 'Render-blocking resource',
    titleRef: checkRef('audits.check.perfBlocking.title'),
    category: 'performance',
    priority: 'medium',
    why: 'A stylesheet or script in the head holds back the first paint.',
    whyRef: checkRef('audits.check.perfBlocking.why'),
    reference: 'Render-blocking resources delay First Contentful Paint',
  },
  'perf-image-size': {
    title: 'Oversized image',
    titleRef: checkRef('audits.check.perfImageSize.title'),
    category: 'performance',
    priority: 'medium',
    why: 'The file has far more pixels than the page shows.',
    whyRef: checkRef('audits.check.perfImageSize.why'),
    reference: 'Serve images at their displayed size (times the screen’s density)',
  },
  'perf-image-format': {
    title: 'Image not AVIF or WebP',
    titleRef: checkRef('audits.check.perfImageFormat.title'),
    category: 'performance',
    priority: 'low',
    why: 'Modern formats are much smaller for the same picture.',
    whyRef: checkRef('audits.check.perfImageFormat.why'),
    reference: 'Serve images in AVIF or WebP',
  },
  'perf-lazy': {
    title: 'Offscreen image loads eagerly',
    titleRef: checkRef('audits.check.perfLazy.title'),
    category: 'performance',
    priority: 'low',
    why: 'Images below the fold compete with what people see first.',
    whyRef: checkRef('audits.check.perfLazy.why'),
    reference: 'loading="lazy" for images below the fold',
  },
  'perf-fetchpriority': {
    title: 'Largest image not prioritised',
    titleRef: checkRef('audits.check.perfFetchpriority.title'),
    category: 'performance',
    priority: 'medium',
    why: 'The browser fetches the most important image no sooner than the rest.',
    whyRef: checkRef('audits.check.perfFetchpriority.why'),
    reference: 'fetchpriority="high" on the LCP image',
  },
  'perf-font-display': {
    title: 'Font without font-display',
    titleRef: checkRef('audits.check.perfFontDisplay.title'),
    category: 'performance',
    priority: 'low',
    why: 'Text stays invisible while the font downloads.',
    whyRef: checkRef('audits.check.perfFontDisplay.why'),
    reference: 'font-display: swap on @font-face',
  },
  'perf-third-party': {
    title: 'Third-party script',
    titleRef: checkRef('audits.check.perfThirdParty.title'),
    category: 'performance',
    priority: 'low',
    why: 'Scripts from other origins add requests and work you do not control.',
    whyRef: checkRef('audits.check.perfThirdParty.why'),
    reference: 'Audit third-party scripts',
  },
};

/** Where in a file a finding is: the element's structural path, its tag and its line. */
export interface AuditElementRef {
  /** Index path in the file's parse: [0, 2, 1] is the parser's `n0.2.1`. */
  readonly path: readonly number[];
  readonly tag: string;
  /** 1-based, when the parse carried source offsets. */
  readonly line: number | undefined;
}

/** One change a fix makes to one node, named by path in the file the fix is for. */
export type AuditEdit =
  | {
      readonly tag: 'attributes';
      readonly path: readonly number[];
      /** The tag the node at `path` must still have: a file that moved since the audit is refused, not guessed at. */
      readonly expect: string;
      /** A value sets the attribute; undefined removes it. */
      readonly patch: Readonly<Record<string, Attr | undefined>>;
    }
  | {
      readonly tag: 'append-child';
      /** The parent the new element goes last inside. */
      readonly path: readonly number[];
      readonly expect: string;
      readonly element: AuditNewElement;
    }
  | {
      /** A statement the frontmatter gains, unless it already holds it (a per-instance key). */
      readonly tag: 'frontmatter-append';
      readonly code: string;
    }
  | {
      /** Text swapped inside a raw node (a `<style>` block's CSS): `before` at `offset` of its inside becomes `after`. */
      readonly tag: 'raw-text';
      readonly path: readonly number[];
      readonly expect: string;
      readonly offset: number;
      readonly before: string;
      readonly after: string;
    }
  | {
      /** Text swapped in a file that is not markup (a stylesheet): `before` at `offset` becomes `after`. */
      readonly tag: 'file-text';
      readonly offset: number;
      readonly before: string;
      readonly after: string;
    }
  | {
      /** A text node's words, replaced: `value` is the node's new raw text. */
      readonly tag: 'text';
      readonly path: readonly number[];
      readonly before: string;
      readonly value: string;
    };

/** An element a fix writes: a tag, its attributes, and at most one text or expression child. */
export interface AuditNewElement {
  readonly name: string;
  readonly props: Readonly<Record<string, Attr>>;
  readonly content: { readonly kind: 'text' | 'expr'; readonly value: string } | undefined;
}

/** A deterministic fix: what it does, the code it writes, and the edits that write it. */
export interface AuditFix {
  /** The button's words: "Add lang", "Add width and height". */
  readonly label: string;
  /** The translatable form of `label` (the renderer shows it); `label` stays English: undo history, choices and old readers key on it. */
  readonly labelRef?: MessageRef;
  /** The markup before and after, for the preview the row shows before applying. */
  readonly before: string;
  readonly after: string;
  /** The file the edits are for, project-relative: the component's own file when the issue is in its markup. */
  readonly file: string;
  readonly edits: readonly AuditEdit[];
}

/** What kind of file a finding is in: it decides how a fix is described ("fixes every use"). */
export type AuditFileKind = 'page' | 'component' | 'layout' | 'site';

export interface AuditFinding {
  /** Stable across runs over the same source: the ignore file keys on it. */
  readonly id: string;
  readonly check: AuditCheckId;
  /** Project-relative, `/`-separated. A site finding names the config or the folder it is about. */
  readonly file: string;
  readonly fileKind: AuditFileKind;
  readonly element: AuditElementRef | undefined;
  /** What this occurrence is: `src="/hero.png"`, `h2 → h4`. */
  readonly detail: string;
  /** The translatable form of `detail` when it holds a sentence (not when it is code such as `src="/a.png"`). The id keys on the English `detail`, never on this. */
  readonly detailRef?: MessageRef;
  readonly source: AuditSource;
  readonly fix: AuditFix | undefined;
  /** The text the finding is about, when rewriting it is the fix (a description to shorten): quoted to the agent. */
  readonly excerpt?: string;
  /** A short measurement the row shows beside the name: `35 characters`. */
  readonly measure?: string;
  readonly measureRef?: MessageRef;
  /** On a component instance found by tracing a value to where it is written: the prop to edit there. */
  readonly prop?: string;
  /** Other fixes to choose from, when several are equally right (two variables hold the same value). */
  readonly choices?: readonly AuditFix[];
  /** For a raw value in CSS: the rule and declaration it is in, for the review window. */
  readonly css?: AuditCssContext;
  /** The project's own priority for this check, from `.stacki/audits.json`. */
  readonly priority?: AuditPriority;
  /** For a finding in a component's own markup seen on rendered pages: the routes it shows on. One finding, many occurrences. */
  readonly routes?: readonly string[];
}

/** Where a raw CSS value is: its rule's selector, the declaration, the token, the file's line, and what kind of value it is. */
export interface AuditCssContext {
  readonly selector: string;
  readonly property: string;
  readonly value: string;
  readonly token: string;
  readonly line: number | undefined;
  /** colour, spacing, radius, type, size or unit (shared/page/auditTokens.ts tokenGroup). */
  readonly group: string;
  /** Where the token's bytes are, so the review window can replace them without a variable to swap to. Absent for an inline `style` attribute. */
  readonly place?: AuditCssPlace;
}

/** The bytes of a raw token: inside a `<style>` block's text at `path`, or in a stylesheet file, at `offset`. */
export type AuditCssPlace =
  { readonly tag: 'style-block'; readonly path: readonly number[]; readonly offset: number } | { readonly tag: 'stylesheet'; readonly offset: number };

/**
 * Tag names that appear inside messages. A catalog message cannot hold a literal `<tag>` (it reads as a rich-text mark), so a
 * sentence takes the tag as a parameter: `detailText('audits.detail.headNoTitle', { head: AUDIT_TAGS.head, title: AUDIT_TAGS.title })`.
 */
export const AUDIT_TAGS = { head: '<head>', html: '<html>', title: '<title>', h1: '<h1>', style: '<style>', styleGlobal: '<style is:global>' } as const;

/** A finding's detail sentence: the English text it always had, with the reference the renderer translates. Spread into a finding. */
export function detailText(key: AuditTextKey, params?: MessageParams): { readonly detail: string; readonly detailRef: MessageRef } {
  const sentence = auditSentence(key, params);
  return { detail: sentence.text, detailRef: sentence.ref };
}

/** A fix's button words, in English and as a reference. Spread into a fix. */
export function labelText(key: AuditTextKey, params?: MessageParams): { readonly label: string; readonly labelRef: MessageRef } {
  const sentence = auditSentence(key, params);
  return { label: sentence.text, labelRef: sentence.ref };
}

/** A finding's measurement words, in English and as a reference. Spread into a finding. */
export function measureText(key: AuditTextKey, params?: MessageParams): { readonly measure: string; readonly measureRef: MessageRef } {
  const sentence = auditSentence(key, params);
  return { measure: sentence.text, measureRef: sentence.ref };
}

/** The id a finding is ignored by: the check, the file, the element's path and the detail. */
export function findingId(input: Pick<AuditFinding, 'check' | 'file' | 'element' | 'detail'>): string {
  assert(input.file.length > 0, 'findingId: a finding names a file');
  assert(AUDIT_CHECK_IDS.includes(input.check), 'findingId: the check is a known one');
  const where = input.element === undefined ? '-' : input.element.path.join('.');
  return `${input.check}|${input.file}|${where}|${input.detail}`;
}

/** A finding built from its parts, its id derived and its detail bounded. */
export function auditFinding(input: Omit<AuditFinding, 'id'>): AuditFinding {
  assert(input.file.length > 0, 'auditFinding: a finding names a file');
  const detail = input.detail.length > AUDIT_LIMITS.detailCharsMax ? `${input.detail.slice(0, AUDIT_LIMITS.detailCharsMax - 1)}…` : input.detail;
  assert(detail.length <= AUDIT_LIMITS.detailCharsMax, 'auditFinding: the detail is bounded');
  if (input.fix !== undefined) {
    assert(input.fix.edits.length > 0, 'auditFinding: a fix makes at least one edit');
    assert(input.fix.edits.length <= AUDIT_LIMITS.fixEditsMax, 'auditFinding: a fix is bounded');
  }
  // A truncated detail no longer matches its sentence, so the reference is dropped and the English shows.
  const { detailRef, ...rest } = input;
  const bounded = detail === input.detail && detailRef !== undefined ? { ...rest, detailRef, detail } : { ...rest, detail };
  return { ...bounded, id: findingId(bounded) };
}

/** Which description check a length fails, or undefined when it is inside the range search snippets show. */
export function descriptionLengthCheck(length: number): 'description-short' | 'description-long' | undefined {
  assert(Number.isSafeInteger(length), 'descriptionLengthCheck: a length is an integer');
  assert(length >= 0, 'descriptionLengthCheck: a length is not negative');
  if (length < DESCRIPTION_CHARS_MIN) {
    return 'description-short';
  }
  return length > DESCRIPTION_CHARS_MAX ? 'description-long' : undefined;
}

/** The meta description lengths search snippets show without padding or cutting. */
export const DESCRIPTION_CHARS_MIN = 50;
export const DESCRIPTION_CHARS_MAX = 160;

/** A finding's priority, from its check. */
export function findingPriority(finding: Pick<AuditFinding, 'check' | 'priority'>): AuditPriority {
  return finding.priority ?? AUDIT_CHECKS[finding.check].priority;
}

/** Findings by priority, high first, each group in file then path order, so a list holds still across runs. */
export function groupedFindings(findings: readonly AuditFinding[]): ReadonlyMap<AuditPriority, readonly AuditFinding[]> {
  assert(findings.length <= AUDIT_LIMITS.findingsMax, 'groupedFindings: the findings are bounded');
  const groups = new Map<AuditPriority, AuditFinding[]>(AUDIT_PRIORITIES.map((priority) => [priority, []]));
  for (const finding of findings) {
    groups.get(findingPriority(finding))?.push(finding);
  }
  for (const list of groups.values()) {
    list.sort(compareFindings);
  }
  assert(groups.size === AUDIT_PRIORITIES.length, 'groupedFindings: one group per priority');
  return groups;
}

/** File, then path, then check: the order findings are listed and fixed in. */
export function compareFindings(left: AuditFinding, right: AuditFinding): number {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }
  const leftPath = left.element?.path ?? [];
  const rightPath = right.element?.path ?? [];
  const shared = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < shared; index++) {
    const difference = (leftPath[index] ?? 0) - (rightPath[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (leftPath.length !== rightPath.length) {
    return leftPath.length - rightPath.length;
  }
  if (left.check !== right.check) {
    return left.check < right.check ? -1 : 1;
  }
  return left.detail < right.detail ? -1 : left.detail > right.detail ? 1 : 0;
}

/** Findings with their duplicates dropped: one per id, a static one (which may carry a fix) kept over a
 * rendered one, and the routes a component's finding was seen on merged into the one kept. */
export function uniqueFindings(findings: readonly AuditFinding[]): readonly AuditFinding[] {
  const byId = new Map<string, AuditFinding>();
  for (const finding of findings) {
    const seen = byId.get(finding.id);
    if (seen === undefined) {
      byId.set(finding.id, finding);
      continue;
    }
    const kept = seen.source === 'rendered' && finding.source === 'static' ? finding : seen;
    const routes = [...new Set([...(seen.routes ?? []), ...(finding.routes ?? [])])].sort();
    byId.set(finding.id, routes.length === 0 ? kept : { ...kept, routes });
  }
  const unique = [...byId.values()];
  assert(unique.length <= findings.length, 'uniqueFindings: only removes');
  return unique;
}

/** One rule's findings, for a row that groups its occurrences. */
export interface AuditRuleGroup {
  readonly check: AuditCheckId;
  readonly findings: readonly AuditFinding[];
}

/** Findings by rule, in AUDIT_CHECK_IDS order, each rule's findings in file then path order. */
export function findingsByRule(findings: readonly AuditFinding[]): readonly AuditRuleGroup[] {
  const groups = AUDIT_CHECK_IDS.map((check) => ({ check, findings: findings.filter((finding) => finding.check === check).sort(compareFindings) })).filter(
    (group) => group.findings.length > 0,
  );
  assert(groups.reduce((total, group) => total + group.findings.length, 0) === findings.length, 'findingsByRule: every finding in one group');
  return groups;
}

/** The fixes among `findings` that make no choice of content: "Fix all N safe fixes". */
export function safeFixes(findings: readonly AuditFinding[]): readonly AuditFinding[] {
  const fixable = findings.filter((finding) => finding.fix !== undefined);
  assert(fixable.length <= findings.length, 'safeFixes: a subset');
  return fixable;
}
