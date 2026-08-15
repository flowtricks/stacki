// Project-backed replacement for the Webflow Designer integration.
//
// The panel above this module is unchanged from moden: it asks for "embeds"
// that contribute page-global CSS, for the selected element's identity, and
// for the element tree around it. Only the answers differ.
//
//   Webflow                          Astro project
//   ─────────────────────────────    ────────────────────────────────────────
//   HtmlEmbed containing <style>  →  a stylesheet in the project, or a
//                                    <style> block on the page / in a chunk
//   Designer element              →  a node in the page model
//   element.getStyles() classes   →  the node's class attribute
//   native (class) styles         →  none: here every style IS css text
//   Designer variables            →  CSS custom properties found in the css
//
// The EmbedSource/EmbedDoc shapes are kept exactly, so css.ts, cascade.ts,
// resolved.ts and every section component work untouched: an embed's code is
// just text with CSS regions in it, and a stylesheet is that with one region
// covering the whole file.

import { collectRules, renderEmbed, splitEmbed } from './css'
import postcss from 'postcss'
import { findNode, getHost, onHostChange, propText, walkNodes, type HostNode } from './host'
import type { StateKey } from './resolved'
import type {
  BreakpointId,
  ElementSnapshot,
  NativeModel,
  NativeStyle,
  ParsedRule,
  StyleRegion,
} from './types'
import type { MatchTarget, TreeView } from './selectors'
import { hasCanvas, queryCanvas } from '../../canvasQuery.js'
import type { NativeStyleOptions } from './native-styles'

type AnyEl = unknown

// ───────────────────────────── Identity helpers ─────────────────────────────

export function serializeElementId(id: unknown): string {
  if (id == null) return ''
  if (typeof id === 'string') return id
  const n = id as HostNode
  if (n && typeof n === 'object' && typeof n.id === 'string') return n.id
  try {
    return JSON.stringify(id)
  } catch {
    return String(id)
  }
}

// Kept from the Webflow build so a name typed in the class field compiles the
// same way it would there — lowercased, spaces to hyphens, digits prefixed.
export function webflowClassToCss(name: string): string {
  const compiled = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\-_\s]/g, '')
    .replace(/\s+/g, '-')
  return /^[0-9]/.test(compiled) ? `_${compiled}` : compiled
}

// The panel drives itself off two Designer events: which element is selected
// and which breakpoint is active. Both come from the app, so this exposes just
// those — enough for the panel to run, and nothing that implies a Designer is
// present (native styling still reports unavailable further down).
type Unsub = () => void

export function webflowApi() {
  return {
    getSelectedElement: async (): Promise<AnyEl | null> => nodeById(getHost().selectedId),
    subscribe: (event: string, cb: (value: unknown) => void): Unsub => {
      if (event === 'selectedelement') {
        let last = getHost().selectedId
        return onHostChange(() => {
          const now = getHost().selectedId
          if (now === last) return
          last = now
          cb(nodeById(now))
        })
      }
      if (event === 'mediaquery') {
        let last = getHost().device
        return onHostChange(() => {
          const now = getHost().device
          if (now === last) return
          last = now
          void getCurrentBreakpoint().then(cb)
        })
      }
      return () => {}
    },
  }
}

const nodeById = (id: string | null): HostNode | null =>
  id ? findNode(getHost().nodes, id) : null

