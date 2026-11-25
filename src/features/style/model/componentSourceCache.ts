// The source text of component files the Style panel reads for their markup.
//
// A component instance selected on a page is green for the classes its component
// writes (componentMarkup.ts), which needs the component file's text. A component
// with a `<style is:global>` is already loaded for its styles; any other is read
// here, once per file, through the same main-process read the stylesheets use.
// The cache is small and bounded, a file is dropped when the project reports it
// changed, and a read that fails is remembered as failed rather than retried on
// every render (it is retried after the file next changes).

import { assert } from '../../../../shared/core/assert';
import { variableEdit } from '../../../ipc/variableEditBridge';

/**
 * At most this many component files are held. A session selects instances of a
 * few dozen components; past the cap the oldest read is dropped and read again
 * when next needed.
 */
export const COMPONENT_SOURCES_MAX = 32;

type Entry = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly code: string } | { readonly kind: 'failed' };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;

/**
 * The file's text when it has been read; undefined while it is read (a change is
 * announced when it lands) or when it could not be. The first ask starts the read.
 */
export function componentSource(path: string): string | undefined {
  assert(path.length > 0, 'componentSource: a path is never empty');
  const key = keyOf(path);
  const entry = entries.get(key);
  if (entry === undefined) {
    store(key, { kind: 'loading' });
    void variableEdit('readStyleFile', path).then(
      (result) => store(key, result.ok ? { kind: 'ready', code: result.css ?? '' } : { kind: 'failed' }),
      () => store(key, { kind: 'failed' }),
    );
    return undefined;
  }
  return entry.kind === 'ready' ? entry.code : undefined;
}

/**
 * Whether the file's text is on its way: asked and not landed. A file never asked
 * for is asked now, so it is on its way too. A chip whose colour waits on it keeps its
 * remembered colour meanwhile (chipProvenanceMemory.ts).
 */
export function componentSourcePending(path: string): boolean {
  const known = componentSource(path) !== undefined;
  if (known) {
    return false;
  }
  return entries.get(keyOf(path))?.kind === 'loading';
}

/**
 * Reads the files of the components a page uses as the page loads, so the first
 * instance selected is drawn in its settled colours. At most the cache's bound is
 * asked for; a file already held or on its way is not read again.
 */
export function prefetchComponentSources(paths: readonly string[]): void {
  for (const path of paths.slice(0, COMPONENT_SOURCES_MAX)) {
    if (path.length > 0) {
      componentSource(path);
    }
  }
}

/** Holds a file's text as if it had been read: a read landing, and tests. */
export function rememberComponentSource(path: string, code: string): void {
  store(keyOf(path), { kind: 'ready', code });
}

/** Drops the files the project reports changed; every file when it names none. */
export function forgetComponentSources(paths: readonly string[]): void {
  if (paths.length === 0) {
    if (entries.size > 0) {
      entries.clear();
      announce();
    }
    return;
  }
  let dropped = false;
  for (const path of paths) {
    dropped = entries.delete(keyOf(path)) || dropped;
  }
  if (dropped) {
    announce();
  }
}

/** Bumped whenever a file's text arrives or is dropped, for memos to depend on. */
export function componentSourceVersion(): number {
  return version;
}

export function onComponentSourceChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function store(key: string, entry: Entry): void {
  if (!entries.has(key) && entries.size >= COMPONENT_SOURCES_MAX) {
    // Maps keep insertion order, so the first key is the oldest read.
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  }
  entries.set(key, entry);
  assert(entries.size <= COMPONENT_SOURCES_MAX, 'componentSourceCache: bounded by COMPONENT_SOURCES_MAX');
  if (entry.kind !== 'loading') {
    announce();
  }
}

function announce(): void {
  version += 1;
  for (const listener of [...listeners]) {
    listener();
  }
}

function keyOf(path: string): string {
  return path.replaceAll('\\', '/');
}
