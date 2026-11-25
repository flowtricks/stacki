// Making new files from a model: a component out of a piece of a page, and a
// new page. Printing a whole file happens only here, for a file that does not
// exist yet; an existing file changes only by splices (plan §11.9, the
// no-whole-file-regeneration fence in eslint.config.mjs).
//
// A component made out of a piece of a page:
//
// The markup MOVES — the page keeps `<Card />` where the element was — so what
// lands in the new file has to be everything that piece needed to render. Two
// things travel with it:
//
//   the nodes themselves, serialized exactly as the page writes them, and
//   the imports it was leaning on the page to have made.
//
// The second is the one that's easy to forget: an extracted card holding a
// <Button> renders an error, not a button, unless Button comes with it. And an
// import that came along can't simply be copied — a relative path is relative
// to the file it was written in, and the new file is somewhere else.
//
// The frontmatter the piece's values are made by may travel too. Which code that
// is, and what stays behind, is decided in the renderer
// (src/editor/extractFrontmatter.ts); its paths are re-aimed here, where the two
// folders are known.

import fs from 'fs';
import path from 'path';

import { assert } from '../../shared/core/assert';
import type { Digest } from '../../shared/core/brand';
import { mapModuleSpecifiers } from '../../shared/page/frontmatterSource';
import { isPathDescendant } from '../lib/platform';
import { DEFAULT_PROJECT_FOLDERS } from '../../shared/properties/projectFolders';
import { COMPONENT_ACCESS_LIMITS } from '../../shared/properties/componentAccess';
import { componentFolderProblem } from '../../shared/properties/componentNaming';
import { digestOf } from './atomicWrite';
import { serializePage, serializeNodes } from '../parse/astroParser';
import { CODE_INDENT_UNIT } from '../../shared/core/indent';

const toPosix = (filePath: string): string => filePath.split(path.sep).join('/');

// A component's name is a filename, an import and a tag all at once — and the
// capital is load-bearing: Astro reads a lowercase tag as an HTML element, so
// `<card />` renders a literal <card> and the component never appears.
const VALID_NAME = /^[A-Z][A-Za-z0-9]*$/;

interface ComponentImport {
  readonly name?: string;
  readonly path?: string;
  readonly quote?: string;
  readonly named?: boolean;
  readonly imported?: string;
  readonly typeOnly?: boolean;
}

/** Code moving out of the parent: its statements, and the imports they read. */
interface MovedFrontmatter {
  readonly imports: readonly ComponentImport[];
  readonly code: string;
}

interface ComponentFileArgs {
  readonly projectPath: string;
  readonly pagePath: string;
  readonly name: string;
  readonly nodes: readonly unknown[];
  readonly imports?: readonly ComponentImport[];
  readonly props?: readonly unknown[];
  readonly frontmatter?: MovedFrontmatter;
  /** The project's component folders (.stacki/folders.json), read by the caller; the new file goes in the first. */
  readonly componentFolders?: readonly string[];
  /** The folder below the first component folder, already parsed at the boundary (componentNaming.ts); `''` or absent is that folder. */
  readonly folder?: string | undefined;
}

/**
 * The file to write for a new component, as `{ path, rel, text }`. Throws when
 * the name can't be used — nothing is written here; the caller does that, so
 * every write to the project stays in one place.
 */
