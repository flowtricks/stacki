// The audit's static checks: what one file's parse shows, before anything
// renders. One preorder walk visits every element with what the walk knows
// about its place (inside a <label>, inside a loop, inside <head>), and each
// element is checked against the rules that apply to its tag. Facts the file
// cannot hold — the routes that exist, an image file's pixel size, the site's
// constants — come in as `AuditFacts`, gathered before the walk, so the checks
// stay pure and every finding is a function of the file and the facts.
//
// A static check flags only what the source states. An attribute written as
// an expression or reachable through a spread, and content that is a
// component, an expression or a <slot>, are left to the rendered pass.
import { assert } from '../core/assert';
import {
  AUDIT_LIMITS,
  DESCRIPTION_CHARS_MAX,
  DESCRIPTION_CHARS_MIN,
  auditFinding,
  descriptionLengthCheck,
  type AuditCssContext,
  type AuditEdit,
  type AuditFileKind,
  type AuditFinding,
  type AuditFix,
  type AuditNewElement,
} from './auditFindings';
import {
  accessibleName,
  attrState,
  classTokens,
  filled,
  lineOf,
  lineStarts,
  nodeChildren,
  nodeProps,
  openingTag,
  patchedAttributes,
  writtenName,
  type AttrState,
} from './auditMarkup';
import type { Attr, ImportDecl, PageNode } from './pageNodeTypes';
import { textValue } from './htmlText';
import { lintCss, tokenGroup, variablesFor, type TokenIssue, type TokenRules } from './auditTokens';

/** One file as the audit reads it. */
export interface AuditFileInput {
  /** Project-relative, `/`-separated. */
  readonly file: string;
  readonly kind: Exclude<AuditFileKind, 'site'>;
  readonly nodes: readonly PageNode[];
  readonly imports: readonly ImportDecl[];
  /** The frontmatter's code, for the props a layout destructures. */
  readonly frontmatter: string;
  /** The text the parse's offsets index, for line numbers; undefined when none. */
  readonly source: string | undefined;
  /** The page's route, for a page; the noindex check reads it. */
  readonly route: string | undefined;
}

/** What the project holds beyond one file, read before the walk. */
export interface AuditFacts {
  /** Route patterns of the project's pages: `/`, `/blog/[slug]`, `/docs/[...path]`. */
  readonly routes: readonly string[];
  /** Files under public/, by the URL path they serve at (`/images/hero.png`), and their size in bytes. */
  readonly publicFiles: ReadonlyMap<string, number>;
  /** Pixel sizes of the public images the walk will ask about, by URL path. */
  readonly imageSizes: ReadonlyMap<string, { readonly width: number; readonly height: number }>;
  /** Site constants a fix may write: values, and the names they are exported under. */
  readonly site: SiteConstants;
  /** Routes the project marks noindex on purpose (a NOINDEX_ROUTES-style export). */
  readonly noindexRoutes: readonly string[];
  /** The design-token rules (`.stacki/audits.json`). */
  readonly tokens: TokenRules;
  /** The project's CSS variables, by name, with their values: what "Use variable" offers. */
  readonly variables: ReadonlyMap<string, string>;
  /** Phrases that mark copy as placeholder. */
  readonly placeholders: readonly string[];
}

export interface SiteConstants {
  readonly title: SiteConstant | undefined;
  readonly description: SiteConstant | undefined;
  readonly lang: string | undefined;
}

export interface SiteConstant {
  readonly name: string;
  readonly value: string;
  /** The module that exports it, as the project's own files import it (`../consts`). */
  readonly module: string;
}

/** What a file's walk learned that site checks need: whether it writes structured data, its head's state. */
export interface AuditFileSummary {
  readonly structuredData: boolean;
  readonly head: boolean;
}

export interface StaticAudit {
  readonly findings: readonly AuditFinding[];
  readonly summary: AuditFileSummary;
}

/** Bytes past which an image is "very large". */
export const IMAGE_BYTES_LARGE_MIN = 500 * 1024;
export { DESCRIPTION_CHARS_MAX, DESCRIPTION_CHARS_MIN } from './auditFindings';

/** Link text that says nothing out of context, compared lower-cased with punctuation dropped. */
export const VAGUE_LINK_TEXT: ReadonlySet<string> = new Set([
  'click here',
  'click',
  'here',
  'read more',
  'more',
  'learn more',
  'link',
  'this',
  'this link',
  'go',
  'details',
  'continue',
]);

/** WAI-ARIA 1.2 roles, the abstract ones excluded: authors may not use them. */
export const ARIA_ROLES: ReadonlySet<string> = new Set(
  (
    'alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary ' +
    'contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img ' +
    'insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation ' +
    'none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox ' +
    'separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer ' +
    'toolbar tooltip tree treegrid treeitem'
  ).split(' '),
);

const LABELLED_INPUT_TYPES_EXEMPT: ReadonlySet<string> = new Set(['hidden', 'submit', 'reset', 'button', 'image']);
const FOCUSABLE_TAGS: ReadonlySet<string> = new Set(['button', 'input', 'select', 'textarea', 'summary', 'iframe']);

/** One element as the walk reaches it, with what the walk knows of its place. */
interface Visit {
  readonly node: PageNode;
  readonly path: readonly number[];
  readonly insideLabel: boolean;
  readonly insideLoop: boolean;
  readonly insideHead: boolean;
  /** Inside <noscript>, <template> or <svg>: a <style> there is not the page's stylesheet. */
  readonly insideInert: boolean;
}

/** Everything one file's checks share: the input, the facts, and where findings collect. */
interface FileRun {
  readonly input: AuditFileInput;
  readonly facts: AuditFacts;
  readonly lines: readonly number[] | undefined;
  readonly findings: AuditFinding[];
  /** `<label for>` targets, for the control-label check. */
  readonly labelled: ReadonlySet<string>;
  /** Ids other attributes point at, so renaming a duplicate would break nothing. */
  readonly referenced: ReadonlySet<string>;
  readonly idsSeen: Map<string, number>;
  readonly idsTaken: Set<string>;
  /** Heading levels in document order. */
  readonly levels: number[];
  /** What the walk noted for the site checks. */
  readonly notes: Set<'head' | 'structured-data'>;
}

