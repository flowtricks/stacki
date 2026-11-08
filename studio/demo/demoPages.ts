// Serves the current rendering of a page to its frame: the baked document with every
// edit that can be shown applied. morph.js asks for it the way it would pull from a
// dev server, and patches the difference onto the live page.
import { BAKE_MESSAGES, BAKE_RENDERING_GLOBAL, BAKE_SECTION_ATTRIBUTE } from '../src/features/bake/bakeProtocol';
import { joinOutput } from '../src/features/bake/componentTemplates';
import { assert } from '../vendor/stacki/shared/core/assert';
import { componentFilesIn, renderEditsInText, renderUse } from './componentRender';
import type { BakePage, BakeSnapshot } from '../src/features/bake/bakeSnapshot';
import { renderBaselineScript } from '../src/features/preview/renderBaseline';
import { record, string } from '../src/shared/validation';
import { markupOf, NOT_SHOWN, planPageChange, type CreatedComponent, type NotShownReason } from './pageChange';
import { applyComponentChange, applyPageChange, replaceSection } from './pageRender';
import { contentChanges, patchContent } from './contentPatch';
import { insertionDefaults } from './insertionDefaults';
import { restampRendering } from './renderStamps';
import type { DemoRooms } from './room';
import { renderSection } from './styleSections';
import { StylePreview, type StyleMessage } from './styleUpdates';
import { DemoVariants } from './variantRender';

const BASELINE = '<script id="studio-render-baseline"';
const FRAMES_MAX = 16;

/** Every same-origin frame on the page: the canvas, and any preview beside it. */
function postToFrames(message: StyleMessage): void {
  const frames = document.querySelectorAll('iframe');
  for (let index = 0; index < frames.length && index < FRAMES_MAX; index++) {
    frames[index]?.contentWindow?.postMessage(message, location.origin);
  }
}

/** What decides a page's rendering apart from its styles: each edited file's markup. */
function markupKey(page: string, edited: ReadonlyMap<string, string>): string {
  const files = [...edited].map(([file, text]) => [file, file.endsWith('.css') ? '' : file.endsWith('.astro') ? markupOf(text) : text]);
  return JSON.stringify([page, files]);
}

interface LastRendering {
  readonly key: string;
  readonly document: Document;
  readonly reasons: readonly NotShownReason[];
}

export class DemoPages {
  private readonly documents = new Map<string, Promise<string>>();
  private readonly ready = new Map<string, string>();
  private last: LastRendering | undefined;
  // Prop hover previews, rendered here from the bake's templates as the dev server would.
  private readonly variants = new DemoVariants(location.origin, (path, change) => this.renderVariant(path, change));

  constructor(
    private readonly snapshot: BakeSnapshot,
    private readonly rooms: DemoRooms,
    private readonly nativeFetch: typeof fetch,
    private readonly reported: (reasons: readonly NotShownReason[]) => void,
  ) {}

  listen(): void {
    Object.defineProperty(window, BAKE_RENDERING_GLOBAL, { value: (path: string) => this.earlyRendering(path) });
    window.addEventListener('message', (event) => void this.receive(event));
    const preview = new StylePreview(
      this.snapshot.sections,
      (file) => this.snapshot.sources[file],
      () => ({ ...this.snapshot.sources, ...Object.fromEntries(this.rooms.edited()) }),
      (message) => postToFrames(message),
    );
    this.rooms.onText((file, text) => preview.changed(file, text));
    this.rooms.useInsertion(() => insertionDefaults(this.snapshot.project, (file) => this.rooms.read(file)));
  }

