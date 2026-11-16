// The pre-flight gate of main's document actors (shared/engine/preflight.ts, docs/error-proofing.md):
// every candidate `.astro` file is parsed by the real parser and compared with the file before the
// edit, and a gesture that would ADD an error is refused before a byte is written. Typed code is
// advised, never blocked (the operation table says which is which).
//
// Cost: two parses per checked write at most, each memoised by checksum in a small cache (the base
// is usually the previous write's candidate), and one walk of the tree. The time of every pass is
// measured; a pass over the budget is logged so a slow file is seen, never silently paid for.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { decodeUtf8 } from '../../shared/core/span';
import type { PreflightGate } from '../../shared/engine/documentActor';
import { PREFLIGHT_CHECKS, preflightVerdict, type ImportResolver, type PreflightFile } from '../../shared/engine/preflight';
import type { Snapshot } from '../../shared/page/snapshot';
import { ENGLISH_TRANSLATE } from '../../shared/properties/i18n/englishTranslator';
import { preflightFindingText, preflightRefusalText } from '../../shared/ipc/preflightMessages';
import { parsePage } from '../parse/astroParser';
import { parsePageResult } from '../../shared/page/pageNode';

export const DOCUMENT_PREFLIGHT_LIMITS = {
  /** Parsed files kept by checksum: a base and its candidate, for a few files edited in turn. */
  cachedFilesMax: 16,
  /** A pass slower than this is logged (docs/error-proofing.md: the real-time budget). */
  passMsBudget: 50,
} as const satisfies Record<string, number>;

// Extensions a bare relative specifier may resolve to, in Vite's order.
const RESOLVED_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.astro', '.json', '/index.ts', '/index.js', '/index.astro'] as const;

/** The gate, with the disk check for import targets and a log line for advice and slow passes. */
export function createDocumentPreflight(options: { readonly log: (line: string) => void; readonly exists?: (file: string) => boolean }): PreflightGate {
  const cache = new Map<Digest, PreflightFile | undefined>();
  const exists = options.exists ?? ((file: string): boolean => fs.existsSync(file));
  const resolve: ImportResolver = (fromPath, specifier) => resolvedImport(fromPath, specifier, exists);
  const fileOf = (snapshot: Snapshot): PreflightFile | undefined => {
    if (cache.has(snapshot.checksum)) {
      return cache.get(snapshot.checksum);
    }
    const read = readable(snapshot);
    if (cache.size >= DOCUMENT_PREFLIGHT_LIMITS.cachedFilesMax) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(snapshot.checksum, read);
    assert(cache.size <= DOCUMENT_PREFLIGHT_LIMITS.cachedFilesMax, 'The pre-flight cache stays bounded');
    return read;
  };
  return (base, candidate, operation) => {
    if (!/\.astro$/i.test(candidate.path)) {
      return { tag: 'pass' };
    }
    if (PREFLIGHT_CHECKS[operation.tag].policy === 'advise') {
      // Typed code is never held, so its write does not pay for a parse on the keystroke path; the
      // compile-error recovery speaks for it once the server renders.
      return { tag: 'pass' };
    }
    const started = performance.now();
    const after = fileOf(candidate);
    if (after === undefined) {
      return { tag: 'pass' }; // A candidate that does not parse is the candidate check's to refuse, and it has.
    }
    const verdict = preflightVerdict(operation.tag, { before: fileOf(base), after }, resolve);
    const elapsedMs = performance.now() - started;
    if (elapsedMs > DOCUMENT_PREFLIGHT_LIMITS.passMsBudget) {
      options.log(`preflight slow ${operation.tag} ${Math.round(elapsedMs)}ms`);
    }
    if (!verdict.ok) {
      options.log(`preflight refused ${operation.tag} ${verdict.error.findings.map((finding) => finding.code).join(',')}`);
      return { tag: 'refuse', message: preflightRefusalText(verdict.error.findings, ENGLISH_TRANSLATE) };
    }
    if (verdict.value.length > 0) {
      // Warnings of a gesture that went ahead: on record beside the compile-error recovery.
      options.log(`preflight warned ${operation.tag} ${verdict.value.map((finding) => preflightFindingText(finding, ENGLISH_TRANSLATE)).join(' | ')}`);
    }
    return { tag: 'pass' };
  };
}

function readable(snapshot: Snapshot): PreflightFile | undefined {
  const text = decodeUtf8(snapshot.bytes);
  if (!text.ok) {
    return undefined;
  }
  try {
    // Validated at the parser boundary, as every snapshot's model is (documentDisk.ts).
    const parsed = parsePageResult(parsePage(text.value, {}));
    return parsed.editable ? { path: snapshot.path, model: parsed.model } : undefined;
  } catch {
    return undefined; // The parser's own failure is reported by the candidate check, never here.
  }
}

/** Whether a relative import names a file on disk, the way Vite would look for it. */
export function resolvedImport(fromPath: string, specifier: string, exists: (file: string) => boolean): 'exists' | 'missing' | 'unknown' {
  if (!specifier.startsWith('.') || /[?#*]/.test(specifier)) {
    return 'unknown';
  }
  const target = path.resolve(path.dirname(fromPath), specifier);
  if (exists(target)) {
    return 'exists';
  }
  if (path.extname(specifier) !== '' && !/\.(js|mjs)$/.test(specifier)) {
    return 'missing';
  }
  // `./util.js` is often `./util.ts` written the TypeScript way; a bare name may take any extension.
  const stem = target.replace(/\.(js|mjs)$/, '');
  return RESOLVED_EXTENSIONS.some((extension) => exists(`${stem}${extension}`)) ? 'exists' : 'missing';
}
