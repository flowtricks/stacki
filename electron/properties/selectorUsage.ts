// The unused-selector analysis: given every stylesheet region, every other
// project text and a way to search installed packages, decide for each
// selector whether anything can still produce the names it requires.
//
// Where a selector can match decides which texts count:
// - A global selector (a stylesheet, `<style is:global>`, `is:inline`) can
//   match any element, so a mention anywhere protects it.
// - A scoped selector matches only elements its own component renders. Another
//   component's static `class="…"` cannot reach them, so those values are left
//   out — that is what finds `.title` dead in Card while Hero still uses its own
//   `.title`. Scripts, data, packages and the file itself still count. A
//   component that computes its classes or spreads attributes takes classes
//   from its callers, so for it every mention counts again.
//
// Then the project-wide facts that can break the proof (taintOf) turn a would-be
// `unused` into `unknown`, naming the file and the reason.
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { toDigest } from '../../shared/core/brand';
import { keepMatcher, type StyleKeepList } from '../../shared/properties/styleKeepList';
import {
  SELECTOR_USAGE_LIMITS,
  selectorEntryId,
  type SelectorEntry,
  type SelectorFileDigest,
  type SelectorNote,
  type SelectorReport,
  type SelectorVerdict,
} from '../../shared/properties/selectorUsage';
import {
  asksAbout,
  assembledPiece,
  emptyHits,
  interestIsEmpty,
  mentionInterest,
  mergeHits,
  remainingInterest,
  scanMentions,
  type MentionHits,
  type MentionInterest,
} from './selectorMentions';
import { cssFileRegion, readRegionRules, type AstroSheet, type RuleSelector, type StyleRegion } from './selectorSheets';

export interface ProjectText {
  readonly rel: string;
  readonly text: string;
}

/** What searching installed packages found, or why it could not finish. */
export type PackageScan =
  | { readonly kind: 'complete'; readonly hits: MentionHits }
  /** Answered from earlier searches only; `unanswered` is what no search has looked for yet. */
  | { readonly kind: 'pending'; readonly hits: MentionHits; readonly unanswered: MentionInterest }
  | { readonly kind: 'incomplete'; readonly reason: string };

export interface UsageInput {
  /** Plain stylesheet files, by project-relative path. */
  readonly stylesheets: readonly ProjectText[];
  readonly astro: readonly AstroSheet[];
  /** Every other project text: scripts, data, content, HTML. */
  readonly others: readonly ProjectText[];
  readonly keepList: StyleKeepList;
  /** Project files that could not be read; each makes the proof incomplete. */
  readonly unreadable: readonly SelectorNote[];
}

/** The report plus what a cleanup needs to edit: the rule positions behind each entry. */
export interface UsageAnalysis {
  readonly report: SelectorReport;
  readonly selectors: ReadonlyMap<string, RuleSelector>;
  /** The file text each analysed region came from. */
  readonly sources: ReadonlyMap<string, string>;
}

