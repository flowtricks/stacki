// Reading a project's custom properties: the stylesheets that hold them, and
// each rule's declarations and comments in source order (cssVars.ts).

import { variableFiles as fs } from './variableWorkspace';
import path from 'path';
import postcss from 'postcss';
import type { Declaration, Rule as PostcssRule } from 'postcss';
import { commentLabel } from '../../shared/page/commentLabel';
import { PROJECT_FOLDERS_FILE, configOf, foldersFor, readProjectFoldersSource } from '../../shared/properties/projectFolders';

// Folders deeper than the stylesheet bound are not where a project keeps its CSS; the rename walk
// covers the whole project, where a config or a helper module can sit two levels deeper. A
// `var()` chain longer than the resolve bound is shown as written rather than followed.
export const CSS_VARIABLE_LIMITS = {
  stylesheetDepthMax: 8,
  renameTargetDepthMax: 10,
  resolveDepthMax: 8,
} as const;

export const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', '.git', '.astro', '.stacki']);

export const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

// --- reading ---------------------------------------------------------------

export function findStylesheets(projectPath: string): string[] {
  // The variables panel's folders (.stacki/folders.json), else src/, public/ and styles/.
  const roots = variableFolders(projectPath).map((folder) => path.join(projectPath, ...folder.split('/')));
  const found: string[] = [];
  const walk = (directory: string, depth: number): void => {
    if (depth > CSS_VARIABLE_LIMITS.stylesheetDepthMax) {
      return;
    }
    let entries: ReturnType<typeof fs.readdirSync>;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (/\.css$/i.test(entry.name)) {
        found.push(full);
      }
    }
  };
  for (const root of roots) {
    walk(root, 0);
  }
  return [...new Set(found)].sort();
}

/**
 * The variables panel's folders (`variables` in .stacki/folders.json), read
 * through the same file access as the stylesheets: on
 * Desktop that is the disk, in Studio the request's draft snapshot, which holds
 * the folder settings beside the sources (variableServer.ts). A missing or
 * unreadable file reads the defaults.
 */
function variableFolders(projectPath: string): readonly string[] {
  let source: string | undefined;
  try {
    source = fs.readFileSync(path.join(projectPath, PROJECT_FOLDERS_FILE), 'utf8');
  } catch {
    source = undefined;
  }
  return foldersFor('variables', configOf(readProjectFoldersSource(source)));
}

export interface VarEntry {
  readonly kind: 'var';
  readonly name: string;
  readonly value: string;
  readonly important: boolean;
  readonly valueStart: number;
  readonly valueEnd: number;
  readonly line: number;
}
export interface CommentEntry {
  readonly kind: 'comment';
  /** The comment as a label: its first sentence, as written (shared/page/commentLabel.ts). */
  readonly text: string;
  /** Where that label sits in the file, so renaming it rewrites those words only. */
  readonly textStart: number;
  readonly textEnd: number;
  /** The whole comment without its docblock gutters, when it says more than the label. */
  readonly description?: string;
}
export type Entry = VarEntry | CommentEntry;

export interface Rule {
  selector: string;
  selectors: readonly string[];
  context: readonly string[];
  line: number;
  entries: Entry[];
}

/** The indentation in front of `text`, absent when nothing matches (never). */
export const leading = (text: string): number => text.match(/^\s*/)?.[0]?.length ?? 0;

// Every custom property declared in one file, with where its value sits in the
// text so it can be written back without reformatting anything around it.
export function readDeclarations(text: string): Rule[] {
  const root = postcss.parse(text);
  const rules: Rule[] = [];

  const contextOf = (node: Declaration | PostcssRule): string[] => {
    const parts: string[] = [];
    let parent = node.parent;
    while (parent && parent.type !== 'root') {
      if (parent.type === 'atrule') {
        parts.unshift(`@${parent.name} ${parent.params}`.trim());
      } else if (parent.type === 'rule') {
        parts.unshift(parent.selector);
      }
      parent = parent.parent;
    }
    return parts;
  };

  root.walkRules((rule: PostcssRule) => {
    const entries: Entry[] = [];
    for (const node of rule.nodes || []) {
      if (node.type === 'comment') {
        // Where the words are, inside the `/*` and the spacing postcss keeps in
        // raws: a heading in a single-rule file IS this comment, so renaming it
        // means writing here. The heading is the comment's first sentence, and
        // its span is that sentence's, so a rename leaves a docblock's other
        // lines where they are.
        const open = node.source?.start?.offset ?? 0;
        const bodyStart = open + 2 + (node.raws?.['left']?.length ?? 0);
        const label = commentLabel(node.text);
        entries.push({
          kind: 'comment',
          text: label.title,
          textStart: bodyStart + label.titleStart,
          textEnd: bodyStart + label.titleEnd,
          ...(label.description === undefined ? {} : { description: label.description }),
        });
        continue;
      }
      if (node.type !== 'decl' || !node.prop.startsWith('--')) {
        continue;
      }
      // PostCSS offsets end just after the declaration. Including another
      // character can pull the next declaration into a compact CSS value.
      const start = node.source?.start?.offset ?? 0;
      const end = node.source?.end?.offset ?? start;
      const declText = text.slice(start, end);
      const rawValue = node.raws.value?.raw ?? node.value;
      const valueStart = start + node.prop.length + (node.raws.between ?? ':').length + leading(rawValue);
      // Trailing `;` and whitespace are not part of the value.
      // PostCSS keeps whitespace in an empty custom property's node.value.
      // That whitespace was already skipped above, so using its length again
      // would consume the semicolon, closing brace, or following declaration.
      const valueEnd = Math.max(valueStart, start + declText.replace(/[\s;]+$/, '').length);
      entries.push({
        kind: 'var',
        name: node.prop,
        value: text.slice(valueStart, valueEnd),
        important: !!node.important,
        valueStart,
        valueEnd,
        line: node.source?.start?.line ?? 0,
      });
    }
    if (!entries.some((entry) => entry.kind === 'var')) {
      return;
    }
    rules.push({
      selector: rule.selector,
      selectors: rule.selectors ?? [],
      context: contextOf(rule),
      line: rule.source?.start?.line ?? 0,
      entries,
    });
  });

  return rules;
}
