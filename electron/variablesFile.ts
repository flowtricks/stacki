// A stylesheet for a project's variables, when it has none.
//
// The Variables panel reads custom properties out of the project's CSS, so a
// project with no stylesheet had nothing to show and nowhere to add to — the only
// way in was to make a base.css by hand. This makes the first one: a file with a
// `:root` block to start from, and the import that makes Astro actually ship it.
// A stylesheet nobody imports is a file, not a style: the variables would be
// editable in the panel and absent from the page.

import fs from 'fs';
import path from 'path';

export const VARIABLES_REL = 'src/styles/variables.css';

// Three variables in three families, so the panel has groups to show straight
// away and the naming pattern it groups by (`--color-…`, `--space-…`) is on
// display for whoever adds the fourth.
export const VARIABLES_STARTER = `:root {
  --color-primary: #2563eb;
  --color-text: #111111;
  --space-m: 1rem;
}
`;

const FENCE = /^---[ \t]*$/m;

/**
 * `source` with `import '<spec>';` added to its frontmatter — after the imports
 * already there, or in a frontmatter made for the purpose. Unchanged when the
 * file already mentions the stylesheet.
 */
export function withStylesheetImport(source: string, spec: string): string {
  if (source.includes(spec)) {
    return source;
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replace(/\r\n/g, '\n');
  const statement = `import '${spec}';`;
  if (!/^---[ \t]*\n/.test(text)) {
    return `---\n${statement}\n---\n${text}`.replace(/\n/g, eol);
  }
  const afterOpen = text.indexOf('\n') + 1;
  const close = text.slice(afterOpen).search(FENCE);
  if (close === -1) {
    return source; // an unterminated frontmatter is not ours to guess at
  }
  const head = text.slice(afterOpen, afterOpen + close);
  const lines = head.split('\n');
  let last = -1;
  lines.forEach((line, index) => {
    if (/^\s*import\b[^]*?['"];?\s*$/.test(line)) {
      last = index;
    }
  });
  lines.splice(last + 1, 0, statement);
  const next = text.slice(0, afterOpen) + lines.join('\n') + text.slice(afterOpen + close);
  return next.replace(/\n/g, eol);
}

/** Layouts at the top of src/layouts, or the index page when there are none. */
function importHosts(projectPath: string): string[] {
  const layouts = path.join(projectPath, 'src', 'layouts');
  const found = fs.existsSync(layouts)
    ? fs
        .readdirSync(layouts, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.astro'))
        .map((entry) => path.join(layouts, entry.name))
        .sort()
    : [];
  if (found.length > 0) {
    return found;
  }
  const index = path.join(projectPath, 'src', 'pages', 'index.astro');
  return fs.existsSync(index) ? [index] : [];
}

export interface VariablesFileResult {
  readonly rel: string;
  readonly imported: readonly string[];
}

/**
 * Writes the starter stylesheet (appending a `:root` block if the file is already
 * there without one) and imports it. `onWrite` is told about every file touched, so
 * the caller can mark its own writes and not mistake them for outside edits.
 */
export function createVariablesFile(
  projectPath: string,
  onWrite: (file: string) => void,
): VariablesFileResult {
  const file = path.join(projectPath, ...VARIABLES_REL.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!/:root\b/.test(existing)) {
    onWrite(file);
    fs.writeFileSync(file, existing ? `${existing.trimEnd()}\n\n${VARIABLES_STARTER}` : VARIABLES_STARTER, 'utf8');
  }
  const imported: string[] = [];
  for (const host of importHosts(projectPath)) {
    const spec = path.relative(path.dirname(host), file).split(path.sep).join('/');
    const before = fs.readFileSync(host, 'utf8');
    const after = withStylesheetImport(before, spec.startsWith('.') ? spec : `./${spec}`);
    if (after !== before) {
      onWrite(host);
      fs.writeFileSync(host, after, 'utf8');
      imported.push(path.relative(projectPath, host).split(path.sep).join('/'));
    }
  }
  return { rel: VARIABLES_REL, imported };
}