export async function analyzeSelectorUsage(input: UsageInput, scanPackages: (interest: MentionInterest) => Promise<PackageScan>): Promise<UsageAnalysis> {
  const notes: SelectorNote[] = [...input.unreadable];
  const sources = new Map<string, string>();
  const regions: StyleRegion[] = [];
  for (const sheet of input.stylesheets) {
    sources.set(sheet.rel, sheet.text);
    regions.push(cssFileRegion(sheet.rel, sheet.text));
  }
  const astroByRel = new Map<string, AstroSheet>();
  for (const sheet of input.astro) {
    astroByRel.set(sheet.rel, sheet);
    if (sheet.unreadable !== undefined) {
      notes.push({ rel: sheet.rel, message: `Its styles were not checked: ${sheet.unreadable}` });
    }
    regions.push(...sheet.regions);
  }
  const rules = readRules(regions, notes);
  const interest = mentionInterest(new Set(rules.flatMap((rule) => rule.names)));
  const scans = scanProject(input, interest);
  const packages = interestIsEmpty(remainingInterest(interest, scans.foreign))
    ? ({ kind: 'complete', hits: emptyHits() } as const)
    : await scanPackages(remainingInterest(interest, scans.foreign));
  const taint = taintOf(input, packages);
  const keep = keepMatcher(input.keepList);
  const entries: SelectorEntry[] = [];
  const selectors = new Map<string, RuleSelector>();
  // Merged once per scope, not once per selector: a site has thousands of
  // selectors and a handful of scopes.
  const hitsByScope = new Map<string, MentionHits>();
  for (const rule of rules) {
    const sheet = astroByRel.get(rule.region.rel);
    const scopeKey = rule.region.scope === 'global' || sheet?.dynamicClass === true ? '' : rule.region.rel;
    const hits = hitsByScope.get(scopeKey) ?? hitsFor(rule.region, sheet, scans, packages);
    hitsByScope.set(scopeKey, hits);
    const unanswered = packages.kind === 'pending' ? packages.unanswered : undefined;
    const verdict = verdictOf(rule, hits, taintFor(rule.region, sheet, taint), unanswered, keep);
    const id = selectorEntryId({ rel: rule.region.rel, block: rule.region.block, offset: rule.ruleStart, index: rule.index });
    assert(!selectors.has(id), 'analyzeSelectorUsage: entry ids are unique');
    selectors.set(id, rule);
    entries.push({
      id,
      rel: rule.region.rel,
      line: rule.line,
      selector: rule.text.slice(0, SELECTOR_USAGE_LIMITS.selectorCharsMax),
      scope: rule.region.scope,
      verdict,
    });
  }
  for (const sheet of input.astro) {
    if (sheet.regions.length > 0) {
      sources.set(sheet.rel, sheet.source);
    }
  }
  const files: SelectorFileDigest[] = [...sources].map(([rel, text]) => ({ rel, digest: digestOf(text) }));
  assert(entries.length === selectors.size, 'analyzeSelectorUsage: one entry per selector');
  return { report: { entries, notes: notes.slice(0, SELECTOR_USAGE_LIMITS.notesMax), files }, selectors, sources };
}

export function digestOf(text: string) {
  return toDigest(createHash('sha256').update(text).digest('hex'));
}

interface ProjectScans {
  /** Every mention in the project: what protects a global selector. */
  readonly all: MentionHits;
  /** Mentions that can reach another component's elements. */
  readonly foreign: MentionHits;
  /** Each component's mentions of its own names. */
  readonly own: ReadonlyMap<string, MentionHits>;
}

function scanProject(input: UsageInput, interest: MentionInterest): ProjectScans {
  const all = emptyHits();
  const foreign = emptyHits();
  const own = new Map<string, MentionHits>();
  for (const other of input.others) {
    scanMentions(other.text, interest, foreign);
  }
  mergeHits(all, foreign);
  for (const sheet of input.astro) {
    const hits = emptyHits();
    scanMentions(sheet.ownText, interest, hits);
    own.set(sheet.rel, hits);
    mergeHits(all, hits);
    scanMentions(sheet.foreignText, interest, foreign);
  }
  // Pair assertion: foreign texts are the own texts with values blanked, so
  // they can never mention more.
  assert(foreign.words.size <= all.words.size, 'scanProject: foreign mentions are a subset of all mentions');
  return { all, foreign, own };
}

function hitsFor(region: StyleRegion, sheet: AstroSheet | undefined, scans: ProjectScans, packages: PackageScan): MentionHits {
  const hits = emptyHits();
  if (region.scope === 'global') {
    mergeHits(hits, scans.all);
  } else {
    assert(sheet !== undefined, 'hitsFor: a scoped region belongs to an .astro file');
    if (sheet.dynamicClass) {
      mergeHits(hits, scans.all);
    } else {
      mergeHits(hits, scans.foreign);
      const own = scans.own.get(sheet.rel);
      assert(own !== undefined, 'hitsFor: every .astro file was scanned');
      mergeHits(hits, own);
    }
  }
  if (packages.kind !== 'incomplete') {
    mergeHits(hits, packages.hits);
  }
  return hits;
}

