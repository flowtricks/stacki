// The panel's content for the file open now, built from what the app already holds, so opening
// another file (a component drilled into, the page backed out to) paints its chips in the first
// frame instead of after every stylesheet has been read again over IPC (stale-while-revalidate).
//
// A stylesheet's or another component's text does not depend on which file is open: only the
// list of sources does (styleSources in webflow.ts). So the last document read for each source
// is remembered here by key, and a switch builds the new list from them, parsing the open file's
// own `<style>` blocks from the model as a read would. A source never read (a file new to the
// list, the page a component was opened from, whose blocks were model nodes until now) is
// reported missing and read alone. The background refresh that follows re-reads every source
// from disk, as it always has, and replaces what was drawn where anything differs.
//
// Remembered documents are the live objects the panel edits, so an edit made in one file is in
// the document the next switch reuses. The open file's own copy as a component file
// (`astro:<path>`) is forgotten while it is open: its blocks are edited through the model, so the
// copy read before it was opened goes stale with the first edit.

import { assert } from '../../../../shared/core/assert';
import { documentFromCode, scanPageNow, type EmbedDocument, type EmbedScan, type EmbedSource } from '../model/webflow';
import { nodeById } from '../model/webflowElement';

/** The most sources remembered: every stylesheet and component of a large project, bounded so a long session cannot grow it. */
export const MEMORY_DOCUMENTS_MAX = 1024;

// Insertion order is recency: a document stored again moves to the end, the oldest goes first.
const remembered = new Map<string, EmbedDocument>();

export interface MemoryContent {
  readonly scan: EmbedScan;
  /** In source (cascade) order, with a hole wherever a source is missing. */
  readonly docs: ReadonlyArray<EmbedDocument | undefined>;
  /** The sources no document is remembered for: they need a read. */
  readonly missing: readonly EmbedSource[];
}

/** Remember the documents a scan stored, for the next switch. `openFilePath` is the file whose blocks the model holds. */
export function rememberDocuments(docs: readonly EmbedDocument[], openFilePath: string | undefined): void {
  for (const document of docs) {
    remembered.delete(document.source.key);
    remembered.set(document.source.key, document);
  }
  if (openFilePath !== undefined) {
    remembered.delete(`astro:${openFilePath}`);
  }
  for (const oldest of remembered.keys()) {
    if (remembered.size <= MEMORY_DOCUMENTS_MAX) {
      break;
    }
    remembered.delete(oldest);
  }
  assert(remembered.size <= MEMORY_DOCUMENTS_MAX, 'rememberDocuments: the memory is bounded');
}

/** Forget every document: what they were read from is gone (another project, a test). */
export function forgetDocuments(): void {
  remembered.clear();
}

/** The sources and tree of the file open now, with each source's document taken from memory where one is. */
export function memoryContent(): MemoryContent {
  const page = scanPageNow();
  const docs: Array<EmbedDocument | undefined> = [];
  const missing: EmbedSource[] = [];
  for (const source of page.pageEmbeds) {
    const document = rememberedDocument(source);
    docs.push(document);
    if (document === undefined) {
      missing.push(source);
    }
  }
  assert(docs.length === page.pageEmbeds.length, 'memoryContent: one slot per source');
  assert(missing.length <= docs.length, 'memoryContent: only listed sources are missing');
  const scan: EmbedScan = {
    parentByKey: page.parentByKey,
    childrenByKey: page.childrenByKey,
    elementByKey: page.elementByKey,
    embeds: page.pageEmbeds,
    inComponentContext: page.inComponentContext,
  };
  return { scan, docs, missing };
}

/** The memory's documents with the missing ones filled in by `read`, in source order. */
export function filledDocuments(content: MemoryContent, read: readonly EmbedDocument[]): EmbedDocument[] {
  const readByKey = new Map(read.map((document) => [document.source.key, document]));
  const out: EmbedDocument[] = [];
  content.docs.forEach((document, index) => {
    const filled = document ?? readByKey.get(content.scan.embeds[index]?.key ?? '');
    if (filled !== undefined) {
      out.push(filled);
    }
  });
  assert(out.length <= content.scan.embeds.length, 'filledDocuments: at most one document per source');
  return out;
}

// A model block is parsed from the model, as readSource reads it; the live document is kept
// while it already holds that text (or has live writes the model has not caught up with).
// Another source's document is reused as it is when the source is the same, and parsed again
// from its text when only its role changed (the page a component is open on reaches it as a
// page, not as another component).
function rememberedDocument(source: EmbedSource): EmbedDocument | undefined {
  const known = remembered.get(source.key);
  if (source.origin.kind === 'node') {
    const text = String(nodeById(source.origin.nodeId)?.inner ?? '');
    if (known !== undefined && sameSource(known.source, source) && (known.code === text || known.historyBase !== known.code)) {
      return known;
    }
    return documentFromCode(source, text);
  }
  if (known === undefined) {
    return undefined;
  }
  if (sameSource(known.source, source)) {
    return known;
  }
  return documentFromCode(source, known.code);
}

function sameSource(left: EmbedSource, right: EmbedSource): boolean {
  assert(left.key === right.key, 'sameSource: compared by key first');
  if (left.order !== right.order || left.label !== right.label) {
    return false;
  }
  if (left.fromComponent !== right.fromComponent || left.componentName !== right.componentName) {
    return false;
  }
  if (JSON.stringify(left.styleTag) !== JSON.stringify(right.styleTag)) {
    return false;
  }
  return JSON.stringify(left.origin) === JSON.stringify(right.origin);
}

/** For tests: how many documents are remembered. */
export function rememberedDocumentCount(): number {
  return remembered.size;
}
