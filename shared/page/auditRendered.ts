// The audit's rendered checks: what only the page the dev server rendered can
// show. A page's final heading outline runs through its layout and every
// component; a link's name may arrive through a slot; ids collide across
// files; the head a layout writes holds the page's real title. The renderer
// reads the rendered HTML into the plain tree below (no DOM crosses into
// shared/), with each element's source location taken from the dev server's
// `<!--avb-s:…-->` markers and, for contrast, its computed colours.
import { assert } from '../core/assert';
import {
  AUDIT_LIMITS,
  AUDIT_TAGS,
  auditFinding,
  descriptionLengthCheck,
  detailText,
  measureText,
  type AuditFileKind,
  type AuditFinding,
} from './auditFindings';
import type { MessageRef } from '../core/i18n/messageReference';
import { contrastVerdict } from './auditContrast';
import { DESCRIPTION_CHARS_MAX, DESCRIPTION_CHARS_MIN, VAGUE_LINK_TEXT, placeholderDetail, placeholderImage, placeholderPhrase } from './auditStatic';

/** Where a rendered element was written: the file and the structural path its marker names. */
export interface RenderedSource {
  readonly file: string;
  readonly path: readonly number[];
  /** The element has no marker of its own (a component wrote it, through set:html or a transform):
   * the location is its nearest marked ancestor's, the node that rendered it. */
  readonly ancestor?: true;
}

/** The computed style the contrast check reads; absent where the renderer could not compute one. */
export interface RenderedStyle {
  readonly color: string;
  /** The first opaque background behind the element, or `unknown` behind an image or gradient. */
  readonly background: string | 'unknown';
  readonly fontSizePx: number;
  readonly fontWeight: number;
}

export interface RenderedElement {
  readonly kind: 'element';
  /** Lower case. */
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly RenderedNode[];
  readonly source: RenderedSource | undefined;
  readonly style: RenderedStyle | undefined;
}

/** A text node; `source` is the marker written right before it, the text's own node in its file. */
export type RenderedNode = RenderedElement | { readonly kind: 'text'; readonly value: string; readonly source?: RenderedSource };

export interface RenderedPage {
  /** The page file the route renders, project-relative. */
  readonly file: string;
  readonly route: string;
  readonly root: RenderedElement;
}

export interface RenderedAudit {
  readonly findings: readonly AuditFinding[];
  /** The final title and description, for the site's duplicate checks. */
  readonly title: string | undefined;
  readonly description: string | undefined;
  readonly structuredData: boolean;
  /** Whether the head links an icon. */
  readonly icon: boolean;
  /** The social image the head names, and its tag, for the launch checks. */
  readonly socialImage: { readonly url: string; readonly element: RenderedElement } | undefined;
  /** Whether an analytics snippet is in the page. */
  readonly analytics: boolean;
}

