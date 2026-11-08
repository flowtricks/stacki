// The dev preview's source markers, made in memory (plan §9, step 7).
//
// The generated preview config (preview/markerConfig.ts, MARKER_CONFIG_PARTS) hands Astro a
// marked copy of every .astro file under src as Vite loads it: each node sits
// between <!--avb-s:path--> / <!--avb-e:path--> comments, and each file carries
// one stamp, <!--avb-d:<checksum>:<file>-->, naming the exact bytes it was
// marked from (shared/page/previewToken.ts). The marked text exists only as the
// module Vite compiles. This module reads project files and returns strings; it
// never writes, and nothing that writes project text imports it — so no marker
// can change what the project itself builds or serves. The single-writer
// contract test holds both halves.
//
// It runs inside the project's dev server, a plain Node process, so it is
// unpacked beside the archive (package.json build.asarUnpack) and requires only
// modules that are.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { isDefaultsCanvas } from '../../shared/properties/defaultsCanvas';
import { toDigest } from '../../shared/core/brand';
import { LIMITS } from '../../shared/core/limits';
import { stampComment, stampPathProblem, type PreviewStamp } from '../../shared/page/previewToken';
import { markChunkHtml, parsePage, resolveChunks, serializePageMarked } from '../parse/astroParser';
import { withScopeCapture } from './scopeCapture';
import { parseVariantHeader, VARIANT_HEADER, VARIANT_SCOPE_GLOBAL, withVariantOverride, type VariantOverride } from '../../shared/page/variantOverride';

export interface MarkedSource {
  /** The marked template Vite compiles in place of the file. */
  readonly code: string;
  /** The file's own text, for the dev plugin's style-block comparison. */
  readonly source: string;
  /** A page under src/pages: it also gets the canvas patcher. */
  readonly page: boolean;
  /** The file's project-relative path, as its stamp names it. */
  readonly file: string;
}

/** The marked copy of `file`, or undefined when it is not a project .astro file the
 * parser can mark — Vite then loads it unchanged, with no markers and no stamp,
 * and nothing on the canvas can address a node inside it. */
export function markSourceFile(file: string, projectDirectories: readonly string[]): MarkedSource | undefined {
  if (!file.endsWith('.astro')) {
    return undefined;
  }
  // Pages mark with bare paths; every other .astro under src — components and
  // layouts — with its own namespace, so selecting inside one outlines too.
  const projectFile = projectDirectories
    .map((directory) => ({
      directory,
      relative: path.relative(directory, file).split(path.sep).join('/'),
    }))
    .find(({ relative }) => relative.startsWith('src/') || isDefaultsCanvas(relative));
  if (projectFile === undefined) {
    return undefined;
  }
  const bytes = readFileSync(file);
  if (LIMITS.sourceBytesMax < bytes.length) {
    return undefined; // Past the file bound: the editor shows it as code, not nodes.
  }
  const source = bytes.toString('utf8');
  // Located, so the marked copy takes the whitespace between nodes from the
  // file itself and renders exactly the spaces the real build does
  // (astroSerializeMarked.ts, MarkedSource).
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    return undefined;
  }
  resolveChunks(parsed.model, file);
  const relativePath = projectFile.relative;
  assert(stampPathProblem(relativePath) === undefined, 'A file under src has a project-relative path');
  const page = relativePath.startsWith('src/pages/') || isDefaultsCanvas(relativePath);
  const checksum = toDigest(createHash('sha256').update(bytes).digest('hex'));
  const stamp: PreviewStamp = { file: relativePath, checksum };
  const marked = serializePageMarked(parsed.model, page ? '' : `${relativePath}|`, stamp, source);
  assert(marked.endsWith('\n'), 'The marked serializer ends on a line of its own');
  // The frontmatter files what it computed under this path as it finishes, so
  // the binding picker can show a loop's real items (scopeCapture.ts).
  const captured = withScopeCapture(marked, relativePath);
  assert(captured.endsWith('\n'), 'The scope capture keeps the template’s last line');
  // Last, at the top level of the file's template, where the compiler keeps a
  // plain comment: after `</html>` for a page, which leaves the doctype alone.
  // Against the last node, like every marker, so it adds no line break the
  // file doesn't end with — unless the template is empty and the last line is
  // the frontmatter's closing fence, which must stay a line of its own.
  const template = captured.endsWith('---\n') ? captured : captured.slice(0, -1);
  return { code: `${template}${stampComment(stamp)}\n`, source, page, file: relativePath };
}

/**
 * The marked copy Desktop's canvas compiles: markSourceFile's, and a component
 * (never a page) also checks the hover-preview scope as it starts, so one of
 * its instances can render with one prop changed (shared/page/variantOverride.ts).
 */
export function markCanvasSourceFile(file: string, projectDirectories: readonly string[]): MarkedSource | undefined {
  const marked = markSourceFile(file, projectDirectories);
  if (marked === undefined || marked.page) {
    return marked;
  }
  const code = withVariantOverride(marked.code, marked.file);
  assert(code.length > marked.code.length, 'markCanvasSourceFile: the preview check is added');
  return { ...marked, code };
}

// One scope per dev server process, on the global every component module reads
// it from: the middleware below runs a preview request inside it, and the
// statement withVariantOverride adds reads it during that request's render.
const variantScope = new AsyncLocalStorage<VariantOverride>();
Reflect.set(globalThis, VARIANT_SCOPE_GLOBAL, variantScope);

/**
 * The dev server middleware for hover previews: a request that carries a valid
 * override header renders inside the override's scope; any other request,
 * including one whose header does not parse, renders as written. It renders
 * only; nothing here can write.
 */
export function variantScopeMiddleware(request: IncomingMessage, _response: ServerResponse, next: () => void): void {
  const override = parseVariantHeader(request.headers[VARIANT_HEADER]);
  if (override === undefined) {
    next();
    return;
  }
  assert(override.prop.length > 0, 'variantScopeMiddleware: an override names its prop');
  variantScope.run(override, next);
}

/** The marked copy of a chunk imported as `?raw` (see serializePageMarked's
 * chunk marks), or undefined when it cannot be marked. A `group` chunk also
 * gets a marker pair of its own, since nothing in the page wraps it. */
export function markChunkFile(file: string, prefix: string, { group }: { readonly group: boolean }): string | undefined {
  const bytes = readFileSync(file);
  if (LIMITS.sourceBytesMax < bytes.length) {
    return undefined;
  }
  return markChunkHtml(bytes.toString('utf8'), prefix, { group });
}