/** Every static finding in one file. */
export function auditFile(input: AuditFileInput, facts: AuditFacts): StaticAudit {
  assert(input.file.length > 0, 'auditFile: a file has a path');
  assert(!input.file.startsWith('/'), 'auditFile: the path is project-relative');
  const visits = walk(input.nodes);
  const run: FileRun = {
    input,
    facts,
    lines: input.source === undefined ? undefined : lineStarts(input.source),
    findings: [],
    labelled: labelTargets(visits),
    referenced: referencedIds(visits),
    idsSeen: new Map(),
    idsTaken: new Set(stringIds(visits)),
    levels: [],
    notes: new Set(),
  };
  for (const visit of visits) {
    if (run.findings.length >= AUDIT_LIMITS.findingsPerFileMax) {
      break;
    }
    checkElement(run, visit);
  }
  assert(run.findings.length <= AUDIT_LIMITS.findingsPerFileMax + 8, 'auditFile: one file’s findings are bounded');
  return { findings: run.findings, summary: { structuredData: run.notes.has('structured-data'), head: run.notes.has('head') } };
}

// Preorder over the tree, each element with its place. Bounded by the tree's own bound.
function walk(nodes: readonly PageNode[]): readonly Visit[] {
  const visits: Visit[] = [];
  const pending: Visit[] = nodes
    .map((node, index) => ({ node, path: [index], insideLabel: false, insideLoop: false, insideHead: false, insideInert: false }))
    .reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < AUDIT_LIMITS.elementsPerFileMax, 'walk: a file stays inside the tree bound');
    const visit = pending.pop();
    assert(visit !== undefined, 'walk: the stack holds a visit');
    const node = visit.node;
    if (node.kind === 'element' || node.kind === 'component' || node.kind === 'raw') {
      visits.push(visit);
    }
    const name = node.kind === 'element' ? node.name.toLowerCase() : '';
    const children = nodeChildren(node).map((child, index): Visit => ({
      node: child,
      path: [...visit.path, index],
      insideLabel: visit.insideLabel || name === 'label',
      insideLoop: visit.insideLoop || node.kind === 'map',
      insideHead: visit.insideHead || name === 'head',
      insideInert: visit.insideInert || INERT_STYLE_PARENTS.has(name),
    }));
    pending.push(...children.reverse());
  }
  return visits;
}

function elementName(node: PageNode): string | undefined {
  return node.kind === 'element' || node.kind === 'raw' ? node.name.toLowerCase() : undefined;
}

function labelTargets(visits: readonly Visit[]): ReadonlySet<string> {
  const targets = new Set<string>();
  for (const visit of visits) {
    if (elementName(visit.node) === 'label') {
      for (const name of ['for', 'htmlfor']) {
        const state = attrState(nodeProps(visit.node), name);
        if (state.tag === 'value') {
          targets.add(state.value.trim());
        }
      }
    }
  }
  return targets;
}

// Ids named by references in the same file: `for`, the ARIA id lists, `#fragment` links.
function referencedIds(visits: readonly Visit[]): ReadonlySet<string> {
  const ids = new Set<string>();
  const lists = [
    'for',
    'htmlfor',
    'aria-labelledby',
    'aria-describedby',
    'aria-controls',
    'aria-owns',
    'aria-activedescendant',
    'aria-details',
    'list',
    'form',
  ];
  for (const visit of visits) {
    const props = nodeProps(visit.node);
    for (const name of lists) {
      const state = attrState(props, name);
      if (state.tag === 'value') {
        state.value.split(/\s+/).forEach((id) => ids.add(id));
      }
    }
    const href = attrState(props, 'href');
    if (href.tag === 'value' && href.value.startsWith('#')) {
      ids.add(href.value.slice(1));
    }
  }
  return ids;
}

function stringIds(visits: readonly Visit[]): readonly string[] {
  return visits.flatMap((visit) => {
    const state = attrState(nodeProps(visit.node), 'id');
    return state.tag === 'value' && state.value.length > 0 ? [state.value] : [];
  });
}

// One element against the rules for its tag. The control flow lives here; the
// checks below each look at one concern and add what they find.
function checkElement(run: FileRun, visit: Visit): void {
  const node = visit.node;
  if (node.kind === 'component') {
    checkPlaceholderText(run, visit);
    checkPlaceholderProps(run, visit);
    checkComponent(run, visit);
    return;
  }
  const name = elementName(node);
  if (name === undefined) {
    return;
  }
  checkGlobalAttributes(run, visit);
  checkPlaceholderText(run, visit);
  checkPlaceholderProps(run, visit);
  switch (name) {
    case 'html':
      checkHtml(run, visit);
      return;
    case 'head':
      checkHead(run, visit);
      return;
    case 'img':
      checkImage(run, visit);
      return;
    case 'a':
      checkLink(run, visit);
      return;
    case 'button':
      checkButton(run, visit);
      return;
    case 'input':
    case 'select':
    case 'textarea':
      checkControl(run, visit, name);
      return;
    case 'video':
      checkVideo(run, visit);
      return;
    case 'iframe':
      checkFrame(run, visit);
      return;
    case 'script':
      noteScript(run, visit);
      return;
    case 'style':
      checkStyleBlock(run, visit);
      return;
    default:
      checkHeading(run, visit, name);
  }
}