/** Script sources and inline calls of the analytics services a launch checks for. */
export const ANALYTICS_PATTERN =
  /googletagmanager\.com|google-analytics\.com|gtag\(|plausible|usefathom|fathom\.|posthog|umami|simpleanalytics|cloudflareinsights|_vercel\/insights|va\.vercel-scripts|clarity\.ms|matomo|hotjar|segment\.(com|io)|gauges|pirsch|counter\.dev|goatcounter/i;

/** The location a dev-server marker comment names, or undefined for any other comment. */
export function parseMarker(data: string, pageFile: string): RenderedSource | undefined {
  assert(pageFile.length > 0, 'parseMarker: a page names its file');
  if (!data.startsWith('avb-s:')) {
    return undefined;
  }
  const body = data.slice('avb-s:'.length);
  const bar = body.lastIndexOf('|');
  const file = bar === -1 ? pageFile : body.slice(0, bar);
  const id = bar === -1 ? body : body.slice(bar + 1);
  // The dev server writes the structural path as bare indexes, `0.2.1` (astroParser.ts serializePageMarked);
  // the parser's own ids spell the same path `n0.2.1`, and either is read.
  const digits = id.startsWith('n') ? id.slice(1) : id;
  if (!/^\d+(?:\.\d+)*$/.test(digits) || file.length === 0) {
    return undefined;
  }
  const path = digits.split('.').map((part) => Number.parseInt(part, 10));
  assert(
    path.every((index) => Number.isSafeInteger(index)),
    'parseMarker: a marker path is integers',
  );
  return { file, path };
}

interface Visit {
  readonly element: RenderedElement;
  readonly insideLink: boolean;
}

/** Every rendered finding on one page. */
export interface RenderedOptions {
  readonly noindexRoutes: readonly string[];
  /** The placeholder phrases the project checks copy against (shared/properties/auditIgnores.ts). */
  readonly placeholders: readonly string[];
}

export function auditRenderedPage(page: RenderedPage, options: RenderedOptions): RenderedAudit {
  assert(page.root.tag === 'html', 'auditRenderedPage: the root is the document element');
  const elements = renderedElements(page.root);
  const findings: AuditFinding[] = [];
  const add: Add = (element, check, detail, extra) => {
    if (findings.length < AUDIT_LIMITS.findingsPerFileMax) {
      findings.push(renderedFinding(page, element, check, detail, extra ?? {}));
    }
  };
  checkDocument(page, elements, add, options);
  checkOutline(elements, add);
  checkNames(elements, add);
  checkIds(elements, add);
  checkContrast(elements, add);
  checkPlaceholders(page, elements, options.placeholders, (finding) => {
    if (findings.length < AUDIT_LIMITS.findingsPerFileMax) {
      findings.push(finding);
    }
  });
  const title = elements.find((visit) => visit.element.tag === 'title');
  const description = elements.find((visit) => visit.element.tag === 'meta' && (visit.element.attrs['name'] ?? '').toLowerCase() === 'description');
  assert(findings.length <= AUDIT_LIMITS.findingsPerFileMax, 'auditRenderedPage: findings are bounded');
  return {
    findings,
    title: title === undefined ? undefined : renderedText(title.element).trim() || undefined,
    description: description?.element.attrs['content']?.trim() || undefined,
    structuredData: elements.some((visit) => visit.element.tag === 'script' && (visit.element.attrs['type'] ?? '').toLowerCase() === 'application/ld+json'),
    icon: elements.some((visit) => visit.element.tag === 'link' && /\bicon\b/i.test(visit.element.attrs['rel'] ?? '')),
    socialImage: socialImageOf(elements),
    analytics: elements.some(
      (visit) => visit.element.tag === 'script' && ANALYTICS_PATTERN.test(`${visit.element.attrs['src'] ?? ''} ${renderedText(visit.element)}`),
    ),
  };
}

function renderedFinding(
  page: RenderedPage,
  element: RenderedElement | undefined,
  check: AuditFinding['check'],
  detail: string | DetailText,
  extra: Pick<AuditFinding, 'excerpt' | 'measure' | 'measureRef'>,
): AuditFinding {
  const source = element?.source;
  const file = source?.file ?? page.file;
  const fileKind: AuditFileKind = file === page.file ? 'page' : file.includes('/layouts/') ? 'layout' : 'component';
  return auditFinding({
    check,
    file,
    fileKind,
    element: source === undefined || element === undefined ? undefined : { path: source.path, tag: element.tag, line: undefined },
    ...writtenDetail(detail, { byComponent: source?.ancestor === true }),
    source: 'rendered',
    fix: undefined,
    ...(extra.excerpt === undefined ? {} : { excerpt: extra.excerpt }),
    ...(extra.measure === undefined ? {} : { measure: extra.measure }),
    ...(extra.measureRef === undefined ? {} : { measureRef: extra.measureRef }),
    ...(file === page.file ? {} : { routes: [page.route] }),
  });
}

// Preorder, each element with whether it sits inside a link (a link's name check reads its own content).
function renderedElements(root: RenderedElement): readonly Visit[] {
  const visits: Visit[] = [];
  const pending: Visit[] = [{ element: root, insideLink: false }];
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < AUDIT_LIMITS.elementsPerFileMax * 4, 'renderedElements: a rendered page stays bounded');
    const visit = pending.pop();
    assert(visit !== undefined, 'renderedElements: the stack holds a visit');
    visits.push(visit);
    const children = visit.element.children.filter((child): child is RenderedElement => child.kind === 'element');
    const insideLink = visit.insideLink || visit.element.tag === 'a';
    pending.push(...children.map((element) => ({ element, insideLink })).reverse());
  }
  return visits;
}

