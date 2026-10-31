// The order a site's own Sanity Studio lists its collections in.
//
// Sanity does not keep that order in the dataset: it is the Studio's code — a
// structure resolver (`structureTool({ structure })`) whose `.items([…])` lists
// types one after another, by name, as `S.documentTypeListItem("booklet")` or a
// helper such as `orderable("booklet", "Booklets")`. So it is read from that
// code: in each file that imports `sanity/structure`, the `.items([…])` list
// that names the most of the dataset's collections — the full sidebar, rather
// than a nested pane's list or a narrower one for restricted editors — scanned
// in order for quoted names; an entry that is a helper call —
// `spiritualDevelopment()` — is read from the helper's own definition. Quoted
// names elsewhere in the file (queries, comments) are not the sidebar's. A type
// the Studio does not name keeps its place after the ones it does. Nothing is
// run; a project without a Studio has no order to give.

import fs from 'node:fs';
import path from 'node:path';

// Files looked at, how deep, and how large one may be before it is skipped.
const STRUCTURE_LIMITS = { filesMax: 400, depthMax: 6, fileBytesMax: 512 * 1024 } as const;
const SOURCE = /\.(ts|tsx|js|jsx|mjs|mts)$/;
const SKIPPED = new Set(['node_modules', 'dist', '.astro', '.git', '.stacki', 'public']);

/** Collection names in the order the Studio's structure names them. */
export function sanityStructureOrder(projectRoot: string, types: readonly string[]): string[] {
  const order: string[] = [];
  for (const file of structureFiles(projectRoot)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of sidebarNames(text, types)) {
      if (!order.includes(name)) {
        order.push(name);
      }
    }
  }
  return order;
}

// Helper definitions read when an items list calls one, and how much of each.
const HELPER_CHARS_MAX = 4000;
const TOKEN = /["'`]([A-Za-z_][\w.-]{0,127})["'`]|\b([A-Za-z_]\w*)\(\)/g;

// The collections an `.items([…])` list names, in order, helper calls read from
// their definitions; of every such list in the file, the one naming the most.
function sidebarNames(text: string, types: readonly string[]): string[] {
  let best: string[] = [];
  for (const list of itemsLists(text)) {
    const names = namesIn(text, list).filter((name) => types.includes(name));
    if (new Set(names).size > new Set(best).size) {
      best = names;
    }
  }
  return best;
}

function namesIn(text: string, list: string): string[] {
  const out: string[] = [];
  for (const match of list.matchAll(TOKEN)) {
    const quoted = match[1];
    const helper = match[2];
    if (quoted !== undefined) {
      out.push(quoted);
    } else if (helper !== undefined) {
      out.push(...helperNames(text, helper));
    }
  }
  return out;
}

// Every `.items([` … `])` in the file, by bracket depth (strings are not
// tracked: a bracket inside a quoted title is rare and only shifts order).
const ITEMS_LISTS_MAX = 64;

function itemsLists(text: string): string[] {
  const lists: string[] = [];
  let from = 0;
  for (let count = 0; count < ITEMS_LISTS_MAX; count++) {
    const start = text.indexOf('.items([', from);
    if (start === -1) {
      break;
    }
    const list = bracketed(text, start);
    if (list !== undefined) {
      lists.push(list);
    }
    from = start + 1;
  }
  return lists;
}

function bracketed(text: string, start: number): string | undefined {
  let depth = 0;
  for (let index = start + '.items('.length; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === '[') {
      depth += 1;
    } else if (char === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index);
      }
    }
  }
  return undefined;
}

// A helper's own definition: from its line to the next line indented as far as
// it is (the next statement beside it), at most HELPER_CHARS_MAX.
function helperNames(text: string, helper: string): string[] {
  const definition = new RegExp(
    `^([ \\t]*)(?:export\\s+)?(?:const|let|function)\\s+${helper}\\b`,
    'm',
  ).exec(text);
  if (!definition) {
    return [];
  }
  const indent = definition[1] ?? '';
  const start = definition.index;
  const rest = text.slice(start + definition[0].length, start + HELPER_CHARS_MAX);
  const next = new RegExp(`\\n${indent}(?=\\S)`).exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return [...body.matchAll(TOKEN)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

/** `names` sorted by a structure order; names it does not mention keep theirs, after. */
export function inStructureOrder(names: readonly string[], order: readonly string[]): string[] {
  const place = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return [...names].sort((left, right) => place(left) - place(right));
}

// The project's source files that build a Studio structure, breadth first.
function structureFiles(projectRoot: string): string[] {
  return projectSourceFiles(projectRoot, (text) => /from\s+["']sanity\/structure["']/.test(text));
}

/** The project's own source files whose text passes `test`, breadth first and bounded. */
export function projectSourceFiles(projectRoot: string, test: (text: string) => boolean): string[] {
  const out: string[] = [];
  const queue: { readonly directory: string; readonly depth: number }[] = [
    { directory: projectRoot, depth: 0 },
  ];
  let visited = 0;
  for (let at = 0; at < queue.length && visited < STRUCTURE_LIMITS.filesMax; at++) {
    const next = queue[at];
    if (next === undefined) {
      break;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(next.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(next.directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name) && next.depth < STRUCTURE_LIMITS.depthMax) {
          queue.push({ directory: full, depth: next.depth + 1 });
        }
      } else if (SOURCE.test(entry.name) && (visited += 1) <= STRUCTURE_LIMITS.filesMax) {
        if (passes(full, test)) {
          out.push(full);
        }
      }
    }
  }
  return out;
}

function passes(file: string, test: (text: string) => boolean): boolean {
  try {
    if (fs.statSync(file).size > STRUCTURE_LIMITS.fileBytesMax) {
      return false;
    }
    return test(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}