  private async receive(event: MessageEvent<unknown>): Promise<void> {
    if (event.origin !== location.origin || event.source === null) {
      return;
    }
    const data = event.data;
    if (this.variants.receive(event.source, data)) {
      return;
    }
    if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== BAKE_MESSAGES.renderRequest) {
      return;
    }
    const message = record(data);
    const page = this.pageAt(string(message['path'], 2_000));
    const html = page === undefined ? undefined : await this.render(page);
    event.source.postMessage({ type: BAKE_MESSAGES.renderResult, id: message['id'], html }, { targetOrigin: location.origin });
  }

  private pageAt(path: string): BakePage | undefined {
    const relative = path.startsWith(this.snapshot.base) ? path.slice(this.snapshot.base.length) : path;
    return this.snapshot.pages.find(
      (page) => page.document === relative || page.document === `${relative}index.html` || page.document === `${relative}/index.html`,
    );
  }

  private document(page: BakePage): Promise<string> {
    // By document, not file: a template's entries share its file, each with its own document.
    const known = this.documents.get(page.document);
    if (known !== undefined) {
      return known;
    }
    const loaded = this.nativeFetch(`${this.snapshot.base}${page.document}`).then(async (response) => {
      const text = await response.text();
      const end = text.lastIndexOf(BASELINE);
      const baked = end < 0 ? text : text.slice(0, end);
      this.ready.set(page.document, baked);
      return baked;
    });
    this.documents.set(page.document, loaded);
    return loaded;
  }

  /** Every page's document, so a reload can be answered in the frame's first moment. */
  async warm(): Promise<void> {
    await Promise.all(this.snapshot.pages.map((page) => this.document(page)));
  }

  /** The page as it reads now. Unedited pages return the build's own bytes. */
  async render(page: BakePage): Promise<string> {
    return this.renderFrom(page, await this.document(page));
  }

  /**
   * The page at `path` as it reads now, or, given a change, as it would read with that
   * one file's text in place of its current text. A variant is never stored, reported
   * or cached as the page's rendering: it exists only for the preview that asked.
   */
  private async renderVariant(path: string, change: { readonly file: string; readonly text: string } | undefined): Promise<string | undefined> {
    const page = this.pageAt(path);
    if (page === undefined) {
      return undefined;
    }
    const baked = await this.document(page);
    if (change === undefined) {
      return this.renderFrom(page, baked);
    }
    const edited = new Map(this.rooms.edited());
    edited.set(change.file, change.text);
    assert(edited.get(change.file) === change.text, 'A variant renders its own text');
    const sources = { ...this.snapshot.sources, ...Object.fromEntries(edited) };
    const { document } = this.renderPage(page, baked, edited, sources);
    this.styleEdited(document, edited, sources);
    const content = contentChanges(this.snapshot.content, edited, (file) => this.snapshot.sources[file]);
    patchContent(document, page.file, content.fields);
    return restampRendering(`<!doctype html>\n${document.documentElement.outerHTML}`, edited, (file) => this.snapshot.sources[file]);
  }

  private styleEdited(document: Document, edited: ReadonlyMap<string, string>, sources: Readonly<Record<string, string>>): void {
    const cssEdited = [...edited.keys()].some((file) => file.endsWith('.css'));
    for (const section of this.snapshot.sections) {
      if (edited.has(section.file) || (cssEdited && section.file.endsWith('.css'))) {
        this.replaceStyle(document, section, sources);
      }
    }
  }

  private renderFrom(page: BakePage, baked: string): string {
    const edited = this.rooms.edited();
    if (edited.size === 0) {
      this.reported([]);
      return baked;
    }
    const sources = { ...this.snapshot.sources, ...Object.fromEntries(edited) };
    const key = markupKey(page.document, edited);
    // A scrub that changed only styles asks for a rendering per tick. The page itself
    // is what it was, so the last one is reused and only its style sections change.
    const reused = this.last?.key === key ? this.last : undefined;
    const fresh = reused === undefined ? this.renderPage(page, baked, edited, sources) : undefined;
    const document = reused?.document ?? fresh?.document;
    assert(document !== undefined, 'A rendering is either reused or made');
    this.styleEdited(document, edited, sources);
    const reasons = reused?.reasons ?? fresh?.reasons ?? [];
    if (fresh !== undefined) {
      const content = contentChanges(this.snapshot.content, edited, (file) => this.snapshot.sources[file]);
      const patched = patchContent(fresh.document, page.file, content.fields);
      // A field is listed under the template's file when any entry shows it, so one entry
      // missing it is expected; only a field no entry can show is reported.
      const missed = page.entry === undefined ? !patched : false;
      if (missed || content.unshown) {
        reasons.push(NOT_SHOWN.content);
      }
    }
    this.last = { key, document, reasons };
    this.reported(reasons);
    return restampRendering(`<!doctype html>\n${document.documentElement.outerHTML}`, edited, (file) => this.snapshot.sources[file]);
  }

  /** What a frame loads instead of the build: undefined leaves the build in place. */
  private earlyRendering(path: string): string | undefined {
    const page = this.pageAt(path);
    const baked = page === undefined ? undefined : this.ready.get(page.document);
    if (page === undefined || baked === undefined || this.rooms.edited().size === 0) {
      return undefined;
    }
    const html = this.renderFrom(page, baked);
    return html + renderBaselineScript(html);
  }

  private replaceStyle(document: Document, section: BakeSnapshot['sections'][number], sources: Readonly<Record<string, string>>): void {
    try {
      const css = renderSection(section, sources);
      if (css !== undefined) {
        replaceSection(document, section.id, css);
      }
    } catch {
      /* Mid-edit CSS may not parse. The page keeps the section's last rendering. */
    }
  }

  // The page's own edits first in its text (re-rendered component instances), then in
  // its tree (everything else), then the styles of any component that is new to it.
  private renderPage(
    page: BakePage,
    baked: string,
    edited: ReadonlyMap<string, string>,
    sources: Readonly<Record<string, string>>,
  ): { readonly document: Document; readonly reasons: readonly NotShownReason[] } {
    const reasons = new Set<NotShownReason>();

    const current = edited.get(page.file);
    const bakedSource = this.snapshot.sources[page.file];
    if (current === undefined || bakedSource === undefined) {
      const document = new DOMParser().parseFromString(baked, 'text/html');
      this.applyComponents(document, page, edited, reasons);
      return { document, reasons: [...reasons] };
    }
    const catalog = this.snapshot.components;
    const entry = page.entry === undefined ? undefined : page.document;
    const plan = planPageChange(bakedSource, current, { file: page.file, catalog, entry });
    const text = renderEditsInText(baked, plan.components, catalog, page.file, entry);
    if (text.failed.length > 0) {
      reasons.add(NOT_SHOWN.component);
    }
    const document = new DOMParser().parseFromString(text.html, 'text/html');
    const files = new Set(text.html === baked ? [] : componentFilesIn(text.html));
    const scope = this.snapshot.sections.find((section) => section.file === page.file)?.scope;
    const build = (use: CreatedComponent) => {
      const output = renderUse(catalog, use, undefined);
      for (const file of output === undefined ? [] : componentFilesIn(joinOutput(output, () => ''))) {
        files.add(file);
      }
      return output;
    };
    for (const reason of applyPageChange(document, plan, scope, build)) {
      reasons.add(reason);
    }
    this.addSections(document, files, sources);
    this.applyComponents(document, page, edited, reasons);
    return { document, reasons: [...reasons] };
  }

  // A component's own text and attribute edits show on every instance of it, as an
  // open component in Studio shows them; a change to its structure needs Astro.
  private applyComponents(document: Document, page: BakePage, edited: ReadonlyMap<string, string>, reasons: Set<NotShownReason>): void {
    for (const [file, text] of edited) {
      const source = this.snapshot.sources[file];
      if (file.endsWith('.astro') && file !== page.file && !file.startsWith('src/pages/') && source !== undefined && markupOf(source) !== markupOf(text)) {
        if (!applyComponentChange(document, file, planPageChange(markupOf(source), markupOf(text)))) {
          reasons.add(NOT_SHOWN.markup);
        }
      }
    }
  }

  /** A component new to the page brings its styles, as Astro's build would have. */
  private addSections(document: Document, files: ReadonlySet<string>, sources: Readonly<Record<string, string>>): void {
    const present = new Set([...document.querySelectorAll(`style[${BAKE_SECTION_ATTRIBUTE}]`)].map((style) => style.getAttribute(BAKE_SECTION_ATTRIBUTE)));
    for (const section of this.snapshot.sections) {
      if (files.has(section.file) && !present.has(section.id)) {
        try {
          const css = renderSection(section, sources);
          if (css !== undefined) {
            const style = document.createElement('style');
            style.setAttribute(BAKE_SECTION_ATTRIBUTE, section.id);
            style.textContent = css;
            document.head.append(style);
          }
        } catch {
          /* CSS that does not parse mid-edit is left out until it does. */
        }
      }
    }
  }
}