// A node's classes. `class="a b"` is readable straight from the source, but
// `class:list={[…]}` / `class={expr}` are expressions with no class text at
// all — for those the only truth is what the page rendered. The preview reports
// that for the selected element, so merge it in: a static class inside a
// class:list shows up, and a computed one (`gap-${gap}`) shows the value THIS
// instance resolved to. Source order first, then anything only the DOM knows.
// The string literals in an expression-valued class attribute. `class:list={[
// "container", gap !== "8" && `gap-${gap}`, ...rest ]}` yields `container` — a
// literal is a class this element always has, so it can be shown straight away
// instead of waiting on the canvas. Template literals with a `${}` hole are
// skipped: only the rendered element knows what they became. Values that aren't
// class-shaped (selectors, URLs, sentences) are dropped.
const CLASS_RE = /^[A-Za-z_-][A-Za-z0-9_-]*$/
const literalClasses = (node: HostNode | null, name: string): string[] => {
  const prop = node?.props?.[name]
  if (!prop || prop.type !== 'expr') return []
  const out: string[] = []
  for (const [, quote, body] of String(prop.value ?? '').matchAll(/(['"`])([^'"`]*)\1/g)) {
    if (quote === '`' && body.includes('${')) continue
    for (const tok of body.split(/\s+/)) if (CLASS_RE.test(tok)) out.push(tok)
  }
  return out
}

const classTokens = (node: HostNode | null): string[] => {
  // A class can be named in more than one place (`class` plus `class:list`, or
  // twice within one list) — the element still carries it once.
  const authored = [
    ...new Set([
      ...propText(node, 'class').split(/\s+/).filter(Boolean),
      // `class:list={[…]}`, and `class={…}` when it's an expression.
      ...literalClasses(node, 'class:list'),
      ...literalClasses(node, 'class'),
    ]),
  ]
  const host = getHost()
  // Rendered classes describe the selected element only — attributing them to
  // any other node (an ancestor being matched, say) would be wrong.
  if (!node || node.id !== host.selectedId) return authored
  const out = [...authored]
  for (const cls of host.renderedClasses || []) {
    if (cls && !out.includes(cls)) out.push(cls)
  }
  return out
}

export async function buildSnapshot(el: AnyEl): Promise<ElementSnapshot> {
  const node = typeof el === 'string' ? nodeById(el) : (el as HostNode)
  const classes = classTokens(node)
  const attributes: Record<string, string> = {}
  for (const [k, v] of Object.entries(node?.props || {})) {
    if (v && v.type === 'string') attributes[k] = String(v.value ?? '')
    else if (v && v.type === 'bare') attributes[k] = ''
  }
  const id = propText(node, 'id')
  if (id) attributes.id = id
  if (classes.length) attributes.class = classes.join(' ')
  return {
    // A component instance renders markup we can't see from here, so it has
    // no tag of its own — selectors match it by class only.
    tag: node?.kind === 'element' ? String(node.name || '').toLowerCase() : null,
    webflowType: node?.kind === 'component' ? 'Component' : node?.kind || 'Element',
    id: id || null,
    classes,
    classList: classes,
    attributes,
  }
}

export async function resolveIdentityElement(selected: AnyEl): Promise<AnyEl> {
  return selected
}

// ───────────────────────────── Style sources ─────────────────────────────

export type EmbedSource = {
  key: string
  label: string
  classNames: string[]
  fromComponent: boolean
  componentName: string | null
  order: number
  element: AnyEl
  instance?: AnyEl
  /** Where the CSS lives — the panel writes back through this. `astro` is a
   *  component file whose `<style is:global>` blocks are edited in place. */
  origin:
    | { kind: 'file'; path: string }
    | { kind: 'node'; nodeId: string }
    | { kind: 'astro'; path: string }
}

export type EmbedDoc = {
  source: EmbedSource
  code: string
  segments: string[]
  regions: StyleRegion[]
}

export type EmbedScan = {
  parentByKey: Map<string, string>
  childrenByKey: Map<string, string[]>
  elementByKey: Map<string, AnyEl>
  embeds: EmbedSource[]
  inComponentContext: boolean
}

export type PageScan = {
  parentByKey: Map<string, string>
  childrenByKey: Map<string, string[]>
  elementByKey: Map<string, AnyEl>
  pageEmbeds: EmbedSource[]
  instances: AnyEl[]
  inComponentContext: boolean
}

export function dedupeByKey(sources: EmbedSource[]): EmbedSource[] {
  const seen = new Set<string>()
  return sources.filter((s) => {
    if (seen.has(s.key)) return false
    seen.add(s.key)
    return true
  })
}

// Webflow appended a suffix so two embeds couldn't scaffold the same class
// name. Sources here are files and nodes with distinct identities already.
export function embedSourceClassSuffix(): string {
  return ''
}

// Every source of CSS that reaches this page, in cascade order: stylesheets
// first (they're linked in <head>), then the page's own <style> blocks, which
// come later in the document and so win ties.
function styleSources(): EmbedSource[] {
  const host = getHost()
  const out: EmbedSource[] = []
  let order = 0

  for (const f of host.files) {
    out.push({
      key: `file:${f.path}`,
      label: f.rel,
      classNames: [],
      fromComponent: false,
      componentName: null,
      order: order++,
      element: f.path,
      origin: { kind: 'file', path: f.path },
    })
  }

  // Every OTHER component's `<style is:global>`. Those rules are unhashed, so
  // they style what the page renders no matter which file the selection came
  // from — without this, styling a component instance from a page shows an
  // empty panel even though the element is clearly styled on the canvas. The
  // open file is skipped: its own <style> blocks come from the model below,
  // and reading it twice would let the two copies write over each other.
  for (const f of host.astroFiles) {
    if (host.openFilePath && f.path === host.openFilePath) continue
    out.push({
      key: `astro:${f.path}`,
      label: f.name,
      classNames: [],
      fromComponent: true,
      componentName: f.name.replace(/\.astro$/i, ''),
      order: order++,
      element: f.path,
      origin: { kind: 'astro', path: f.path },
    })
  }

  walkNodes(host.nodes, (n) => {
    if (n.kind !== 'raw' || n.name !== 'style') return
    const isGlobal = !!n.props?.['is:global']
    out.push({
      key: `node:${n.id}`,
      label: isGlobal ? '<style is:global>' : '<style>',
      classNames: [],
      fromComponent: false,
      componentName: null,
      order: order++,
      element: n.id,
      origin: { kind: 'node', nodeId: n.id },
    })
  })

  return out
}

// Both scans return the same thing: this app has no page/component boundary
// to cross — opening a component swaps the model, and the sources are read
// from whatever is open.
export async function scanPage(): Promise<PageScan> {
  const { parentByKey, childrenByKey, elementByKey } = buildTreeMaps()
  return {
    parentByKey,
    childrenByKey,
    elementByKey,
    pageEmbeds: styleSources(),
    instances: [],
    inComponentContext: false,
  }
}

export async function scanAllComponents(
  onEmbeds?: (embeds: EmbedSource[]) => void | Promise<void>,
): Promise<EmbedSource[]> {
  const embeds = styleSources()
  if (onEmbeds) await onEmbeds(embeds)
  return embeds
}

export function scanHasElement(scan: EmbedScan, selected: AnyEl): boolean {
  return scan.elementByKey.has(serializeElementId(selected))
}

// Model kinds that render exactly one element (so CSS counts them as a child),
// and kinds whose element count can't be known without running the page.
// Everything else (text, comment, raw-line) renders no element at all.
const ELEMENT_KINDS = new Set(['element', 'component', 'raw'])
const OPAQUE_COUNT_KINDS = new Set(['map', 'expr', 'chunk-group', 'cond', 'branch'])

function buildTreeMaps() {
  const parentByKey = new Map<string, string>()
  const childrenByKey = new Map<string, string[]>()
  const elementByKey = new Map<string, AnyEl>()
  walkNodes(getHost().nodes, (n, parent) => {
    elementByKey.set(n.id, n)
    if (parent) {
      parentByKey.set(n.id, parent.id)
      const kids = childrenByKey.get(parent.id) || []
      kids.push(n.id)
      childrenByKey.set(parent.id, kids)
    }
  })
  return { parentByKey, childrenByKey, elementByKey }
}

// ───────────────────────────── Reading & writing ─────────────────────────────

// Both kinds are raw CSS: a stylesheet is a file of it, and a <style> node
// holds only its inner text — the app keeps the tag itself in the model. So
// each is one region spanning the whole text. (A Webflow embed was HTML with
// <style> blocks inside it, which is why the original had to split it.)
/** Is this `<style>` block global — i.e. does it style the page rather than
 *  only its own component? A block with no opening tag recorded (a stylesheet)
 *  is global by definition. */
function isGlobalRegion(region: StyleRegion): boolean {
  return region.openTag == null || /\bis:global\b/.test(region.openTag)
}

function docForSource(source: EmbedSource, code: string): EmbedDoc {
  // A component file is markup with <style> blocks in it — the shape the embed
  // model was built for. Only its global blocks are parsed; a scoped block is
  // left as untouched text, so renderEmbed writes it back verbatim and
  // rebuildRules (which skips region.root === null) never offers its rules for
  // an element in another component.
  if (source.origin.kind === 'astro') {
    const { segments, regions } = splitEmbed(code)
    for (const region of regions) {
      if (!isGlobalRegion(region)) continue
      try {
        region.root = postcss.parse(region.css)
      } catch (err) {
        region.parseError = String((err as Error)?.message || err)
      }
    }
    return { source, code, segments, regions }
  }
  const region: StyleRegion = { start: 0, end: code.length, css: code, root: null }
  try {
    region.root = postcss.parse(code)
  } catch (err) {
    region.parseError = String((err as Error)?.message || err)
  }
  return { source, code, segments: ['', ''], regions: [region] }
}

async function readSource(source: EmbedSource): Promise<string> {
  if (source.origin.kind === 'file' || source.origin.kind === 'astro') {
    const res = await window.avb.readStyleFile(source.origin.path)
    return res?.css ?? ''
  }
  const node = nodeById(source.origin.nodeId)
  return String(node?.inner ?? '')
}

/** The text this doc's source file should now hold. A stylesheet or a <style>
 *  node is all CSS; a component file is its markup with only the edited
 *  regions re-stringified. */
function serializeDoc(doc: EmbedDoc): string {
  if (doc.source.origin.kind === 'astro') return renderEmbed(doc.segments, doc.regions)
  return doc.regions[0]?.root?.toString() ?? doc.regions[0]?.css ?? ''
}

/**
 * Read each source's code and parse it into live regions. The reads run
 * concurrently — each is an IPC round trip to the main process, and waiting
 * for one before starting the next made the scan linear in the number of
 * stylesheets and global-style components the project has. `onDoc` fires as
 * each lands so callers can stream; the returned arrays stay in source order,
 * which is cascade order.
 */
export async function loadEmbedDocs(
  sources: EmbedSource[],
  onDoc?: (doc: EmbedDoc) => void,
): Promise<{ docs: EmbedDoc[]; errors: Array<{ label: string; error: string }> }> {
  const loaded = await Promise.all(
    sources.map(async (source) => {
      try {
        const doc = docForSource(source, await readSource(source))
        onDoc?.(doc)
        return { doc, error: null }
      } catch (err) {
        return { doc: null, error: { label: source.label, error: String((err as Error)?.message || err) } }
      }
    }),
  )
  const docs: EmbedDoc[] = []
  const errors: Array<{ label: string; error: string }> = []
  for (const entry of loaded) {
    if (entry.doc) docs.push(entry.doc)
    if (entry.error) errors.push(entry.error)
  }
  return { docs, errors }
}

export async function writeEmbedDoc(
  doc: EmbedDoc,
  /** A live (scrubbing / mid-typing) write — for a <style> node it coalesces with the
   *  ones around it instead of saving the page per tick. A committed edit saves at once,
   *  so the canvas doesn't wait out a typing debounce for a single click. */
  live = false,
): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const code = serializeDoc(doc)
  // What the file held before this write — the undo target, captured before
  // doc.code is advanced below.
  const before = doc.code
  try {
    if (doc.source.origin.kind === 'file' || doc.source.origin.kind === 'astro') {
      const { path } = doc.source.origin
      await window.avb.writeStyleFile({ filePath: path, css: code })
      // A <style> node's write goes through the page model, which the app
      // already snapshots — only stylesheets need their own history entry.
      if (before !== code) {
        getHost().recordUndo?.({
          label: `styles in ${doc.source.label}`,
          // One step per file per burst: a slider drag writes on every tick.
          coalesceKey: `css:${path}`,
          undo: () => writeStyleFileAndReload(doc, path, before),
          redo: () => writeStyleFileAndReload(doc, path, code),
        })
      }
    } else {
      const write = getHost().writeStyleNode
      if (!write) return { ok: false, error: 'No page open to write into.' }
      // A <style> block belonging to the page, while a component is open: there
      // is no such node in the model being edited. The write used to find
      // nothing and quietly do nothing, leaving the panel to report a save the
      // canvas would never show.
      if (write(doc.source.origin.nodeId, code, !live) === false) {
        return { ok: false, error: "Couldn't find that <style> block in the open file." }
      }
    }
    doc.code = code
    return { ok: true, code }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err) }
  }
}

