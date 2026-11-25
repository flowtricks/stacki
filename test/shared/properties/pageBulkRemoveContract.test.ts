// Goal: what crosses IPC for the Pages panel's Select mode is read at the boundary, and a malformed or oversized
// request never reaches the planner.
// Method: one known-good request and tables of known-bad shapes for the request, the summary and the reply, through
// both the contract's own parsers and the channel's payload parser, with each bound tested on both sides.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  PAGE_BULK_REMOVE_LIMITS,
  parsePageBulkRemoveApplied,
  parsePageBulkRemoveRequest,
  parsePageBulkRemoveSummary,
} from '#dist/shared/properties/pageBulkRemove.js';

const IMPACT = { files: 0, links: 2, moves: [], reviews: [{ file: 'src/pages/a.astro', line: 3, text: '<a href="/about">' }], reviewsMore: 0 };
const SUMMARY = { pages: 3, folders: 1, errorPages: 1, impact: IMPACT };

test('a request names pages and folders under src/pages and parses to itself', () => {
  const request = { pages: ['about.astro', 'blog/post.mdx', 'blog/[slug].md'], folders: ['old', 'a/b'] };
  assert.deepEqual(parsePageBulkRemoveRequest(request), request);
  assert.deepEqual(parsePageBulkRemoveRequest({ pages: [], folders: ['old'] }), { pages: [], folders: ['old'] });
  assert.deepEqual(parseIpcPayload('page:planRemoveMany', { projectPath: '/site', request }), { projectPath: '/site', request });
  assert.deepEqual(parseIpcPayload('page:removeMany', { projectPath: '/site', request }), { projectPath: '/site', request });
});

test('a request that could leave src/pages, repeat itself or ask for nothing is refused', () => {
  const bad: readonly unknown[] = [
    undefined,
    'about.astro',
    [],
    {},
    { pages: [], folders: [] },
    { pages: 'about.astro', folders: [] },
    { pages: ['about.astro'] },
    { pages: ['../secret.astro'], folders: [] },
    { pages: ['/etc/passwd.astro'], folders: [] },
    { pages: ['a//b.astro'], folders: [] },
    { pages: ['a\\b.astro'], folders: [] },
    { pages: ['about.txt'], folders: [] },
    { pages: ['about'], folders: [] },
    { pages: [7], folders: [] },
    { pages: [], folders: [''] },
    { pages: [], folders: ['..'] },
    { pages: [], folders: ['a/../b'] },
    { pages: ['about.astro', 'about.astro'], folders: [] },
    { pages: [], folders: ['old', 'old'] },
    { pages: ['bad\0.astro'], folders: [] },
  ];
  for (const request of bad) {
    assert.throws(() => parsePageBulkRemoveRequest(request), JSON.stringify(request));
    assert.throws(() => parseIpcPayload('page:removeMany', { projectPath: '/site', request }), JSON.stringify(request));
  }
  assert.throws(() => parseIpcPayload('page:removeMany', { request: { pages: ['a.astro'], folders: [] } }));
});

test('the bounds hold on both sides', () => {
  const pages = (count: number) => Array.from({ length: count }, (_, index) => `p${index}.astro`);
  const folders = (count: number) => Array.from({ length: count }, (_, index) => `f${index}`);
  assert.equal(parsePageBulkRemoveRequest({ pages: pages(PAGE_BULK_REMOVE_LIMITS.pagesMax), folders: [] }).pages.length, PAGE_BULK_REMOVE_LIMITS.pagesMax);
  assert.throws(() => parsePageBulkRemoveRequest({ pages: pages(PAGE_BULK_REMOVE_LIMITS.pagesMax + 1), folders: [] }), /too many pages/);
  assert.equal(
    parsePageBulkRemoveRequest({ pages: [], folders: folders(PAGE_BULK_REMOVE_LIMITS.foldersMax) }).folders.length,
    PAGE_BULK_REMOVE_LIMITS.foldersMax,
  );
  assert.throws(() => parsePageBulkRemoveRequest({ pages: [], folders: folders(PAGE_BULK_REMOVE_LIMITS.foldersMax + 1) }), /too many folders/);
  assert.throws(() => parsePageBulkRemoveRequest({ pages: [`${'a/'.repeat(40)}x.astro`], folders: [] }), 'a path is at most 32 levels');
});

test('a summary and a reply are read back whole, and one that cannot be true is refused', () => {
  assert.deepEqual(parsePageBulkRemoveSummary(SUMMARY), SUMMARY);
  assert.deepEqual(parsePageBulkRemoveApplied({ summary: SUMMARY, undo: 'page-settings-4' }), { summary: SUMMARY, undo: 'page-settings-4' });
  const bad: readonly unknown[] = [
    undefined,
    { ...SUMMARY, pages: -1 },
    { ...SUMMARY, pages: 1.5 },
    { ...SUMMARY, pages: PAGE_BULK_REMOVE_LIMITS.pagesMax + 1 },
    { ...SUMMARY, folders: PAGE_BULK_REMOVE_LIMITS.foldersMax + 1 },
    { ...SUMMARY, errorPages: SUMMARY.pages + 1 },
    { ...SUMMARY, impact: { ...IMPACT, moves: [{ from: 'src/pages/a.astro', to: 'src/pages/b.astro' }] } },
    { ...SUMMARY, impact: undefined },
    { pages: 1, folders: 0 },
  ];
  for (const summary of bad) {
    assert.throws(() => parsePageBulkRemoveSummary(summary), JSON.stringify(summary));
  }
  for (const undo of ['', 'x'.repeat(65), 7, undefined]) {
    assert.throws(() => parsePageBulkRemoveApplied({ summary: SUMMARY, undo }), String(undo));
  }
});