/** The text an element renders, its descendants' text joined. */
export function renderedText(element: RenderedElement): string {
  const parts: string[] = [];
  const pending: RenderedNode[] = [...element.children].reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < AUDIT_LIMITS.elementsPerFileMax, 'renderedText: an element’s text is bounded');
    const node = pending.pop();
    assert(node !== undefined, 'renderedText: the stack holds a node');
    if (node.kind === 'text') {
      parts.push(node.value);
    } else if (node.tag !== 'script' && node.tag !== 'style') {
      pending.push(...[...node.children].reverse());
    }
  }
  return parts.join('').replace(/\s+/g, ' ');
}

/** A detail: plain code-like text (`href="/x"`), or a sentence that carries its reference. */
type DetailText = ReturnType<typeof detailText>;

type Add = (
  element: RenderedElement | undefined,
  check: AuditFinding['check'],
  detail: string | DetailText,
  extra?: Pick<AuditFinding, 'excerpt' | 'measure' | 'measureRef'>,
) => void;

/** The detail of a finding, with the note that a component wrote the element when it did. A sentence loses its reference then, so its English shows. */
function writtenDetail(detail: string | DetailText, options: { readonly byComponent: boolean }): { readonly detail: string; readonly detailRef?: MessageRef } {
  if (typeof detail === 'string') {
    return options.byComponent ? detailText('audits.detail.writtenByComponent', { detail }) : { detail };
  }
  // i18n-ignore: a sentence that already has a reference is shown in English here, because a reference cannot nest another.
  return options.byComponent ? { detail: `${detail.detail} (written by the component here)` } : detail;
}

function checkDocument(page: RenderedPage, elements: readonly Visit[], add: Add, options: Pick<RenderedOptions, 'noindexRoutes'>): void {
  const html = page.root;
  if ((html.attrs['lang'] ?? '').trim().length === 0) {
    add(html, 'html-lang', detailText('audits.detail.htmlNoLang', { html: AUDIT_TAGS.html }));
  }
  const title = elements.find((visit) => visit.element.tag === 'title');
  if (title === undefined || renderedText(title.element).trim().length === 0) {
    add(
      title?.element,
      'title-missing',
      detailText(title === undefined ? 'audits.detail.renderedNoTitle' : 'audits.detail.renderedTitleEmpty', { title: AUDIT_TAGS.title }),
    );
  }
  const meta = (name: string): RenderedElement | undefined =>
    elements.find((visit) => visit.element.tag === 'meta' && (visit.element.attrs['name'] ?? '').toLowerCase() === name)?.element;
  const description = meta('description');
  const content = description?.attrs['content']?.trim() ?? '';
  if (content.length === 0) {
    add(description, 'description-missing', detailText('audits.detail.renderedNoDescription'));
  } else {
    const check = descriptionLengthCheck(content.length);
    if (check !== undefined) {
      add(
        description,
        check,
        detailText('audits.detail.descriptionLength', { length: content.length, min: DESCRIPTION_CHARS_MIN, max: DESCRIPTION_CHARS_MAX }),
        {
          excerpt: content,
          ...measureText('audits.measure.characters', { count: content.length }),
        },
      );
    }
  }
  const robots = meta('robots');
  if (robots !== undefined && /\bnoindex\b/i.test(robots.attrs['content'] ?? '') && !options.noindexRoutes.includes(page.route)) {
    add(robots, 'noindex', `content="${robots.attrs['content'] ?? ''}"`);
  }
  checkCanonical(page, elements, add);
}

function checkCanonical(page: RenderedPage, elements: readonly Visit[], add: Add): void {
  const link = elements.find((visit) => visit.element.tag === 'link' && (visit.element.attrs['rel'] ?? '').toLowerCase() === 'canonical')?.element;
  if (link === undefined) {
    add(undefined, 'canonical', detailText('audits.detail.renderedNoCanonical'));
    return;
  }
  const href = link.attrs['href'] ?? '';
  let path: string;
  try {
    path = new URL(href, 'http://canonical.invalid').pathname;
  } catch {
    add(link, 'canonical', detailText('audits.detail.canonicalNotURL', { href }));
    return;
  }
  const trim = (value: string): string => (value.length > 1 ? value.replace(/\/$/, '') : value);
  if (!page.route.includes('[') && trim(path) !== trim(page.route)) {
    add(link, 'canonical', detailText('audits.detail.canonicalPointsAt', { path, route: page.route }));
  }
}