// Undo/redo rewrites a stylesheet behind the panel's back, so the doc it will
// write from next has to be brought back in step — otherwise the next edit
// would serialize the stale AST and quietly resurrect what was just undone.
const docsReloaded = new Set<() => void>()
export function onDocsReloaded(fn: () => void): () => void {
  docsReloaded.add(fn)
  return () => { docsReloaded.delete(fn) }
}

async function writeStyleFileAndReload(doc: EmbedDoc, path: string, text: string): Promise<void> {
  await window.avb.writeStyleFile({ filePath: path, css: text })
  // Re-derive the doc from what the file now holds, the same way it was first
  // read — for a component file that means re-splitting its markup, not
  // treating the whole file as one region of CSS.
  const fresh = docForSource(doc.source, text)
  doc.segments = fresh.segments
  doc.regions = fresh.regions
  doc.code = text
  for (const fn of docsReloaded) fn()
}

export function rebuildRules(docs: EmbedDoc[]): ParsedRule[] {
  const rules: ParsedRule[] = []
  // One running counter across every source, so document order — and with it
  // the cascade — is comparable between a stylesheet and a <style> block.
  const order = { n: 0 }
  const ordered = [...docs].sort((a, b) => a.source.order - b.source.order)

  for (const doc of ordered) {
    doc.regions.forEach((region, regionIndex) => {
      if (!region.root) return
      rules.push(
        ...collectRules(region, {
          embedKey: doc.source.key,
          embedLabel: doc.source.label,
          fromComponent: doc.source.fromComponent,
          componentName: doc.source.componentName,
          regionIndex,
          idSeed: doc.source.key,
          order,
        }),
      )
    })
  }
  return rules
}