function add(
  run: FileRun,
  visit: Visit,
  finding: {
    readonly check: AuditFinding['check'];
    readonly detail: string;
    readonly fix?: AuditFix | undefined;
    readonly excerpt?: string;
    readonly measure?: string;
    readonly choices?: readonly AuditFix[];
    readonly css?: AuditCssContext;
    readonly prop?: string;
  },
): void {
  const node = visit.node;
  const tag = node.kind === 'element' || node.kind === 'component' || node.kind === 'raw' ? node.name : node.kind;
  const start = 'start' in node ? node.start : undefined;
  const line = run.lines === undefined || start === undefined ? undefined : lineOf(run.lines, start);
  run.findings.push(
    auditFinding({
      check: finding.check,
      file: run.input.file,
      fileKind: run.input.kind,
      element: { path: visit.path, tag, line },
      detail: finding.detail,
      source: 'static',
      fix: finding.fix,
      ...(finding.excerpt === undefined ? {} : { excerpt: finding.excerpt }),
      ...(finding.measure === undefined ? {} : { measure: finding.measure }),
      ...(finding.choices === undefined ? {} : { choices: finding.choices }),
      ...(finding.css === undefined ? {} : { css: finding.css }),
      ...(finding.prop === undefined ? {} : { prop: finding.prop }),
    }),
  );
}

/** A fix that patches the visited element's attributes, with its before and after tags. */
function attributeFix(run: FileRun, visit: Visit, label: string, patch: Readonly<Record<string, Attr | undefined>>): AuditFix {
  const node = visit.node;
  assert(node.kind === 'element' || node.kind === 'component' || node.kind === 'raw', 'attributeFix: patches a tag');
  const props = nodeProps(node);
  const edits: readonly AuditEdit[] = [{ tag: 'attributes', path: visit.path, expect: node.name, patch }];
  return {
    label,
    before: openingTag(node.name, props),
    after: openingTag(node.name, patchedAttributes(props, patch)),
    file: run.input.file,
    edits,
  };
}

function stringValue(value: string): Attr {
  return { type: 'string', value };
}

// --- Attributes any element can carry ---------------------------------------------------

function checkGlobalAttributes(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  const style = attrState(props, 'style');
  if (style.tag === 'value' && style.value.trim().length > 0) {
    checkInlineStyle(run, visit, style.value);
  }
  checkId(run, visit, attrState(props, 'id'));
  const role = attrState(props, 'role');
  if (role.tag === 'value') {
    const first = role.value.trim().split(/\s+/)[0] ?? '';
    if (first.length > 0 && !ARIA_ROLES.has(first.toLowerCase())) {
      add(run, visit, { check: 'aria-role', detail: `role="${role.value}"` });
    }
  }
  const tabindex = attrState(props, 'tabindex');
  if (tabindex.tag === 'value') {
    const order = Number.parseInt(tabindex.value, 10);
    if (Number.isSafeInteger(order) && order > 0) {
      const focusable = nativelyFocusable(visit);
      // Natively focusable: drop it and the element keeps its place in the reading order;
      // otherwise 0 keeps it reachable, in reading order.
      const patch = { [writtenName(props, 'tabindex')]: focusable ? undefined : stringValue('0') };
      add(run, visit, {
        check: 'tabindex-positive',
        detail: `tabindex="${tabindex.value}"`,
        fix: attributeFix(run, visit, focusable ? 'Remove tabindex' : 'Set tabindex="0"', patch),
      });
    }
  }
  const hidden = attrState(props, 'aria-hidden');
  if (hidden.tag === 'value' && hidden.value === 'true' && focusableNow(visit)) {
    add(run, visit, { check: 'aria-hidden-focusable', detail: 'aria-hidden="true" on a focusable element' });
  }
}

function checkId(run: FileRun, visit: Visit, id: AttrState): void {
  if (id.tag !== 'value' || id.value.length === 0) {
    return;
  }
  const seen = (run.idsSeen.get(id.value) ?? 0) + 1;
  run.idsSeen.set(id.value, seen);
  if (visit.insideLoop) {
    // One written id, repeated once per item the loop renders.
    add(run, visit, { check: 'duplicate-id', detail: `id="${id.value}" repeats on every item of a loop` });
    return;
  }
  if (seen === 1) {
    return;
  }
  if (run.referenced.has(id.value)) {
    add(run, visit, { check: 'duplicate-id', detail: `id="${id.value}" (referenced, so renaming needs a choice)` });
    return;
  }
  const renamed = freeId(run, id.value, seen);
  const patch = { [writtenName(nodeProps(visit.node), 'id')]: stringValue(renamed) };
  add(run, visit, { check: 'duplicate-id', detail: `id="${id.value}"`, fix: attributeFix(run, visit, `Rename to "${renamed}"`, patch) });
}

// The first `<id>-<n>` no element of the file holds, from the occurrence's own number.
function freeId(run: FileRun, id: string, occurrence: number): string {
  assert(occurrence >= 2, 'freeId: only a repeat is renamed');
  for (let suffix = occurrence; suffix < occurrence + AUDIT_LIMITS.elementsPerFileMax; suffix++) {
    const candidate = `${id}-${suffix}`;
    if (!run.idsTaken.has(candidate)) {
      run.idsTaken.add(candidate);
      return candidate;
    }
  }
  assert(false, 'freeId: a file holds fewer ids than its element bound');
  return id;
}

function nativelyFocusable(visit: Visit): boolean {
  const name = elementName(visit.node) ?? '';
  if (FOCUSABLE_TAGS.has(name)) {
    return true;
  }
  return name === 'a' && attrState(nodeProps(visit.node), 'href').tag !== 'absent';
}

// Focusable as written: natively, or by a tabindex of zero or more.
function focusableNow(visit: Visit): boolean {
  const tabindex = attrState(nodeProps(visit.node), 'tabindex');
  if (tabindex.tag === 'value') {
    return Number.parseInt(tabindex.value, 10) >= 0;
  }
  return nativelyFocusable(visit);
}

// --- Document and head --------------------------------------------------------------------

function checkHtml(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  const lang = attrState(props, 'lang');
  if (lang.tag === 'dynamic' || (lang.tag === 'value' && lang.value.trim().length > 0)) {
    return;
  }
  const value = run.facts.site.lang ?? 'en';
  const patch = { [writtenName(props, 'lang')]: stringValue(value) };
  add(run, visit, {
    check: 'html-lang',
    detail: lang.tag === 'absent' ? '<html> has no lang' : 'lang is empty',
    fix: attributeFix(run, visit, `Add lang="${value}"`, patch),
  });
}