function checkOutline(elements: readonly Visit[], add: Add): void {
  const headings = elements.flatMap((visit) => {
    const match = /^h([1-6])$/.exec(visit.element.tag);
    return match === null ? [] : [{ element: visit.element, level: Number.parseInt(match[1] ?? '1', 10) }];
  });
  const ones = headings.filter((heading) => heading.level === 1);
  if (ones.length === 0) {
    add(undefined, 'h1-count', detailText('audits.detail.renderedNoH1', { h1: AUDIT_TAGS.h1 }));
  } else if (ones.length > 1) {
    add(ones[1]?.element, 'h1-count', detailText('audits.detail.renderedH1Count', { total: ones.length, h1: AUDIT_TAGS.h1 }));
  }
  let previous: number | undefined;
  for (const heading of headings) {
    if (previous !== undefined && heading.level > previous + 1) {
      add(heading.element, 'heading-order', `h${previous} → h${heading.level}`);
    }
    previous = heading.level;
  }
}

function checkNames(elements: readonly Visit[], add: Add): void {
  for (const { element } of elements) {
    if (element.tag !== 'a' && element.tag !== 'button') {
      continue;
    }
    if (element.tag === 'a' && element.attrs['href'] === undefined) {
      continue;
    }
    const name = renderedName(element);
    if (name.length === 0) {
      add(element, element.tag === 'a' ? 'link-name' : 'button-name', element.tag === 'a' ? `href="${element.attrs['href'] ?? ''}"` : '<button>');
    } else if (
      element.tag === 'a' &&
      VAGUE_LINK_TEXT.has(
        name
          .toLowerCase()
          .replace(/[^\p{L}\p{N} ]/gu, '')
          .trim(),
      )
    ) {
      add(element, 'link-text', `"${name}"`);
    }
  }
}

// The accessible name after slots: label attributes, then text, image alts and svg titles.
function renderedName(element: RenderedElement): string {
  for (const name of ['aria-label', 'title']) {
    const value = element.attrs[name]?.trim() ?? '';
    if (value.length > 0) {
      return value;
    }
  }
  if ((element.attrs['aria-labelledby'] ?? '').trim().length > 0) {
    return 'labelled';
  }
  const parts: string[] = [];
  const pending: RenderedNode[] = [...element.children];
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < AUDIT_LIMITS.elementsPerFileMax, 'renderedName: a name read is bounded');
    const node = pending.pop();
    assert(node !== undefined, 'renderedName: the stack holds a node');
    if (node.kind === 'text') {
      parts.push(node.value);
    } else if (node.attrs['aria-hidden'] !== 'true') {
      const label = node.attrs['aria-label'] ?? (node.tag === 'img' ? node.attrs['alt'] : undefined);
      if (label !== undefined) {
        parts.push(` ${label} `);
      } else {
        pending.push(...node.children);
      }
    }
  }
  return parts.join('').replace(/\s+/g, ' ').trim();
}

function checkIds(elements: readonly Visit[], add: Add): void {
  const seen = new Map<string, number>();
  for (const { element } of elements) {
    const id = element.attrs['id'];
    if (id === undefined || id.length === 0) {
      continue;
    }
    const count = (seen.get(id) ?? 0) + 1;
    seen.set(id, count);
    if (count === 2) {
      add(element, 'duplicate-id', detailText('audits.detail.idRepeatsOnPage', { id }));
    }
  }
}

function checkContrast(elements: readonly Visit[], add: Add): void {
  for (const { element } of elements) {
    const style = element.style;
    if (style === undefined || style.background === 'unknown') {
      continue;
    }
    const ownText = element.children.some((child) => child.kind === 'text' && child.value.trim().length > 0);
    if (!ownText) {
      continue;
    }
    const verdict = contrastVerdict({ foreground: style.color, background: style.background, fontSizePx: style.fontSizePx, fontWeight: style.fontWeight });
    if (verdict.tag === 'fail') {
      add(
        element,
        'contrast',
        detailText('audits.detail.contrastRatio', {
          ratio: verdict.ratio.toFixed(2),
          required: verdict.required,
          color: style.color,
          background: style.background,
        }),
      );
    }
  }
}