// Selecting the <style> node a rule lives in; a stylesheet isn't in the tree,
// so there is nothing to navigate to.
export async function navigateToEmbed(
  source: EmbedSource,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (source.origin.kind === 'astro') {
    return { ok: false, error: `These styles live in ${source.label} — open that component to see them in the tree.` }
  }
  if (source.origin.kind !== 'node') {
    return { ok: false, error: `${source.label} is a stylesheet — open it from the Assets panel.` }
  }
  const select = getHost().selectNode
  if (!select) return { ok: false, error: 'Nothing to select.' }
  select(source.origin.nodeId)
  return { ok: true }
}

// ───────────────────────── Asking the rendered page ─────────────────────────

// State pseudo-classes describe a moment, not an element: `.card:hover` only
// matches while the pointer is there, but the panel is asking "does this rule
// target this element", which it does whether or not it's hovered right now.
// Stripped before asking, and the answer stored under the original text.
// Longest name first, and `(?![\w-])` rather than `\b` to close the trap that
// `-` is a non-word character: `:focus\b` happily matches inside
// `:focus-visible`, leaving the nonsense selector `a-visible`.
const STATE_PSEUDO_RE =
  /:(?:focus-visible|focus-within|focus|hover|active|visited|target|checked|indeterminate|default|disabled|enabled|placeholder-shown|autofill|user-invalid|user-valid|read-only|read-write|open)(?![\w-])/g
