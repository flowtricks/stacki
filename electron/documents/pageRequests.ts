// The pure half of the page handlers: a page's source parsed by its format,
// write and edit failures in their wire shapes, page routes filled with
// params, and the trail a copied selection carries.

import { type EditReport, type WriteReport } from './documentActors';
import { describeWriteReport } from './documentWrites';
import { isPathWithin } from '../lib/platform';
import type { IpcPayloads } from '../../shared/ipc/ipcPayloads';
import type { IpcResults, WirePageEditError, WirePageWriteFailure } from '../../shared/ipc/ipcResults';
import { describeRejection } from '../../shared/engine/intent';
import * as path from 'path';
import { parsePage, locateSelection, resolveChunks } from '../parse/astroParser';
import { parseMarkdownPage } from '../parse/markdownParser';
import { toPosix } from '../lib/mainHelpers';
import { translateMain } from '../lib/mainLocale';

// The page formats Astro routes from a file: .astro, plus markdown when the
// project has the integration for it (.md always, .mdx via @astrojs/mdx).
// Kept as one place so discovery, routing and reading can't drift apart.
export const PAGE_MD_RE = /\.mdx?$/i;
export const isMarkdownPage = (filePath: string) => PAGE_MD_RE.test(filePath);
export const isMdx = (filePath: string) => /\.mdx$/i.test(filePath);

// ---------------------------------------------------------------------------
// HTML chunks — resolution lives in astroParser so the dev server's marker
// config can reuse it (see writeMarkerConfig). The page editor shows a
// chunk's markup in the navigator and never writes it: no page save is a whole
// model any more (step 9), and a chunk file has no node intents of its own
// yet — its content is edited in code (src/editor/nodeCapability.ts).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Page IPC
// ---------------------------------------------------------------------------

export function parsePageSource(pagePath: string, source: string): IpcResults['page:parse'] {
  if (isMarkdownPage(pagePath)) {
    return { ...parseMarkdownPage(source, { mdx: isMdx(pagePath) }), source };
  }
  const parsed = parsePage(source, { locs: true });
  if (parsed.editable) {
    resolveChunks(parsed.model, pagePath, { locs: true });
  }
  return { ...parsed, source };
}

// What a write that did not happen, or may have, means to the renderer's save
// state (plan §7). A refusal is the edit's own (`rejected`, pageEditError).
export function pageWriteFailure(file: string, report: Extract<WriteReport, { readonly tag: 'uncertain' | 'backpressured' }>): WirePageWriteFailure {
  const name = path.basename(file);
  switch (report.tag) {
    case 'uncertain':
      return {
        code: 'uncertain',
        message: translateMain('error.documents.saveUncertainCheck', { file: name, check: report.reconciliation ?? 'unreadable' }),
      };
    case 'backpressured':
      return { code: 'backpressured', message: describeWriteReport(name, report) };
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}

export function pageEditError(file: string, report: Exclude<EditReport, { readonly tag: 'applied' }>): WirePageEditError {
  if (report.tag === 'rejected') {
    const { reason, diskChecksum } = report;
    const message = report.message === '' ? describeRejection(reason) : report.message;
    // A disk failure says nothing about whether the gesture is supported. Keep
    // it queued for the next save instead of withdrawing the user's text.
    if (reason === 'write-failed') {
      return { code: 'filesystem', message };
    }
    if (reason === 'write-race') {
      return { code: 'write-race', message };
    }
    return { code: 'rejected', reason, message, diskChecksum };
  }
  return pageWriteFailure(file, report);
}

// Folder management under src/pages. Renames are same-parent only (from the
// UI), so contained files keep their relative-import depth.
export const resolvePagesDirectory = (projectPath: string, rel: string) => {
  const pagesDirectory = path.join(projectPath, 'src', 'pages');
  const full = path.resolve(pagesDirectory, rel);
  if (!isPathWithin(pagesDirectory, full)) {
    throw new Error('Invalid folder.');
  }
  return full;
};

// Fill a route pattern in with one entry's params: /posts/[slug] + {slug:'a'}
// → /posts/a. A rest param ([...path]) holds a whole segment run, and an
// undefined one collapses rather than writing "undefined" into the URL.
export function fillRoute(pattern: string, params: Readonly<Record<string, unknown>>) {
  const filled = pattern.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_match: string, _rest: string | undefined, name: string) => {
    // Dev-server JSON writes null for a missing param, as absent as undefined.
    const value = params?.[name];
    if (value === undefined) {
      return '';
    }
    if (value === null) {
      return '';
    }
    return String(value)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  });
  // A dropped rest param leaves a double slash or a trailing one behind.
  return filled.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
}

// ---------------------------------------------------------------------------
// Copy Selection (⇧⌘C)
//
// What the canvas has selected, as the editing-hierarchy trail that leads to
// it: the page, then the instance of each component drilled into, then the
// node itself — each entry a `<file>:<lines>` pointer. Pasted into an AI chat
// that can read the project, that trail is the one thing it can't work out for
// itself.
//
// Resolved on demand from the keys the renderer hands over, so nothing is
// stored here and nothing is written to the user's project.
// ---------------------------------------------------------------------------

// Turns "<file>#<path>" node keys into "<file>:<line>" / "<file>:<from>-<to>"
// pointers, project-relative. Returns undefined when there's nothing to point at.
export function selectionTrail(state: IpcPayloads['selection:copy']) {
  if (!state || !state.projectPath || !Array.isArray(state.keys)) {
    return undefined;
  }
  const root = path.resolve(state.projectPath);
  const trail: string[] = [];
  for (const key of state.keys) {
    const hash = typeof key === 'string' ? key.indexOf('#') : -1;
    if (hash === -1) {
      continue;
    }
    // The key's file half is renderer input; keep it inside the project.
    const abs = path.resolve(root, key.slice(0, hash));
    if (!isPathWithin(root, abs)) {
      continue;
    }
    const at = locateSelection(abs, key.slice(hash + 1));
    if (!at) {
      continue;
    }
    const file = toPosix(path.relative(root, at.file));
    if (!('startLine' in at)) {
      trail.push(file);
    } else if (at.startLine === at.endLine) {
      trail.push(`${file}:${at.startLine}`);
    } else {
      trail.push(`${file}:${at.startLine}-${at.endLine}`);
    }
  }
  return trail.length ? trail : undefined;
}