// The og:image (or twitter:image) the page names.
function socialImageOf(elements: readonly Visit[]): { readonly url: string; readonly element: RenderedElement } | undefined {
  for (const key of ['og:image', 'twitter:image']) {
    const found = elements.find(
      (visit) => visit.element.tag === 'meta' && (visit.element.attrs['property'] ?? visit.element.attrs['name'] ?? '').toLowerCase() === key,
    );
    const url = found?.element.attrs['content']?.trim();
    if (found !== undefined && url !== undefined && url.length > 0) {
      return { url, element: found.element };
    }
  }
  return undefined;
}

// Placeholder copy as the page renders it: what a constant, a prop default or a loop put there
// as well as what is written inline. A text with its own marker is located at the node that
// holds it in its file (the element, or the instance whose slot it fills); one without is
// located at its element, which the runner traces back to the prop or constant behind it.
function checkPlaceholders(page: RenderedPage, elements: readonly Visit[], phrases: readonly string[], push: (finding: AuditFinding) => void): void {
  assert(phrases.length <= AUDIT_LIMITS.findingsPerFileMax * 4, 'checkPlaceholders: the phrases are bounded');
  if (phrases.length === 0) {
    return;
  }
  for (const { element } of elements) {
    if (PLACEHOLDER_SKIPPED_TAGS.has(element.tag)) {
      continue;
    }
    for (const text of ownTexts(element)) {
      if (placeholderPhrase(text.value, phrases) === undefined) {
        continue;
      }
      const holder = text.source === undefined ? undefined : textHolder(text.source);
      const finding = renderedFinding(page, element, 'placeholder-text', placeholderDetail(text.value), {});
      push(holder === undefined ? finding : relocatedTo(finding, page, holder));
    }
    const source = element.tag === 'img' ? (element.attrs['src'] ?? '') : '';
    if (source.length > 0 && placeholderImage(source)) {
      push(renderedFinding(page, element, 'placeholder-image', `src="${source}"`, {}));
    }
  }
}

/** Elements whose text is code, metadata or a template, never copy. */
const PLACEHOLDER_SKIPPED_TAGS: ReadonlySet<string> = new Set([
  'head',
  'title',
  'script',
  'style',
  'noscript',
  'template',
  'code',
  'pre',
  'textarea',
  'option',
]);

// An element's own text runs: each run of adjacent text nodes, with the marker of its first node.
function ownTexts(element: RenderedElement): readonly { readonly value: string; readonly source: RenderedSource | undefined }[] {
  const runs: { value: string; source: RenderedSource | undefined }[] = [];
  let open: { value: string; source: RenderedSource | undefined } | undefined;
  for (const child of element.children) {
    if (child.kind === 'element') {
      open = undefined;
      continue;
    }
    if (open === undefined) {
      open = { value: '', source: child.source };
      runs.push(open);
    }
    open.value += child.value;
  }
  assert(runs.length <= element.children.length, 'ownTexts: at most one run per child');
  return runs.map((run) => ({ value: run.value.replace(/\s+/g, ' ').trim(), source: run.source })).filter((run) => run.value.length > 0);
}

/** The node holding a marked text: the text's parent in its file, the element or the instance whose slot it fills. */
function textHolder(source: RenderedSource): RenderedSource | undefined {
  assert(source.path.length > 0, 'textHolder: a marker names a node');
  return source.path.length > 1 ? { file: source.file, path: source.path.slice(0, -1) } : undefined;
}

function relocatedTo(finding: AuditFinding, page: RenderedPage, holder: RenderedSource): AuditFinding {
  assert(holder.path.length > 0, 'relocatedTo: the holder is a node');
  const fileKind: AuditFileKind = holder.file === page.file ? 'page' : holder.file.includes('/layouts/') ? 'layout' : 'component';
  return auditFinding({
    check: finding.check,
    file: holder.file,
    fileKind,
    element: { path: holder.path, tag: finding.element?.tag ?? 'text', line: undefined },
    detail: finding.detail,
    ...(finding.detailRef === undefined ? {} : { detailRef: finding.detailRef }),
    source: 'rendered',
    fix: undefined,
    ...(holder.file === page.file ? {} : { routes: [page.route] }),
  });
}