const PSEUDO_ELEMENT_RE =
  /::?(?:before|after|first-line|first-letter|selection|placeholder|marker|backdrop|file-selector-button)(?![\w-])|::(?:part|slotted)\([^)]*\)/g

function askableForm(text: string): string | null {
  const bare = text.replace(PSEUDO_ELEMENT_RE, '').replace(STATE_PSEUDO_RE, '').trim()
  // What's left has to still be a selector: `:hover {}` on its own strips to
  // nothing, and `.a > :hover` to a dangling combinator.
  if (!bare || /[>+~]\s*$/.test(bare) || bare.startsWith('>')) return null
  return bare
}

/** The selectors worth asking the DOM about, mapped back to the rule texts
 *  that asked for them. */
function askableSelectors(rules: ParsedRule[]): Map<string, string[]> {
  // One entry per distinct selector, mapped back to every text that asked for
  // it — `.a:hover` and `.a` ask the same question of the DOM.
  const askedFor = new Map<string, string[]>()
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      const ask = askableForm(sel.text)
      if (!ask) continue
      const list = askedFor.get(ask)
      if (list) list.push(sel.text)
      else askedFor.set(ask, [sel.text])
    }
  }
  return askedFor
}

/** What the page said about one element: what it renders as, and which of the
 *  asked-for selectors target it. */
export type CanvasIdentity = {
  tag: string
  id?: string | null
  classes: string[]
  attributes: Record<string, string>
}
export type CanvasAsk = {
  answer: { identity: CanvasIdentity | null; matched: Record<string, boolean | null> } | null
  askedFor: Map<string, string[]>
}

/**
 * Ask the page everything the panel needs about the selected element, in ONE
 * round trip. Identity and selector matching used to be asked separately —
 * two questions about the same element at the same moment, each bounded by
 * its own 1.5s timeout, and the second couldn't start until the first came
 * back. The chips stayed blank for the sum of the two.
 *
 * Returns null when there's nothing to ask (no path for the node, or no
 * canvas), which callers pass straight through so they don't ask again.
 */
export async function askCanvasAbout(rootKey: string, rules: ParsedRule[]): Promise<CanvasAsk | null> {
  const path = getHost().pathOf?.(rootKey)
  if (!path || !hasCanvas()) return null
  const askedFor = askableSelectors(rules)
  const answer = await queryCanvas(path, [...askedFor.keys()])
  return { answer, askedFor }
}

/**
 * Fill `target.domMatched` from what the canvas said about these selectors.
 *
 * This is the whole point of the exercise: the rendered DOM knows what every
 * component renders, what every loop produced, and what classes a script or a
 * `class:list` expression put there — none of which the source tree can see.
 * Selectors the engine can't be asked about (or a canvas that doesn't answer)
 * are simply left out of the map, so they fall back to the source matcher.
 *
 * Pass `asked` (including null) to reuse an answer already in hand; omit it and
 * this asks on its own.
 */
export async function primeDomMatches(
  target: MatchTarget,
  rules: ParsedRule[],
  asked?: CanvasAsk | null,
): Promise<void> {
  const ask = asked !== undefined ? asked : await askCanvasAbout(target.rootKey, rules)
  if (!ask?.answer) return
  const matched = new Map<string, boolean>()
  for (const [text, hit] of matchedTexts(ask)) matched.set(text, hit)
  target.domMatched = matched
}

function* matchedTexts(ask: CanvasAsk): Generator<[string, boolean]> {
  for (const [sel, texts] of ask.askedFor) {
    const hit = ask.answer?.matched[sel]
    if (typeof hit !== 'boolean') continue // the engine refused it — fall back
    for (const text of texts) yield [text, hit]
  }
}

// ───────────────────────────── Match target ─────────────────────────────