/** What a head holds, as far as the source says: each item present, absent, or decided by a component. */
interface HeadContents {
  readonly opaque: boolean;
  readonly title: PageNode | undefined;
  readonly description: PageNode | undefined;
  readonly canonical: boolean;
  readonly social: ReadonlySet<string>;
  readonly robots: PageNode | undefined;
}

function headContents(head: PageNode): HeadContents {
  let opaque = false;
  let title: PageNode | undefined;
  let description: PageNode | undefined;
  let canonical = false;
  let robots: PageNode | undefined;
  const social = new Set<string>();
  const pending = [...nodeChildren(head)];
  for (let visited = 0; pending.length > 0; visited++) {
    assert(visited < AUDIT_LIMITS.elementsPerFileMax, 'headContents: a head stays inside the tree bound');
    const node = pending.pop();
    assert(node !== undefined, 'headContents: the stack holds a node');
    if (node.kind === 'component' || node.kind === 'expr' || (node.kind === 'element' && node.name.toLowerCase() === 'slot')) {
      opaque = true; // A component, expression or slot may write any of these.
    }
    pending.push(...nodeChildren(node));
    const name = elementName(node);
    const props = nodeProps(node);
    if (name === 'title') {
      title = node;
    } else if (name === 'meta') {
      const key = metaKey(props);
      if (key === 'description') {
        description = node;
      } else if (key === 'robots') {
        robots = node;
      } else if (key !== undefined && /^(og|twitter):/.test(key)) {
        social.add(key);
      }
    } else if (name === 'link') {
      const rel = attrState(props, 'rel');
      canonical = canonical || (rel.tag === 'value' && rel.value.toLowerCase() === 'canonical') || rel.tag === 'dynamic';
    }
  }
  return { opaque, title, description, canonical, social, robots };
}

// A meta tag's key: its name, or its property for Open Graph.
function metaKey(props: Readonly<Record<string, Attr>> | undefined): string | undefined {
  for (const name of ['name', 'property']) {
    const state = attrState(props, name);
    if (state.tag === 'value') {
      return state.value.toLowerCase();
    }
  }
  return undefined;
}

function checkHead(run: FileRun, visit: Visit): void {
  run.notes.add('head');
  const head = headContents(visit.node);
  if (head.title === undefined) {
    if (!head.opaque) {
      add(run, visit, { check: 'title-missing', detail: '<head> has no <title>', fix: headInsertFix(run, visit, 'title') });
    }
  } else if (contentState(head.title) === 'blank') {
    add(run, visit, { check: 'title-missing', detail: '<title> is empty' });
  }
  checkDescription(run, visit, head);
  if (!head.canonical && !head.opaque) {
    add(run, visit, { check: 'canonical', detail: '<head> has no canonical link', fix: canonicalFix(run, visit) });
  }
  const missingSocial = ['og:title', 'og:description', 'og:image', 'twitter:card'].filter((key) => !head.social.has(key));
  if (missingSocial.length > 0 && !head.opaque) {
    add(run, visit, { check: 'social-tags', detail: `Missing ${missingSocial.join(', ')}` });
  }
  checkRobots(run, visit, head.robots);
}

function checkDescription(run: FileRun, visit: Visit, head: HeadContents): void {
  if (head.description === undefined) {
    if (!head.opaque) {
      add(run, visit, { check: 'description-missing', detail: '<head> has no meta description', fix: headInsertFix(run, visit, 'description') });
    }
    return;
  }
  const content = attrState(nodeProps(head.description), 'content');
  if (content.tag !== 'value') {
    return;
  }
  const length = content.value.trim().length;
  if (length === 0) {
    add(run, visit, { check: 'description-missing', detail: 'The meta description is empty' });
  } else {
    const check = descriptionLengthCheck(length);
    if (check !== undefined) {
      add(run, visit, {
        check,
        detail: `${length} characters (aim for ${DESCRIPTION_CHARS_MIN}–${DESCRIPTION_CHARS_MAX})`,
        excerpt: content.value.trim(),
        measure: `${length} characters`,
      });
    }
  }
}

function checkRobots(run: FileRun, visit: Visit, robots: PageNode | undefined): void {
  if (robots === undefined) {
    return;
  }
  const content = attrState(nodeProps(robots), 'content');
  if (content.tag !== 'value' || !/\bnoindex\b/i.test(content.value)) {
    return;
  }
  const route = run.input.route;
  if (route !== undefined && run.facts.noindexRoutes.includes(route)) {
    return; // The project lists this route as noindex on purpose.
  }
  add(run, visit, {
    check: 'noindex',
    detail: run.input.kind === 'page' ? `content="${content.value}"` : `content="${content.value}" hides every page using this layout`,
  });
}

function contentState(node: PageNode): 'blank' | 'filled' {
  const children = nodeChildren(node);
  const words = children.map((child) => (child.kind === 'text' ? textValue(child.value).trim() : child.kind === 'comment' ? '' : 'x')).join('');
  return words.length === 0 ? 'blank' : 'filled';
}

// `<title>` or the description meta, written from what the file or the site already
// states: a prop the layout destructures, then a site constant the file imports, then
// the constant's own value. Nothing is invented: with none of them there is no fix.
function headInsertFix(run: FileRun, visit: Visit, item: 'title' | 'description'): AuditFix | undefined {
  const value = headValue(run, item);
  if (value === undefined) {
    return undefined;
  }
  const element: AuditNewElement =
    item === 'title'
      ? { name: 'title', props: {}, content: value }
      : {
          name: 'meta',
          props: { name: stringValue('description'), content: value.kind === 'expr' ? { type: 'expr', value: value.value } : stringValue(value.value) },
          content: undefined,
        };
  const printed =
    item === 'title' ? `<title>${value.kind === 'expr' ? `{${value.value}}` : value.value}</title>` : openingTag('meta', element.props, { selfClosing: true });
  return {
    label: item === 'title' ? 'Add <title>' : 'Add meta description',
    before: '<head> … </head>',
    after: `<head> … ${printed} </head>`,
    file: run.input.file,
    edits: [{ tag: 'append-child', path: visit.path, expect: 'head', element }],
  };
}