function componentFile({
  projectPath,
  pagePath,
  name,
  nodes,
  imports = [],
  props = [],
  frontmatter,
  componentFolders = DEFAULT_PROJECT_FOLDERS.components,
  folder = '',
}: ComponentFileArgs): {
  path: string;
  rel: string;
  text: string;
  /** The folders below the component folder that do not exist yet, outermost first: the caller makes them, Undo takes them back. */
  folders: readonly string[];
} {
  if (!VALID_NAME.test(String(name || ''))) {
    throw new Error('A component name has to be a word starting with a capital letter.');
  }
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error('Nothing to make a component from.');
  }

  // A new component goes in the first component folder the project lists (.stacki/folders.json).
  const componentFolder = componentFolders[0];
  if (componentFolder === undefined) {
    throw new Error('This project lists no component folders. Add one in Settings → Folders.');
  }
  const componentsDirectory = path.join(projectPath, ...componentFolder.split('/'));
  const folderProblem = componentFolderProblem(folder);
  if (folderProblem !== undefined) {
    throw new Error(`"${folder}" is not a folder under ${componentFolder} (${folderProblem.kind}).`);
  }
  const placed = folderOnDisk(componentsDirectory, folder);
  const directory = placed.directory;
  const target = path.join(directory, `${name}.astro`);
  assert(isPathDescendant(componentsDirectory, target), 'A new component lands inside the component folder');
  // Case-insensitively: on a Mac, Card.astro and card.astro are the same file,
  // and writing the second silently replaces the first.
  const clash = fs.existsSync(directory) ? fs.readdirSync(directory).find((fileName) => fileName.toLowerCase() === `${name.toLowerCase()}.astro`) : undefined;
  if (clash) {
    const where = toPosix(path.relative(projectPath, path.join(directory, clash)));
    throw new Error(`There's already a component called ${path.basename(clash, '.astro')} (${where}).`);
  }

  // Which of the page's imports this piece actually uses. Matched against the
  // serialized markup rather than the node kinds, so a name used inside an
  // expression (`{items.map(…)}`, `<Fragment set:html={raw} />`) counts too.
  const markup = serializeNodes(nodes);
  const used = imports.filter((imp) => imp?.name && new RegExp(`(^|[^A-Za-z0-9_$])${imp.name}([^A-Za-z0-9_$]|$)`).test(markup));
  const needed = (frontmatter?.imports ?? []).filter((imp) => !used.some((other) => other.name === imp.name));

  // `@/components/Button.astro` and bare package names mean the same thing from
  // any file and travel untouched. A relative path was written from the page's
  // folder and has to be re-aimed from src/components.
  const pageDirectory = path.dirname(pagePath);
  const rebased = (spec: string): string => {
    if (!spec.startsWith('.')) {
      return spec;
    }
    const rel = toPosix(path.relative(directory, path.resolve(pageDirectory, spec)));
    return rel.startsWith('.') ? rel : './' + rel;
  };
  const moved = [...used, ...needed].map((imp) => ({ ...imp, path: rebased(String(imp.path || '')) }));

  // The values the piece was reading from the page, now read from its props
  // instead. Astro's own convention, and the one the props panel reads back:
  // a destructure off Astro.props IS the component's interface. It comes first
  // because code that moved may read a prop, and never the other way round.
  const names = props.filter((prop) => /^[A-Za-z_$][\w$]*$/.test(String(prop || '')));
  const destructure = names.length ? `const { ${names.join(', ')} } = Astro.props;` : '';
  const code = mapModuleSpecifiers(frontmatter?.code ?? '', rebased);
  const extraFrontmatter = [destructure, code].filter((part) => part !== '').join('\n\n');

  const text = serializePage(
    {
      imports: moved,
      extraFrontmatter,
      nodes,
      // No imports and no code, no `---` block: a component that needs no
      // frontmatter shouldn't be handed an empty one.
      hadFrontmatter: moved.length > 0 || extraFrontmatter !== '',
    },
    CODE_INDENT_UNIT,
  );

  return { path: target, rel: toPosix(path.relative(projectPath, target)), text, folders: placed.missing };
}

// Where a folder below the component folder is on disk: each level that exists already in another case is spelled as the disk
// spells it (on a Mac `forms` and `Forms` are one folder, and the Components panel groups by the spelling it reads), and the
// levels that do not exist yet are listed, outermost first, for the caller to make and for Undo to take back.
function folderOnDisk(componentsDirectory: string, folder: string): { readonly directory: string; readonly missing: readonly string[] } {
  if (folder === '') {
    return { directory: componentsDirectory, missing: [] };
  }
  const levels = folder.split('/');
  assert(levels.length <= COMPONENT_ACCESS_LIMITS.pathDepthMax, 'folderOnDisk: a parsed folder is within the depth bound');
  let directory = componentsDirectory;
  const missing: string[] = [];
  for (const level of levels) {
    const existing = missing.length === 0 ? existingSpelling(directory, level) : undefined;
    directory = path.join(directory, existing ?? level);
    if (existing === undefined) {
      missing.push(directory);
    }
  }
  assert(isPathDescendant(componentsDirectory, directory), 'folderOnDisk: the folder stays inside the component folder');
  assert(missing.length <= levels.length, 'folderOnDisk: at most every level is new');
  return { directory, missing };
}

// The name of the folder in `parent` that is `level` but for case, if there is one.
function existingSpelling(parent: string, level: string): string | undefined {
  if (!fs.existsSync(parent)) {
    return undefined;
  }
  const wanted = level.toLowerCase();
  const entry = fs.readdirSync(parent, { withFileTypes: true }).find((candidate) => candidate.isDirectory() && candidate.name.toLowerCase() === wanted);
  return entry?.name;
}