export async function resolveTarget(
  selected: AnyEl,
  scan: EmbedScan,
  /** An answer already in hand (see askCanvasAbout) — including null, which
   *  means "there was nothing to ask". Omit it and this asks the page itself. */
  asked?: CanvasAsk | null,
): Promise<{ target: MatchTarget; rootSnapshot: ElementSnapshot }> {
  const rootKey = serializeElementId(selected)
  const snapshots = new Map<string, ElementSnapshot | null>()
  const view: TreeView = {
    // The whole page model is in hand, so ancestors are never unknown.
    truncated: false,
    parentKey: (key) => scan.parentByKey.get(key) ?? null,
    childKeys: (key) => scan.childrenByKey.get(key) ?? [],
    elementChildKeys: (key) => {
      const kids = scan.childrenByKey.get(key) ?? []
      const nodes = kids.map((k) => scan.elementByKey.get(k))
      // A loop or a bare expression renders any number of elements (including
      // none), so positions around one can't be pinned down — say "unknown"
      // rather than count it as a single sibling.
      if (nodes.some((n) => n && OPAQUE_COUNT_KINDS.has(String((n as { kind?: string }).kind))))
        return null
      return kids.filter((_, i) => {
        const kind = String((nodes[i] as { kind?: string } | undefined)?.kind ?? '')
        return ELEMENT_KINDS.has(kind)
      })
    },
    snapshot: async (key) => {
      if (snapshots.has(key)) return snapshots.get(key) ?? null
      const el = scan.elementByKey.get(key)
      const snap = el ? await buildSnapshot(el) : null
      snapshots.set(key, snap)
      return snap
    },
  }
  const target: MatchTarget = { rootKey, view }
  let rootSnapshot = await buildSnapshot(selected)
  // What the selected node actually renders as. A component instance has no
  // tag or classes of its own — `<Section>` says nothing about the
  // `<section class="section">` it produces — so the header, the chips, and
  // every selector composed from them were describing the call site rather
  // than the element on the page. The canvas knows the difference.
  let identity: CanvasIdentity | null | undefined = asked?.answer?.identity
  if (asked === undefined) {
    const path = getHost().pathOf?.(rootKey)
    if (path && hasCanvas()) identity = (await queryCanvas(path, []))?.identity
  }
  if (identity) {
    const attributes = { ...identity.attributes }
    delete attributes.class
    if (identity.classes.length) attributes.class = identity.classes.join(' ')
    rootSnapshot = {
      ...rootSnapshot,
      tag: identity.tag,
      id: identity.id ?? rootSnapshot.id,
      classes: identity.classes,
      classList: identity.classes,
      attributes,
    }
  }
  return { target, rootSnapshot }
}

// ───────────────────────────── Breakpoints ─────────────────────────────

// The canvas has three widths; they map onto the scale the panel already
// speaks so its breakpoint controls need no changes.
export async function getCurrentBreakpoint(): Promise<BreakpointId> {
  const device = getHost().device
  if (device === 'tablet') return 'medium'
  if (device === 'phone') return 'small'
  return 'main'
}

// ───────────────────────── Native styles: not applicable ─────────────────────
//
// Webflow's class styles are a second styling system alongside CSS. Here there
// is only CSS, so the panel is told there are none — every value it shows and
// writes comes from a stylesheet or a <style> block.

// Whether a second, non-CSS styling system exists to write into. In the
// Designer that is Webflow's class styles; here there is none, so every
// property must be authored as CSS. The panel consults this before routing an
// edit away from the stylesheet.
export function nativeStylingAvailable(): boolean {
  return false
}

const EMPTY_NATIVE: NativeModel = { styles: [], read: false }

export type NativeWriteTarget = { namePath: string[]; index: number | null }

export async function readNativeStyles(
  _el: AnyEl,
  _states: readonly StateKey[],
  onPhase?: (model: NativeModel) => void,
): Promise<NativeModel> {
  onPhase?.(EMPTY_NATIVE)
  return EMPTY_NATIVE
}

export async function readNativeStyleByName(): Promise<NativeModel> {
  return EMPTY_NATIVE
}

const NO_NATIVE = { ok: false as const, error: 'This project styles with CSS — write to a stylesheet.' }

export async function applyNativePropertyAt(): Promise<{ ok: false; error: string }> {
  return NO_NATIVE
}

export async function removeNativePropertyAt(): Promise<{ ok: false; error: string }> {
  return NO_NATIVE
}

export async function applyNativeToNewBaseClass(): Promise<{ ok: false; error: string }> {
  return NO_NATIVE
}

export async function liveSetNativeProperty(): Promise<{ ok: false; error: string }> {
  return NO_NATIVE
}

// ───────────────────────── Variables, fonts, assets ─────────────────────────

export type ProjectVariable = {
  collection: string
  group: string
  name: string
  value: string
  binding: string
  type: string
}

// The panel filters the picker by variable type, and it speaks Webflow's
// vocabulary — notably 'Color' and 'FontFamily', which it treats specially
// (a colour field offers only Color variables, font-family only FontFamily).
// A custom property has no declared type, so infer one; CSS.supports is the
// accurate test, with a regex fallback for non-DOM contexts.
const supports = (prop: string, value: string): boolean => {
  try {
    return typeof CSS !== 'undefined' && CSS.supports(prop, value)
  } catch {
    return false
  }
}