function headValue(run: FileRun, item: 'title' | 'description'): { readonly kind: 'text' | 'expr'; readonly value: string } | undefined {
  if (destructuresProp(run.input.frontmatter, item)) {
    return { kind: 'expr', value: item };
  }
  const constant = item === 'title' ? run.facts.site.title : run.facts.site.description;
  if (constant === undefined) {
    return undefined;
  }
  const imported = run.input.imports.some((entry) => entry.name === constant.name && (entry.named === true || entry.imported === constant.name));
  return imported ? { kind: 'expr', value: constant.name } : { kind: 'text', value: constant.value };
}

/** Whether the frontmatter takes `name` out of Astro.props: `const { title, … } = Astro.props`. */
export function destructuresProp(frontmatter: string, name: string): boolean {
  assert(/^[A-Za-z_$][\w$]*$/.test(name), 'destructuresProp: asks for an identifier');
  const pattern = /(?:const|let)\s*\{([^}]*)\}\s*=\s*Astro\.props/g;
  for (const match of frontmatter.matchAll(pattern)) {
    const names = (match[1] ?? '').split(',').map((part) => (part.split(/[:=]/)[0] ?? '').trim());
    if (names.includes(name)) {
      return true;
    }
  }
  return false;
}

function canonicalFix(run: FileRun, visit: Visit): AuditFix {
  // The page's own address on the configured site, or on whatever origin serves it when no `site` is set.
  const href: Attr = { type: 'expr', value: 'new URL(Astro.url.pathname, Astro.site ?? Astro.url)' };
  const element: AuditNewElement = { name: 'link', props: { rel: stringValue('canonical'), href }, content: undefined };
  return {
    label: 'Add canonical link',
    before: '<head> … </head>',
    after: `<head> … ${openingTag('link', element.props, { selfClosing: true })} </head>`,
    file: run.input.file,
    edits: [{ tag: 'append-child', path: visit.path, expect: 'head', element }],
  };
}

function noteScript(run: FileRun, visit: Visit): void {
  const type = attrState(nodeProps(visit.node), 'type');
  if (type.tag === 'value' && type.value.toLowerCase() === 'application/ld+json') {
    run.notes.add('structured-data');
  }
}

// --- Images ---------------------------------------------------------------------------------

/** Whether the author marked an image decorative: a presentational role, aria-hidden, or a decorative flag or class. */
export function markedDecorative(props: Readonly<Record<string, Attr>> | undefined): boolean {
  const role = attrState(props, 'role');
  if (role.tag === 'value' && (role.value === 'presentation' || role.value === 'none')) {
    return true;
  }
  const hidden = attrState(props, 'aria-hidden');
  if (hidden.tag === 'value' && hidden.value === 'true') {
    return true;
  }
  if (attrState(props, 'data-decorative').tag === 'value') {
    return true;
  }
  return classTokens(props).some((token) => token === 'decorative' || token === 'is-decorative');
}

function checkImage(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  checkAlt(run, visit, props);
  checkPlaceholderImage(run, visit, attrState(props, 'src'));
  const imageSource = attrState(props, 'src');
  if (imageSource.tag !== 'value' || !localPath(imageSource.value)) {
    return;
  }
  const url = urlPath(imageSource.value);
  checkDimensions(run, visit, props, url);
  const bytes = run.facts.publicFiles.get(url);
  if (bytes !== undefined && bytes >= IMAGE_BYTES_LARGE_MIN) {
    add(run, visit, { check: 'img-large', detail: `${imageSource.value} is ${Math.round(bytes / 1024)} KB` });
  }
}

function checkAlt(run: FileRun, visit: Visit, props: Readonly<Record<string, Attr>> | undefined): void {
  const alt = attrState(props, 'alt');
  const decorative = markedDecorative(props);
  if (alt.tag === 'dynamic') {
    return;
  }
  if (alt.tag === 'absent') {
    if (!decorative) {
      add(run, visit, { check: 'img-alt', detail: imageDetail(props) });
      return;
    }
    // Decorative by the author's own mark: empty alt, and a presentational role unless one is written.
    const patch: Record<string, Attr | undefined> = { alt: stringValue('') };
    if (attrState(props, 'role').tag === 'absent') {
      patch['role'] = stringValue('presentation');
    }
    add(run, visit, { check: 'img-alt', detail: `${imageDetail(props)} (marked decorative)`, fix: attributeFix(run, visit, 'Add alt=""', patch) });
    return;
  }
  if (decorative && alt.value.length > 0) {
    const patch = { [writtenName(props, 'alt')]: stringValue('') };
    add(run, visit, { check: 'img-decorative', detail: `alt="${alt.value}"`, fix: attributeFix(run, visit, 'Set alt=""', patch) });
  }
}

function imageDetail(props: Readonly<Record<string, Attr>> | undefined): string {
  const imageSource = attrState(props, 'src');
  return imageSource.tag === 'value' ? `src="${imageSource.value}"` : '<img>';
}

function checkDimensions(run: FileRun, visit: Visit, props: Readonly<Record<string, Attr>> | undefined, url: string): void {
  const width = attrState(props, 'width');
  const height = attrState(props, 'height');
  if (width.tag !== 'absent' && height.tag !== 'absent') {
    return;
  }
  if (width.tag === 'dynamic' || height.tag === 'dynamic') {
    return;
  }
  const size = run.facts.imageSizes.get(url);
  const fix = size === undefined ? undefined : dimensionFix(run, visit, { width, height }, size);
  add(run, visit, { check: 'img-dimensions', detail: `src="${url}"`, fix });
}

