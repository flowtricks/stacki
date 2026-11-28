// Text a page prints from data (`{aiCallout1.body}`), editable on the canvas by
// writing the words back to the string literal they come from: in the page's own
// frontmatter, in a project module it imports, in a JSON file, or in the list a
// loop goes through, one item at a time.
//
// The tracing is src/editor/boundText.ts (pure). This module is the part that
// touches the canvas: one target per text whose source is a plain string, one
// "blocked" entry per text that is not (the double click then says why instead
// of staying silent), the edit that writes through the document or the host,
// and the toast that names what changed with an Undo.
//
// Texts are matched on the canvas by their words, so a loop gets one target per
// item and an item whose words another item repeats gets none: the frame could
// not tell which of the two a double click is on, and an edit is never guessed.

import type { CanvasBoundText, CanvasTextEdit } from '../../features/preview/canvasTextSource';
import { canvasTextTarget } from '../../features/preview/canvasTextSource';
import type { CanvasTextDocument } from '../../features/preview/useCanvasText';
import { requestCanvasTextRefresh } from '../../features/preview/canvasTextRefresh';
import { CANVAS_TEXT_LIMIT } from '../../../shared/properties/canvasText';
import { assert } from '../../../shared/core/assert';
import {
  resolveBoundText,
  rewriteBoundText,
  type BoundTextBlock,
  type BoundTextEnvironment,
  type BoundTextModule,
  type BoundTextSite,
} from '../../editor/boundText';
import { canvasTypedText } from '../../ui/canvasTextDraft';
import { TARGETS_MAX, refused, resolvePageTexts, type Resolved } from './canvasBoundSites';
import { reportActionToast } from '../../ui/errorNotices';

/** What the host gives the canvas to follow and write data modules: Desktop over IPC, Studio from its dev server. */
export interface BoundTextHost {
  /** The module `spec` names from `fromFile` (project relative), or undefined for a package or a missing file. */
  readonly readModule: (fromFile: string, spec: string) => Promise<BoundTextModule | undefined>;
  /** A project file's text as it is now (project relative), or undefined when it cannot be read. */
  readonly readFile: (file: string) => Promise<string | undefined>;
  /**
   * Replaces `before` with `after` in `file` as one undo step, only while the file still holds `before`.
   * Absent: the host cannot write beside the page, and a binding to another file is shown but not edited.
   */
  readonly writeModule?: (write: { readonly file: string; readonly before: string; readonly after: string }) => Promise<void>;
  /** The history's own Undo, for the toast beside a saved edit. */
  readonly undo?: () => Promise<void>;
}

/** The words this module raises, in the person's language. */
export interface BoundTextWords {
  readonly saved: (path: string, file: string) => string;
  readonly undo: string;
  readonly sourceChanged: string;
}

const siteKey = (site: BoundTextSite): string => `${site.file}\u0000${site.start}`;