// The CSS-wide keywords are valid for EVERY property, so CSS.supports() types them as
// whatever it's asked about first (Color). They're keywords — treat them as such.
const CSS_WIDE_RE = /^(inherit|initial|unset|revert|revert-layer)$/i

const varKind = (name: string, value: string): string => {
  const v = value.trim()
  if (CSS_WIDE_RE.test(v)) return 'String'
  // A value that still carries a var() reference (an alias into CSS we never read, or a
  // fallback chain) is untyped as far as CSS.supports() goes: an unresolved reference
  // parses as valid for EVERY property, so `--h6-font-family: var(--primary-family)`
  // came back as a Color — and then the font field's picker, which shows only
  // FontFamily, had nothing to show. Ask CSS.supports only about resolved values and
  // leave the rest to the literal-syntax regexes, which need real syntax to match.
  const unresolved = /var\(/i.test(v)
  if ((!unresolved && supports('color', v)) || /^#|^rgba?\(|^hsla?\(|^color(-mix)?\(/i.test(v)) return 'Color'
  // Fluid sizing — `clamp(var(--space-5-min) / 16 * 1rem, …)` — keeps var() references
  // inside it that we can't resolve, but math functions only ever produce a length or a
  // number, so the wrapper alone is enough to call it a Size.
  if (/^(calc|clamp|min|max)\(/i.test(v)) return 'Size'
  if ((!unresolved && supports('width', v)) || /^-?[\d.]+(px|rem|em|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in)$/i.test(v)) return 'Size'
  if (/^-?[\d.]+$/.test(v)) return 'Number'
  // Nothing in the value to go on — a font stack has no distinguishing syntax, so the
  // last hint is the name it was given.
  if (/font-?family/i.test(name)) return 'FontFamily'
  return 'String'
}

// Follow a variable that is nothing but a reference to another one
// (`--h6-letter-spacing: var(--letter-spacing-tight)`) to the literal value at the end
// of the chain, so varKind has real syntax to read. Falls back to the var()'s own
// fallback, then gives up and returns what it was handed.
const ALIAS_RE = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,([\s\S]*))?\)$/
function resolveAlias(value: string, values: Map<string, string>, depth = 0): string {
  const v = value.trim()
  const m = depth > 8 ? null : ALIAS_RE.exec(v)
  if (!m) return v
  const target = values.get(m[1].slice(2))
  if (target != null) return resolveAlias(target, values, depth + 1)
  const fallback = m[2]?.trim()
  return fallback ? resolveAlias(fallback, values, depth + 1) : v
}

// Custom properties declared anywhere in the project's CSS. The rule they sit
// in is the closest thing to Webflow's collection, so it groups them.
async function readAllProjectCss(): Promise<Array<{ label: string; css: string }>> {
  const host = getHost()
  const out: Array<{ label: string; css: string }> = []
  // Ask for the stylesheet list rather than trusting host.files: the variable
  // scan is kicked off once and its result is cached for the session, so if it
  // happened to run before the async file list arrived it would cache "no
  // variables" forever.
  let files = host.files
  if (!files.length && host.projectPath) {
    try {
      const res = await window.avb.listStyleFiles(host.projectPath)
      files = res?.files || []
    } catch {
      files = []
    }
  }
  for (const f of files) {
    try {
      const res = await window.avb.readStyleFile(f.path)
      out.push({ label: f.rel, css: res?.css ?? '' })
    } catch {
      /* unreadable — skip it rather than fail the whole scan */
    }
  }
  // Variables are just as often declared in a component's global block as in a
  // stylesheet, so the picker has to read those too.
  let astro = host.astroFiles
  if (!astro.length && host.projectPath) {
    try {
      const res = await window.avb.listAstroStyleFiles(host.projectPath)
      astro = res?.files || []
    } catch {
      astro = []
    }
  }
  for (const f of astro) {
    try {
      const res = await window.avb.readStyleFile(f.path)
      for (const region of splitEmbed(res?.css ?? '').regions) {
        if (isGlobalRegion(region)) out.push({ label: f.name, css: region.css })
      }
    } catch {
      /* unreadable — skip it rather than fail the whole scan */
    }
  }
  walkNodes(host.nodes, (n) => {
    if (n.kind === 'raw' && n.name === 'style') out.push({ label: '<style>', css: String(n.inner ?? '') })
  })
  return out
}

// The panel kicks the variable scan off once and caches the result for the
// session, so an early call that found nothing would leave the picker empty
// for good. Wait for the host to actually have a project before scanning.
function whenProjectReady(timeoutMs = 4000): Promise<void> {
  if (getHost().projectPath) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = onHostChange(() => {
      if (getHost().projectPath) done()
    })
    const timer = setTimeout(done, timeoutMs)
  })
}