// Both from the file when neither is written; the missing one from the file's aspect ratio when one is.
function dimensionFix(
  run: FileRun,
  visit: Visit,
  written: { readonly width: AttrState; readonly height: AttrState },
  size: { readonly width: number; readonly height: number },
): AuditFix | undefined {
  assert(size.width > 0, 'dimensionFix: an image is at least a pixel wide');
  assert(size.height > 0, 'dimensionFix: an image is at least a pixel tall');
  if (written.width.tag === 'absent' && written.height.tag === 'absent') {
    const patch = { width: stringValue(String(size.width)), height: stringValue(String(size.height)) };
    return attributeFix(run, visit, `Add width="${size.width}" height="${size.height}"`, patch);
  }
  const known = written.width.tag === 'value' ? written.width.value : written.height.tag === 'value' ? written.height.value : '';
  const pixels = /^\d+$/.test(known.trim()) ? Number.parseInt(known, 10) : undefined;
  if (pixels === undefined || pixels === 0) {
    return undefined; // A percentage or a CSS length says nothing about the other side.
  }
  if (written.width.tag === 'value') {
    const height = Math.round((pixels * size.height) / size.width);
    return attributeFix(run, visit, `Add height="${height}"`, { height: stringValue(String(height)) });
  }
  const width = Math.round((pixels * size.width) / size.height);
  return attributeFix(run, visit, `Add width="${width}"`, { width: stringValue(String(width)) });
}

/** A same-site path the dev server serves from the project: `/images/a.png`, not `//cdn…` or `https:`. */
export function localPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//');
}