export async function canvasBoundEdits(document: CanvasTextDocument, host: BoundTextHost, words: BoundTextWords): Promise<CanvasTextEdit[]> {
  // Every text of the page is traced against the same files: each is read once, not once per text.
  const reads = new Map<string, Promise<BoundTextModule | undefined>>();
  const environment: BoundTextEnvironment = {
    page: { file: document.file, text: document.source },
    readModule: (fromFile, spec) => {
      const key = `${fromFile}\u0000${spec}`;
      const known = reads.get(key) ?? host.readModule(fromFile, spec);
      reads.set(key, known);
      return known;
    },
  };
  const resolved = await resolvePageTexts(environment, document.nodes);
  const uses = new Map<string, number>();
  for (const entry of resolved) {
    if (entry.outcome.ok) {
      const key = siteKey(entry.outcome.site);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  const edits: CanvasTextEdit[] = [];
  for (const entry of withoutRepeats(resolved)) {
    const edit = entry.outcome.ok ? sourceEdit(document, host, words, entry, entry.outcome.site, uses) : blockedEdit(document, entry, entry.outcome.block);
    if (edit !== undefined) {
      edits.push(edit);
    }
  }
  assert(edits.length <= TARGETS_MAX, 'Bound text stays within its target bound');
  return edits;
}

// Items that spell the same words as another of the same text, within one candidate, are dropped: the canvas finds a text by its words. A text with some dropped is refused once, by name.
function withoutRepeats(resolved: readonly Resolved[]): Resolved[] {
  const counts = new Map<string, number>();
  const wordsKey = (entry: Resolved & { readonly outcome: { readonly ok: true; readonly site: BoundTextSite } }) =>
    `${entry.candidate.node.id ?? ''}\u0000${entry.outcome.site.value.trim()}`;
  for (const entry of resolved) {
    if (entry.outcome.ok && entry.suffix !== '') {
      const key = wordsKey({ ...entry, outcome: entry.outcome });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const kept: Resolved[] = [];
  const reported = new Set<string>();
  for (const entry of resolved) {
    if (!entry.outcome.ok || entry.suffix === '' || (counts.get(wordsKey({ ...entry, outcome: entry.outcome })) ?? 0) === 1) {
      kept.push(entry);
      continue;
    }
    const id = entry.candidate.node.id ?? '';
    if (!reported.has(id)) {
      reported.add(id);
      kept.push(refused(entry.candidate, { reason: 'duplicate', file: '', detail: 'Several items print the same words.' }));
    }
  }
  return kept;
}

function sourceEdit(
  document: CanvasTextDocument,
  host: BoundTextHost,
  words: BoundTextWords,
  entry: Resolved,
  site: BoundTextSite,
  uses: ReadonlyMap<string, number>,
): CanvasTextEdit | undefined {
  const { candidate } = entry;
  if (!site.value.trim() || site.value.length > CANVAS_TEXT_LIMIT) {
    return undefined;
  }
  const target = canvasTextTarget(candidate.node, candidate.parent, site.value, 'Edit source', document.pathFor);
  if (target === undefined) {
    return undefined;
  }
  const bound: CanvasBoundText = {
    kind: 'source',
    expression: entry.path,
    file: site.file === document.file ? '' : site.file,
    uses: uses.get(siteKey(site)) ?? 1,
  };
  const editable = site.file === document.file || host.writeModule !== undefined;
  return {
    target: { ...target, key: `${target.key}${entry.suffix}` },
    bound: editable ? bound : { kind: 'blocked', expression: entry.path, file: site.file, reason: 'unsupported' },
    apply: (value) => commitSource({ document, host, words, site, expression: entry.path, value: canvasTypedText(site.value, value) }),
  };
}

function blockedEdit(document: CanvasTextDocument, entry: Resolved, block: BoundTextBlock): CanvasTextEdit | undefined {
  const { candidate } = entry;
  const key = document.pathFor(candidate.node.id ?? '');
  const target = canvasTextTarget(candidate.node, candidate.parent, entry.path, 'Edit source', document.pathFor);
  if (key === undefined || target === undefined || entry.suffix !== '') {
    return undefined;
  }
  return {
    target: { ...target, value: '' },
    bound: {
      kind: 'blocked',
      expression: entry.path,
      file: block.file,
      reason: block.reason,
      ...(block.line === undefined ? {} : { line: block.line }),
      ...(block.name === undefined ? {} : { name: block.name }),
    },
    apply: () => Promise.reject(new Error(block.detail)),
  };
}

interface Commit {
  readonly document: CanvasTextDocument;
  readonly host: BoundTextHost;
  readonly words: BoundTextWords;
  readonly site: BoundTextSite;
  readonly expression: string;
  readonly value: string;
}

// One undo step: the page's own history for the page's file, the host's write for another.
async function commitSource(commit: Commit): Promise<void> {
  const { document, host, words, site, value } = commit;
  if (value === site.value) {
    return; // The same words write nothing, so a look is never an edit.
  }
  if (site.file === document.file) {
    const next = rewriteBoundText(document.source, site, value);
    if (next === undefined) {
      throw new Error(words.sourceChanged);
    }
    await document.apply(next, site.start);
  } else {
    const write = host.writeModule;
    assert(write !== undefined, 'A text is edited in another file only when the host can write it');
    const before = await host.readFile(site.file);
    const after = before === undefined ? undefined : rewriteBoundText(before, site, value);
    if (before === undefined || after === undefined) {
      throw new Error(words.sourceChanged);
    }
    await write({ file: site.file, before, after });
    requestCanvasTextRefresh();
  }
  const undo = host.undo;
  reportActionToast(
    words.saved(commit.expression, site.file === document.file ? document.file : site.file),
    'success',
    undo === undefined ? [] : [{ label: words.undo, run: undo }],
  );
}

/** A prop's binding followed to its string: the words it prints, what the canvas says of it, and the write. */
export interface BoundPropText {
  readonly value: string;
  readonly bound: CanvasBoundText;
  readonly apply: (typed: string) => Promise<void>;
}

/**
 * Follows a prop the page sets to `expression` to its string. A binding that leads to no string a write could
 * replace (a computed expression, a call, a prop, a missing key, a binding to a file the host cannot write) comes
 * back as a refusal that names why, so the double click on its text says so instead of staying silent.
 */
export function boundPropReader(
  document: CanvasTextDocument,
  host: BoundTextHost,
  words: BoundTextWords,
): (expression: string) => Promise<BoundPropText | undefined> {
  const environment: BoundTextEnvironment = {
    page: { file: document.file, text: document.source },
    readModule: (fromFile, spec) => host.readModule(fromFile, spec),
  };
  return async (expression) => {
    const path = expression.trim().replace(/^\{\s*([\s\S]*?)\s*\}$/, '$1');
    const outcome = await resolveBoundText(environment, path);
    if (!outcome.ok) {
      return refusedProp(path, outcome.block);
    }
    const { site } = outcome;
    if (!site.value.trim() || site.value.length > CANVAS_TEXT_LIMIT) {
      return undefined;
    }
    if (site.file !== document.file && host.writeModule === undefined) {
      return refusedProp(path, { reason: 'unsupported', file: site.file, detail: 'The host cannot write this file.' });
    }
    return {
      value: site.value,
      bound: { kind: 'source', expression: path, file: site.file === document.file ? '' : site.file, uses: 1 },
      apply: (typed) => commitSource({ document, host, words, site, expression: path, value: canvasTypedText(site.value, typed) }),
    };
  };
}

// A prop's binding that cannot be followed to one string: no words to match, the reason for the double click to give.
function refusedProp(expression: string, block: BoundTextBlock): BoundPropText {
  return {
    value: '',
    bound: {
      kind: 'blocked',
      expression,
      file: block.file,
      reason: block.reason,
      ...(block.line === undefined ? {} : { line: block.line }),
      ...(block.name === undefined ? {} : { name: block.name }),
    },
    apply: () => Promise.reject(new Error(block.detail)),
  };
}