export async function streamProjectVariables(
  onAdd: (v: ProjectVariable) => void,
  isCancelled: () => boolean = () => false,
): Promise<ProjectVariable[]> {
  await whenProjectReady()
  const all: ProjectVariable[] = []
  const seen = new Set<string>()
  // Parse everything up front and index every custom property by name: a variable's type
  // often lives in the variable it aliases (`--h6-font-family: var(--font-display)`),
  // which may be declared in a file we haven't reached yet, so the whole map has to exist
  // before the first type is inferred.
  const parsed: Array<{ label: string; root: ReturnType<typeof postcss.parse> }> = []
  const values = new Map<string, string>()
  for (const { label, css } of await readAllProjectCss()) {
    if (isCancelled()) break
    let root
    try {
      root = postcss.parse(css)
    } catch {
      continue
    }
    parsed.push({ label, root })
    root.walkDecls((decl) => {
      const key = decl.prop.startsWith('--') ? decl.prop.slice(2) : null
      if (key && !values.has(key)) values.set(key, decl.value.trim())
    })
  }
  for (const { label, root } of parsed) {
    if (isCancelled()) break
    root.walkDecls((decl) => {
      if (!decl.prop.startsWith('--')) return
      const name = decl.prop.slice(2)
      if (seen.has(name)) return
      seen.add(name)
      const v: ProjectVariable = {
        collection: label,
        group: (decl.parent as { selector?: string })?.selector || ':root',
        name,
        value: decl.value.trim(),
        binding: `var(${decl.prop})`,
        type: varKind(name, resolveAlias(decl.value, values)),
      }
      all.push(v)
      onAdd(v)
    })
  }
  return all
}

export async function getProjectFontFamilies(): Promise<string[]> {
  await whenProjectReady()
  const families = new Set<string>()
  for (const { css } of await readAllProjectCss()) {
    let root
    try {
      root = postcss.parse(css)
    } catch {
      continue
    }
    root.walkDecls(/^font-family$/i, (decl) => {
      for (const part of decl.value.split(',')) {
        const name = part.trim().replace(/^['"]|['"]$/g, '')
        if (name && !name.startsWith('var(')) families.add(name)
      }
    })
    root.walkAtRules(/^font-face$/i, (rule) => {
      rule.walkDecls(/^font-family$/i, (decl) => {
        const name = decl.value.trim().replace(/^['"]|['"]$/g, '')
        if (name) families.add(name)
      })
    })
  }
  return [...families].sort((a, b) => a.localeCompare(b))
}

export type ImageAsset = { id: string; name: string; url: string }

export async function getImageAssets(): Promise<ImageAsset[]> {
  const host = getHost()
  if (!host.projectPath) return []
  try {
    const { entries } = await window.avb.listAssets(host.projectPath)
    return (entries || [])
      .filter((e: { isDir: boolean; name: string }) => !e.isDir && /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(e.name))
      .map((e: { rel: string; name: string }) => ({ id: e.rel, name: e.name, url: `/${e.rel}` }))
  } catch {
    return []
  }
}

// ───────────────────────────── Pure helpers ─────────────────────────────

function isFlexNumber(token: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)$/.test(token)
}

export function parseFlexShorthand(value: string): Record<string, string> | null {
  const v = value.trim().toLowerCase()
  if (v === 'none') return { 'flex-grow': '0', 'flex-shrink': '0', 'flex-basis': 'auto' }
  if (v === 'auto') return { 'flex-grow': '1', 'flex-shrink': '1', 'flex-basis': 'auto' }
  if (v === 'initial') return { 'flex-grow': '0', 'flex-shrink': '1', 'flex-basis': 'auto' }
  if (v === '' || /^(inherit|unset|revert|revert-layer)$/.test(v)) return null
  if (/[a-z-]+\(/i.test(v)) return null
  const tokens = v.split(/\s+/)
  if (tokens.length > 3) return null
  let grow: string, shrink: string, basis: string
  if (tokens.length === 1) {
    if (isFlexNumber(tokens[0])) {
      grow = tokens[0]
      shrink = '1'
      basis = '0'
    } else {
      grow = '1'
      shrink = '1'
      basis = tokens[0]
    }
  } else if (tokens.length === 2) {
    grow = tokens[0]
    if (isFlexNumber(tokens[1])) {
      shrink = tokens[1]
      basis = '0'
    } else {
      shrink = '1'
      basis = tokens[1]
    }
  } else {
    grow = tokens[0]
    shrink = tokens[1]
    basis = tokens[2]
  }
  if (!isFlexNumber(grow) || !isFlexNumber(shrink)) return null
  return { 'flex-grow': grow, 'flex-shrink': shrink, 'flex-basis': basis }
}

export type { NativeStyle }
