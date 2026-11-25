// Reading pages an app has not opened (docs/apps.md, "Reading other pages"):
// `page.getTree` reads one page or component from disk, `page.findByAttribute`
// scans them all for elements carrying an attribute. Each host supplies the
// files and how to read one (Desktop: the main process's parser over IPC;
// Studio: its server's file read and the same parser in the browser); this
// module bounds and caches the reading, so Desktop and Studio answer alike.
//
// Bounds: at most APP_RPC_LIMITS.indexFilesMax files are considered, one call
// reads at most indexBytesReadMax bytes from disk, and findByAttribute answers
// at most attributeMatchesMax matches. Parsed trees are cached by each file's
// modification time and size, so a second scan reads only what changed; a scan
// cut short by the byte budget says so (`truncated`), and the next call carries
// on where the cache leaves off.
//
// The open page is never read from disk: its live tree (with the session's
// node ids) answers for it, so an id from either method selects on the canvas.
import { assert } from '../../../shared/core/assert';
import { APP_RPC_LIMITS, type AppAttributeMatch, type AppNodeView, type AppPageView } from '../../../shared/properties/appsRpc';

/** A file's modification stamp: what the cache is keyed by. */
export interface AppFileStamp {
  readonly mtimeMs: number;
  readonly sizeBytes: number;
}

/** A file read from disk and parsed: ids as opening the file would give them. */
export interface AppDiskTree {
  readonly editable: boolean;
  readonly nodes: readonly AppNodeView[];
  readonly truncated: boolean;
}

/** What a host supplies. */
export interface AppPageFiles {
  /** The project's pages and components, relative to the project. */
  readonly list: () => readonly string[];
  /** Each file's stamp, in order, in one round trip; undefined for a file that is gone. */
  readonly stamps: (paths: readonly string[]) => Promise<readonly (AppFileStamp | undefined)[]>;
  /** Reads and parses one file; undefined when it cannot be read. */
  readonly readTree: (path: string) => Promise<AppDiskTree | undefined>;
}

export interface AppAttributeSearch {
  readonly matches: readonly AppAttributeMatch[];
  /** Whether the answer may be missing matches: the limit was reached, or files were left for the next call. */
  readonly truncated: boolean;
}

export interface AppPageIndex {
  readonly getTree: (path: string, open: AppPageView | undefined) => Promise<AppPageView | undefined>;
  readonly findByAttribute: (name: string, limit: number, open: AppPageView | undefined) => Promise<AppAttributeSearch>;
}

interface CacheEntry {
  readonly stamp: AppFileStamp;
  readonly tree: AppDiskTree | undefined;
}