function verdictOf(
  rule: RuleSelector,
  hits: MentionHits,
  taint: string | undefined,
  unanswered: MentionInterest | undefined,
  keep: (name: string) => boolean,
): SelectorVerdict {
  if (rule.names.length === 0) {
    return { kind: 'untracked' };
  }
  const absent = rule.names.filter((name) => !hits.words.has(name));
  if (absent.length === 0) {
    return { kind: 'used' };
  }
  if (taint !== undefined) {
    return { kind: 'unknown', names: absent, reason: taint };
  }
  // A name a package search has not answered yet is neither dead nor alive.
  const waiting = unanswered === undefined ? [] : absent.filter((name) => asksAbout(unanswered, name));
  const dead = absent
    .filter((name) => !waiting.includes(name))
    .filter((name) => assembledPiece(name, hits) === undefined)
    .filter((name) => !keep(name));
  if (dead.length > 0) {
    // One dead required name proves the selector matches nothing.
    if (rule.fixed !== undefined) {
      return { kind: 'unknown', names: dead, reason: rule.fixed };
    }
    return { kind: 'unused', names: dead };
  }
  if (waiting.length > 0) {
    return { kind: 'checking', names: waiting };
  }
  const assembled = absent.map((name) => assembledPiece(name, hits)).find((piece) => piece !== undefined);
  if (assembled !== undefined) {
    return { kind: 'unknown', names: absent, reason: `Code builds class names from pieces (${assembled})` };
  }
  assert(absent.every(keep), 'verdictOf: an absent name that is not dead or assembled is kept');
  return { kind: 'kept', names: absent };
}

interface ProjectTaint {
  /** Breaks every proof: code the scan cannot see may add any class. */
  readonly everything: string | undefined;
  /** Breaks global proofs: HTML whose classes are not on disk. */
  readonly injected: string | undefined;
  /** Breaks proofs for components that compute classes: values that are not on disk. */
  readonly remote: string | undefined;
}

function taintFor(region: StyleRegion, sheet: AstroSheet | undefined, taint: ProjectTaint): string | undefined {
  if (taint.everything !== undefined) {
    return taint.everything;
  }
  if (region.scope === 'global') {
    return taint.injected ?? taint.remote;
  }
  if (sheet?.dynamicClass === true) {
    return taint.remote;
  }
  return undefined;
}