/** A URL's path, without its query or fragment, decoded. */
export function urlPath(value: string): string {
  const path = value.split(/[?#]/)[0] ?? value;
  try {
    return decodeURI(path);
  } catch {
    return path; // A malformed escape is compared as written.
  }
}

// --- Links and buttons ----------------------------------------------------------------------

function checkLink(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  const href = attrState(props, 'href');
  if (href.tag === 'absent') {
    return; // A placeholder anchor, not a link.
  }
  const name = accessibleName(visit.node);
  if (name.tag === 'unnamed') {
    add(run, visit, { check: name.icon ? 'svg-button-label' : 'link-name', detail: href.tag === 'value' ? `href="${href.value}"` : '<a>' });
  } else if (
    name.tag === 'named' &&
    VAGUE_LINK_TEXT.has(
      name.text
        .toLowerCase()
        .replace(/[^\p{L}\p{N} ]/gu, '')
        .trim(),
    )
  ) {
    add(run, visit, { check: 'link-text', detail: `"${name.text}"` });
  }
  if (href.tag !== 'value') {
    return;
  }
  checkInternalLink(run, visit, href.value);
  checkOpener(run, visit, props, href.value);
}

function checkInternalLink(run: FileRun, visit: Visit, href: string): void {
  if (!localPath(href) || run.facts.routes.length === 0) {
    return;
  }
  const path = urlPath(href);
  if (run.facts.publicFiles.has(path) || routeExists(path, run.facts.routes)) {
    return;
  }
  add(run, visit, { check: 'link-broken', detail: `href="${href}"` });
}

/** Whether `path` is served by one of `routes`, dynamic segments matching any value. */
export function routeExists(path: string, routes: readonly string[]): boolean {
  assert(path.startsWith('/'), 'routeExists: asks about an absolute path');
  const wanted = segments(path);
  return routes.some((route) => routeMatches(segments(route), wanted));
}

function segments(path: string): readonly string[] {
  return path
    .replace(/\/index(\.html)?$/, '/')
    .replace(/\.html$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

function routeMatches(route: readonly string[], wanted: readonly string[]): boolean {
  for (let index = 0; index < route.length; index++) {
    const segment = route[index] ?? '';
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      return true; // A rest parameter takes every remaining segment, or none.
    }
    const value = wanted[index];
    if (value === undefined) {
      return false;
    }
    if (!/\[[^\]]+\]/.test(segment) && segment !== value) {
      return false;
    }
  }
  return route.length === wanted.length;
}

function checkOpener(run: FileRun, visit: Visit, props: Readonly<Record<string, Attr>> | undefined, href: string): void {
  const target = attrState(props, 'target');
  if (target.tag !== 'value' || target.value !== '_blank' || !/^https?:\/\//i.test(href)) {
    return;
  }
  const rel = attrState(props, 'rel');
  if (rel.tag === 'dynamic') {
    return;
  }
  const tokens = rel.tag === 'value' ? rel.value.split(/\s+/).filter((token) => token.length > 0) : [];
  if (tokens.includes('noopener') || tokens.includes('noreferrer')) {
    return; // Either cuts window.opener.
  }
  const patch = { [writtenName(props, 'rel')]: stringValue([...tokens, 'noopener'].join(' ')) };
  add(run, visit, { check: 'link-noopener', detail: `href="${href}"`, fix: attributeFix(run, visit, 'Add rel="noopener"', patch) });
}

function checkButton(run: FileRun, visit: Visit): void {
  const name = accessibleName(visit.node);
  if (name.tag === 'unnamed') {
    add(run, visit, { check: name.icon ? 'svg-button-label' : 'button-name', detail: '<button>' });
  }
}

// --- Forms, media, headings -----------------------------------------------------------------

function checkControl(run: FileRun, visit: Visit, name: 'input' | 'select' | 'textarea'): void {
  const props = nodeProps(visit.node);
  if (name === 'input') {
    const type = attrState(props, 'type');
    if (type.tag === 'dynamic' || (type.tag === 'value' && LABELLED_INPUT_TYPES_EXEMPT.has(type.value.toLowerCase()))) {
      return;
    }
  }
  if (visit.insideLabel || filled(attrState(props, 'aria-label')) || filled(attrState(props, 'aria-labelledby')) || filled(attrState(props, 'title'))) {
    return;
  }
  const id = attrState(props, 'id');
  if (id.tag === 'dynamic' || (id.tag === 'value' && run.labelled.has(id.value))) {
    return;
  }
  const placeholder = attrState(props, 'placeholder');
  const detail = placeholder.tag === 'value' ? `<${name}> with only a placeholder ("${placeholder.value}")` : `<${name}>`;
  add(run, visit, { check: 'control-label', detail });
}

function checkVideo(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  const autoplay = attrState(props, 'autoplay');
  if (autoplay.tag !== 'value' || autoplay.value === 'false') {
    return;
  }
  const patch: Record<string, Attr> = {};
  if (attrState(props, 'muted').tag === 'absent') {
    patch['muted'] = { type: 'bare' };
  }
  if (attrState(props, 'controls').tag === 'absent') {
    patch['controls'] = { type: 'bare' };
  }
  const missing = Object.keys(patch);
  if (missing.length === 0) {
    return;
  }
  add(run, visit, {
    check: 'video-autoplay',
    detail: `Autoplays without ${missing.join(' or ')}`,
    fix: attributeFix(run, visit, `Add ${missing.join(' and ')}`, patch),
  });
}

function checkFrame(run: FileRun, visit: Visit): void {
  const props = nodeProps(visit.node);
  const title = attrState(props, 'title');
  if (title.tag === 'dynamic' || (title.tag === 'value' && title.value.trim().length > 0)) {
    return;
  }
  const imageSource = attrState(props, 'src');
  const host = imageSource.tag === 'value' ? frameHost(imageSource.value) : undefined;
  const fix =
    host === undefined
      ? undefined
      : attributeFix(run, visit, 'Add title from its source', { [writtenName(props, 'title')]: stringValue(`Embedded content from ${host}`) });
  add(run, visit, { check: 'iframe-title', detail: imageSource.tag === 'value' ? `src="${imageSource.value}"` : '<iframe>', fix });
}

/** The host an absolute frame source names, without `www.`; undefined for a relative or malformed one. */
export function frameHost(address: string): string | undefined {
  if (!/^https?:\/\//i.test(address)) {
    return undefined;
  }
  try {
    const host = new URL(address).hostname.replace(/^www\./, '');
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

function checkHeading(run: FileRun, visit: Visit, name: string): void {
  const match = /^h([1-6])$/.exec(name);
  if (match === null) {
    return;
  }
  const level = Number.parseInt(match[1] ?? '1', 10);
  assert(level >= 1, 'checkHeading: a heading level is at least 1');
  assert(level <= 6, 'checkHeading: a heading level is at most 6');
  const previous = run.levels.at(-1);
  run.levels.push(level);
  if (level === 1 && run.levels.filter((written) => written === 1).length === 2) {
    add(run, visit, { check: 'h1-count', detail: 'A second <h1> in this file' });
  }
  if (previous !== undefined && level > previous + 1) {
    add(run, visit, { check: 'heading-order', detail: `h${previous} → h${level}` });
  }
}

// --- Components --------------------------------------------------------------------------------

// Astro's <Image> and <Picture> take alt like <img>; Astro works out their size itself.
function checkComponent(run: FileRun, visit: Visit): void {
  const node = visit.node;
  assert(node.kind === 'component', 'checkComponent: asked of a component');
  const imported = run.input.imports.find((entry) => entry.name === node.name);
  if (imported?.path !== 'astro:assets' || (node.name !== 'Image' && node.name !== 'Picture')) {
    return;
  }
  const props = node.props;
  if (attrState(props, 'alt').tag === 'absent') {
    add(run, visit, { check: 'img-alt', detail: `<${node.name}> ${imageDetail(props)}` });
  }
}

// --- Design tokens and style blocks -------------------------------------------------------

/** Elements whose <style> children are not the file's stylesheet. */
const INERT_STYLE_PARENTS: ReadonlySet<string> = new Set(['noscript', 'template', 'svg']);

/** Placeholder image hosts, by host name. */
export const PLACEHOLDER_IMAGE_HOSTS: readonly string[] = [
  'placehold.co',
  'placeholder.com',
  'via.placeholder.com',
  'picsum.photos',
  'placekitten.com',
  'dummyimage.com',
  'fakeimg.pl',
  'loremflickr.com',
  'source.unsplash.com',
];

// A `<style>` in an .astro file: scoped (flagged, never rewritten: the person sets is:global
// themselves), global without a layer, and every raw value its rules hold.
function checkStyleBlock(run: FileRun, visit: Visit): void {
  const node = visit.node;
  if (node.kind !== 'raw' || !run.input.file.endsWith('.astro')) {
    return;
  }
  // is:inline is global too: Astro leaves it unscoped. Either is the project's own choice.
  const global = attrState(node.props, 'is:global').tag !== 'absent' || attrState(node.props, 'is:inline').tag !== 'absent';
  if (visit.insideInert) {
    // A <style> in <noscript>, <template> or an <svg> is that element's own, not a stylesheet to scope or layer.
  } else if (!global) {
    add(run, visit, { check: 'style-global', detail: '<style> without is:global or is:inline' });
  } else if (!/@layer\b/.test(node.inner) && node.inner.trim().length > 0) {
    add(run, visit, { check: 'style-layer', detail: '<style is:global> with no @layer' });
  }
  for (const issue of lintCss(node.inner, run.facts.tokens)) {
    const fixes = variablesFor(issue.token, run.facts.variables).map((name): AuditFix => ({
      label: `Use var(${name})`,
      before: `${issue.property}: ${issue.value};`,
      after: `${issue.property}: ${swapped(issue, name)};`,
      file: run.input.file,
      edits: [{ tag: 'raw-text', path: visit.path, expect: 'style', offset: issue.offset, before: issue.token, after: `var(${name})` }],
    }));
    addToken(run, visit, issue, fixes, innerLine(run, node, issue.offset));
  }
}

function checkInlineStyle(run: FileRun, visit: Visit, value: string): void {
  const node = visit.node;
  if (node.kind !== 'element' && node.kind !== 'component') {
    return;
  }
  const props = nodeProps(node);
  for (const issue of lintCss(`${value};`, run.facts.tokens)) {
    const fixes = variablesFor(issue.token, run.facts.variables).map((name): AuditFix => {
      const next = `${value.slice(0, issue.offset)}var(${name})${value.slice(issue.offset + issue.token.length)}`;
      return attributeFix(run, visit, `Use var(${name})`, { [writtenName(props, 'style')]: stringValue(next) });
    });
    addToken(run, visit, { ...issue, selector: 'style=""' }, fixes, undefined);
  }
}

function addToken(run: FileRun, visit: Visit, issue: TokenIssue, fixes: readonly AuditFix[], line: number | undefined): void {
  const [first, ...rest] = fixes;
  const css: AuditCssContext = { selector: issue.selector, property: issue.property, value: issue.value, token: issue.token, line, group: tokenGroup(issue) };
  add(run, visit, {
    check: issue.kind,
    detail: `${issue.selector} { ${issue.property}: ${issue.token} }`,
    fix: first,
    css,
    ...(rest.length === 0 ? {} : { choices: fixes }),
  });
}

// The file's line of an offset inside a raw node's text, found from where the node starts.
function innerLine(run: FileRun, node: PageNode, offset: number): number | undefined {
  const source = run.input.source;
  const start = 'start' in node ? node.start : undefined;
  if (source === undefined || run.lines === undefined || start === undefined || node.kind !== 'raw') {
    return undefined;
  }
  const inner = source.indexOf(node.inner, start);
  return inner === -1 ? undefined : lineOf(run.lines, inner + offset);
}

/** The declaration's value with its raw token swapped for the variable. */
export function swapped(issue: Pick<TokenIssue, 'value' | 'token'>, name: string): string {
  const at = issue.value.indexOf(issue.token);
  assert(at >= 0, 'swapped: the token is in its value');
  return `${issue.value.slice(0, at)}var(${name})${issue.value.slice(at + issue.token.length)}`;
}

// --- Placeholder content ----------------------------------------------------------------------

// The text an element or a component instance holds directly: its own copy, or the copy it
// passes a component's default slot. Text inside script, style and the head is not copy.
function checkPlaceholderText(run: FileRun, visit: Visit): void {
  const node = visit.node;
  if (node.kind !== 'element' && node.kind !== 'component') {
    return; // Raw tags (script, style) hold code.
  }
  if (visit.insideHead || visit.insideInert || NON_COPY_TAGS.has(node.name.toLowerCase())) {
    return;
  }
  const own = nodeChildren(node)
    .map((child) => (child.kind === 'text' ? textValue(child.value) : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (placeholderPhrase(own, run.facts.placeholders) !== undefined) {
    add(run, visit, { check: 'placeholder-text', detail: placeholderDetail(own) });
  }
}

// Copy written as a literal attribute or prop: an element's alt, title or aria-label, or any
// string prop on a component instance. A single-word phrase ("Heading") counts only on a prop
// whose name says it holds copy, so `variant="heading"` is not placeholder text; a phrase of
// several words counts on any prop. The `placeholder` attribute is meant to hold a placeholder.
function checkPlaceholderProps(run: FileRun, visit: Visit): void {
  const node = visit.node;
  if (node.kind !== 'element' && node.kind !== 'component') {
    return; // Raw tags (script, style) hold code.
  }
  if (visit.insideHead || visit.insideInert) {
    return;
  }
  for (const [key, value] of Object.entries(nodeProps(node) ?? {})) {
    const name = key.toLowerCase();
    if (value.type !== 'string' || NON_COPY_PROPS.has(name)) {
      continue;
    }
    const copyName = COPY_PROP_PATTERN.test(name);
    if (node.kind === 'element' && !ELEMENT_COPY_ATTRIBUTES.has(name)) {
      continue;
    }
    const phrase = placeholderPhrase(value.value, run.facts.placeholders);
    if (phrase === undefined) {
      continue;
    }
    if (copyName || phrase.trim().includes(' ')) {
      add(run, visit, { check: 'placeholder-text', detail: `${key}=${placeholderDetail(value.value.replace(/\s+/g, ' ').trim())}`, prop: key });
    }
  }
}

/** Tags whose text is code or metadata, never copy. */
const NON_COPY_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'title', 'code', 'pre', 'kbd', 'samp', 'textarea', 'option']);
/** Attributes and props that never hold copy, or hold a placeholder by design. */
const NON_COPY_PROPS: ReadonlySet<string> = new Set([
  'placeholder',
  'class',
  'classname',
  'class:list',
  'id',
  'style',
  'href',
  'src',
  'srcset',
  'slot',
  'name',
  'for',
  'type',
  'rel',
  'target',
  'role',
]);
/** The element attributes that hold copy a person reads or hears. */
const ELEMENT_COPY_ATTRIBUTES: ReadonlySet<string> = new Set(['alt', 'title', 'aria-label', 'aria-description', 'value']);
/** Prop names that hold copy, where a single-word placeholder counts. */
const COPY_PROP_PATTERN = /text|title|heading|label|description|content|eyebrow|caption|alt|copy|body|subtitle|tagline|summary|quote|name$/;

/** A placeholder finding's detail: the text, quoted and shortened. */
export function placeholderDetail(text: string): string {
  return `"${text.length > 60 ? `${text.slice(0, 59)}…` : text}"`;
}

/** The placeholder phrase `text` is, or contains: one word must be the whole text, several may be part of it, as whole words. */
export function placeholderPhrase(text: string, phrases: readonly string[]): string | undefined {
  const words = normalizedWords(text);
  if (words.length === 0) {
    return undefined;
  }
  return phrases.find((phrase) => {
    const wanted = normalizedWords(phrase);
    if (wanted.length === 0) {
      return false;
    }
    return wanted.includes(' ') ? ` ${words} `.includes(` ${wanted} `) : words === wanted;
  });
}

function normalizedWords(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function checkPlaceholderImage(run: FileRun, visit: Visit, imageSource: AttrState): void {
  if (imageSource.tag === 'value' && placeholderImage(imageSource.value)) {
    add(run, visit, { check: 'placeholder-image', detail: `src="${imageSource.value}"` });
  }
}

/** Whether an image address is a placeholder: a placeholder host, or "placeholder" in the file name. */
export function placeholderImage(address: string): boolean {
  const name = address.split(/[?#]/)[0]?.split('/').pop()?.toLowerCase() ?? '';
  if (name.includes('placeholder')) {
    return true;
  }
  try {
    const host = new URL(address, 'http://local.invalid').hostname.replace(/^www\./, '');
    return PLACEHOLDER_IMAGE_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`));
  } catch {
    return false;
  }
}