export function createAppPageIndex(files: AppPageFiles): AppPageIndex {
  const cache = new Map<string, CacheEntry>();
  const known = (): readonly string[] => {
    const listed = files.list().slice(0, APP_RPC_LIMITS.indexFilesMax);
    // Forget files no longer in the project, so the cache is bounded by the list.
    for (const path of [...cache.keys()]) {
      if (!listed.includes(path)) {
        cache.delete(path);
      }
    }
    assert(cache.size <= APP_RPC_LIMITS.indexFilesMax, 'The tree cache is bounded by the files considered');
    return listed;
  };
  // The tree for `path` at `stamp`: the cache's when the stamp matches, else read when the budget allows.
  const treeAt = async (path: string, stamp: AppFileStamp, budget: ByteBudget): Promise<CacheEntry | 'over-budget'> => {
    const cached = cache.get(path);
    if (cached !== undefined && sameStamp(cached.stamp, stamp)) {
      return cached;
    }
    if (!budget.take(stamp.sizeBytes)) {
      return 'over-budget';
    }
    const entry: CacheEntry = { stamp, tree: await files.readTree(path) };
    cache.set(path, entry);
    return entry;
  };
  return {
    getTree: async (path, open) => {
      if (open?.path === path) {
        return open;
      }
      if (!known().includes(path)) {
        return undefined;
      }
      const [stamp] = await files.stamps([path]);
      if (stamp === undefined) {
        cache.delete(path);
        return undefined;
      }
      const entry = await treeAt(path, stamp, byteBudget(APP_RPC_LIMITS.indexBytesReadMax));
      if (entry === 'over-budget') {
        throw new Error(`${path} is larger than an app may read at once`);
      }
      const tree = entry.tree;
      return tree === undefined ? undefined : { path, editable: tree.editable, nodes: tree.nodes, truncated: tree.truncated };
    },
    findByAttribute: async (name, limit, open) => {
      assert(limit > 0, 'A search answers at least one match');
      assert(limit <= APP_RPC_LIMITS.attributeMatchesMax, 'A search is bounded by attributeMatchesMax');
      const paths = known();
      const stamps = await files.stamps(paths);
      assert(stamps.length === paths.length, 'The host stamps every file asked about');
      const budget = byteBudget(APP_RPC_LIMITS.indexBytesReadMax);
      const matches: AppAttributeMatch[] = [];
      let truncated = files.list().length > paths.length;
      for (const [index, path] of paths.entries()) {
        if (matches.length < limit) {
          const nodes = await nodesOf(path, stamps[index], open, budget, treeAt);
          if (nodes === 'over-budget') {
            truncated = true;
          } else {
            const found = attributeMatches(path, nodes, name, limit - matches.length);
            matches.push(...found.matches);
            truncated ||= found.truncated;
          }
        } else {
          truncated = true;
          break;
        }
      }
      assert(matches.length <= limit, 'A search answers at most its limit');
      return { matches, truncated };
    },
  };
}

async function nodesOf(
  path: string,
  stamp: AppFileStamp | undefined,
  open: AppPageView | undefined,
  budget: ByteBudget,
  treeAt: (path: string, stamp: AppFileStamp, budget: ByteBudget) => Promise<CacheEntry | 'over-budget'>,
): Promise<readonly AppNodeView[] | 'over-budget'> {
  if (open?.path === path) {
    return open.nodes;
  }
  if (stamp === undefined) {
    return [];
  }
  const entry = await treeAt(path, stamp, budget);
  if (entry === 'over-budget') {
    return entry;
  }
  return entry.tree?.nodes ?? [];
}

/** Elements of one tree carrying `name`, in document order, at most `limit`. */
export function attributeMatches(
  path: string,
  roots: readonly AppNodeView[],
  name: string,
  limit: number,
): { readonly matches: readonly AppAttributeMatch[]; readonly truncated: boolean } {
  const matches: AppAttributeMatch[] = [];
  // Depth first, in document order; iterative, and bounded by the tree bound replies already carry.
  const stack = [...roots].reverse();
  for (let visited = 0; stack.length > 0; visited += 1) {
    assert(visited < APP_RPC_LIMITS.treeNodesMax * 2, 'A tree walk is bounded by the reply bound');
    const node = stack.pop();
    if (node === undefined) {
      break;
    }
    const value = Object.hasOwn(node.attributes, name) ? node.attributes[name] : undefined;
    if (value !== undefined) {
      if (matches.length < limit) {
        matches.push({ path, nodeId: node.id, value });
      } else {
        return { matches, truncated: true };
      }
    }
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const child = node.children[index];
      if (child !== undefined) {
        stack.push(child);
      }
    }
  }
  return { matches, truncated: false };
}

/** Bytes one call may still read from disk. */
interface ByteBudget {
  /** Spends `sizeBytes` and answers true, or answers false and spends nothing when too few are left. */
  readonly take: (sizeBytes: number) => boolean;
}

function byteBudget(bytesMax: number): ByteBudget {
  let left = bytesMax;
  return {
    take: (sizeBytes) => {
      assert(sizeBytes >= 0, 'A file has a nonnegative size');
      if (sizeBytes > left) {
        return false;
      }
      left -= sizeBytes;
      return true;
    },
  };
}

function sameStamp(left: AppFileStamp, right: AppFileStamp): boolean {
  return left.mtimeMs === right.mtimeMs && left.sizeBytes === right.sizeBytes;
}