const INJECTION = /\bset:html\b|\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bcreateContextualFragment\b|\bDOMParser\b|\bdocument\.write\b/;
const REMOTE_DATA = /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bnew\s+EventSource\b|\bcreateClient\s*\(/;
// A class set from a value rather than a literal, in a script.
const SCRIPT_CLASS_SINK =
  /classList\s*\.\s*(?:add|toggle|replace)\s*\(\s*[^'"`\s)]|\bclassName\s*=(?!=)\s*[^'"`\s]|setAttribute\s*\(\s*['"]class['"]\s*,\s*[^'"`\s]/;
const REMOTE_SCRIPT = /<script\b[^>]*?\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)|\bimport\s*(?:\(\s*|[^'"`;]*?\bfrom\s*)["'`](https?:\/\/[^"'`]+)/gi;

// Only code that can run can insert HTML, load data or add classes: prose that
// mentions `innerHTML` and type declarations that mention `fetch` do neither.
// Astro serves HTML only from public/ (src/pages renders its own); an HTML file
// elsewhere — an old site export kept for reference — never runs. Every file
// still counts as a mention; this only decides which can weaken a proof.
const RUNNABLE = /\.(?:astro|[cm]?[jt]sx?|vue|svelte|mdx)$/i;

// The site is rendered by src/, served from public/ and configured by root
// files (astro.config.mjs). A worker/ or scripts/ folder beside it is deployed
// or run on its own and cannot put classes into the site's pages.
const SITE_PREFIXES = ['src/', 'public/', 'styles/'];

function runnable(text: ProjectText): boolean {
  if (!text.rel.includes('/')) {
    // A root file: configuration, which can load integrations.
  } else if (!SITE_PREFIXES.some((prefix) => text.rel.startsWith(prefix))) {
    return false;
  }
  if (/\.d\.[cm]?ts$/i.test(text.rel)) {
    return false;
  }
  if (/\.html?$/i.test(text.rel)) {
    return text.rel.startsWith('public/');
  }
  return RUNNABLE.test(text.rel);
}

function taintOf(input: UsageInput, packages: PackageScan): ProjectTaint {
  const texts: ProjectText[] = [...input.others.filter(runnable), ...input.astro.map((sheet) => ({ rel: sheet.rel, text: sheet.ownText }))];
  let everything: string | undefined;
  if (input.unreadable.length > 0) {
    const first = input.unreadable[0];
    assert(first !== undefined, 'taintOf: the list is not empty');
    everything = `${first.rel} could not be read`;
  }
  if (packages.kind === 'incomplete') {
    everything ??= packages.reason;
  }
  const remoteScript = firstRemoteScript(texts, input.keepList.trustedScripts);
  if (remoteScript !== undefined) {
    everything ??= `${remoteScript.rel} loads ${remoteScript.url}, which may add classes`;
  }
  const remote = firstMatch(texts, REMOTE_DATA) ?? firstRemoteLoader(texts);
  const sink = firstMatch(texts, SCRIPT_CLASS_SINK);
  if (remote !== undefined) {
    if (sink !== undefined) {
      everything ??= `${sink} sets classes from values, and ${remote} loads data from outside the project`;
    }
  }
  // Inserted HTML built from props and content in the project's own files has
  // its classes in those files, which are already read. Only HTML that can
  // come from outside the project hides classes.
  const injectedIn = remote === undefined ? undefined : firstMatch(texts, INJECTION);
  return {
    everything,
    injected: injectedIn === undefined ? undefined : `${injectedIn} inserts HTML, and ${remote} loads data from outside the project`,
    remote: remote === undefined ? undefined : `${remote} loads data from outside the project, and classes are computed`,
  };
}

// Content collections whose loader comes from a package (a Notion or Sanity
// loader, say) fill pages with data that is not in the project files. Astro's
// own loaders read files, which the check reads too.
const CONTENT_CONFIG = /(?:^|\/)content\.config\.[cm]?[jt]s$|^src\/content\/config\.[cm]?[jt]s$/;
const LOCAL_LOADERS = new Set(['astro/loaders', 'astro/zod', 'zod']);

function firstRemoteLoader(texts: readonly ProjectText[]): string | undefined {
  for (const text of texts) {
    if (!CONTENT_CONFIG.test(text.rel)) {
      continue;
    }
    for (const match of text.text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const specifier = match[1] ?? '';
      const bare = !specifier.startsWith('.') && !specifier.startsWith('/');
      if (bare && !specifier.startsWith('astro:') && !LOCAL_LOADERS.has(specifier)) {
        return text.rel;
      }
    }
  }
  return undefined;
}

function firstMatch(texts: readonly ProjectText[], pattern: RegExp): string | undefined {
  return texts.find((text) => pattern.test(text.text))?.rel;
}

function firstRemoteScript(texts: readonly ProjectText[], trusted: readonly string[]): { readonly rel: string; readonly url: string } | undefined {
  for (const text of texts) {
    REMOTE_SCRIPT.lastIndex = 0;
    for (let match = REMOTE_SCRIPT.exec(text.text); match !== null; match = REMOTE_SCRIPT.exec(text.text)) {
      const written = match[1] ?? match[2];
      assert(written !== undefined, 'firstRemoteScript: one alternative matched');
      const url = written.startsWith('//') ? `https:${written}` : written;
      if (!trusted.some((prefix) => url.startsWith(prefix))) {
        return { rel: text.rel, url };
      }
    }
  }
  return undefined;
}

function readRules(regions: readonly StyleRegion[], notes: SelectorNote[]): RuleSelector[] {
  const rules: RuleSelector[] = [];
  for (const region of regions) {
    const read = readRegionRules(region);
    if (read.kind === 'unreadable') {
      notes.push({ rel: region.rel, message: `Its styles were not checked: ${read.reason}` });
      continue;
    }
    if (rules.length + read.selectors.length > SELECTOR_USAGE_LIMITS.entriesMax) {
      notes.push({ rel: region.rel, message: 'Its styles were not checked: the project has too many selectors' });
      continue;
    }
    rules.push(...read.selectors);
  }
  return rules;
}