interface NewPageLayout {
  readonly name: string;
  readonly path: string;
}

/** The text of a new, empty page: a frontmatter block, and the layout wrapper
 * when one is picked (imported relative to the page). */
function newPageText(input: { readonly pagePath: string; readonly layout: NewPageLayout | undefined; readonly eol: '\n' | '\r\n' }): string {
  const layout = input.layout;
  const base = {
    extraFrontmatter: '',
    frontmatterLead: '',
    extraFrontmatterSpaced: true,
    hadFrontmatter: true,
    trailingBlank: 0,
    eol: input.eol,
  };
  if (layout === undefined) {
    return serializePage({ ...base, imports: [], nodes: [] });
  }
  const rel = toPosix(path.relative(path.dirname(input.pagePath), layout.path));
  const wrapper = { id: 'layout', kind: 'component', name: layout.name, props: {}, children: [] };
  const imports = [{ name: layout.name, path: rel.startsWith('.') ? rel : './' + rel }];
  const text = serializePage({ ...base, imports, nodes: [wrapper] }, CODE_INDENT_UNIT);
  assert(text.includes(`<${layout.name}`), 'A new page prints its layout wrapper');
  assert(text.includes(rel), 'A new page imports its layout');
  return text;
}

/** What taking back a created component found: the file as it was written and
 *  now gone, a file someone changed since (kept unless forced), or no file. */
export type ComponentDiscard = 'deleted' | 'edited' | 'missing';

interface ComponentDiscardArgs {
  readonly projectPath: string;
  readonly path: string;
  /** The checksum the file was created with. */
  readonly checksum: Digest;
  /** Delete it even when it changed since: the person said so. */
  readonly force: boolean;
  /** The project's component folders, read by the caller: only a file in one of them can be taken back. */
  readonly componentFolders?: readonly string[];
  /** The folders the creation made, outermost first: each is removed, deepest first, once the file is gone and it is empty. */
  readonly folders?: readonly string[];
}

/**
 * Undo of "create component": the file goes only while it holds exactly what
 * was written, so an edit made to it since is never lost without a question.
 * Only a component file can go — the request crosses a process boundary, and a
 * path anywhere else is refused rather than deleted.
 */
function discardComponentFile({
  projectPath,
  path: target,
  checksum,
  force,
  componentFolders = DEFAULT_PROJECT_FOLDERS.components,
  folders = [],
}: ComponentDiscardArgs): ComponentDiscard {
  // Any listed component folder: the one it was made in is the first of them.
  const inComponentFolder = componentFolders.some((folder) => isPathDescendant(path.join(projectPath, ...folder.split('/')), target));
  if (!inComponentFolder) {
    throw new Error('Only a component file can be taken back.');
  }
  if (path.extname(target) !== '.astro') {
    throw new Error('Only a component file can be taken back.');
  }
  // The folders go only from inside a component folder, and never a component folder itself: the request crosses a process boundary.
  const roots = componentFolders.map((folder) => path.join(projectPath, ...folder.split('/')));
  for (const folder of folders) {
    if (!roots.some((root) => isPathDescendant(root, folder))) {
      throw new Error('Only a folder made for a component can be taken back.');
    }
    if (!isPathDescendant(folder, target)) {
      throw new Error('Only the folders holding the component can be taken back.');
    }
  }
  if (!fs.existsSync(target)) {
    removeEmptyFolders(folders);
    return 'missing';
  }
  const unchanged = digestOf(fs.readFileSync(target)) === checksum;
  if (unchanged || force) {
    fs.rmSync(target);
    assert(!fs.existsSync(target), 'A discarded component is gone');
    removeEmptyFolders(folders);
    return 'deleted';
  }
  return 'edited';
}

// Deepest first, and only while empty: anything put in a folder since it was made keeps it, and every folder above it.
function removeEmptyFolders(folders: readonly string[]): void {
  assert(folders.length <= COMPONENT_ACCESS_LIMITS.pathDepthMax, 'removeEmptyFolders: at most one folder per level');
  for (const folder of [...folders].reverse()) {
    if (!fs.existsSync(folder)) {
      continue;
    }
    if (fs.readdirSync(folder).length > 0) {
      return;
    }
    fs.rmdirSync(folder);
    assert(!fs.existsSync(folder), 'An emptied folder is gone');
  }
}

export { componentFile, discardComponentFile, newPageText };
