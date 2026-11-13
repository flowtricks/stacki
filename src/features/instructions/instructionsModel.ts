// What the Instructions panel draws from a listing: the three sections, skills as
// a flat list named by their frontmatter, rules and docs as folder trees. Pure:
// the panel owns the state (open folders, the selected file) and these only shape
// values. A chain of folders with one child each is drawn as one row
// (`.claude/rules`), as editors do, so a deep dot folder costs one line.
import { assert } from '../../../shared/core/assert';
import {
  DEFAULT_RULE_FOLDER,
  INSTRUCTION_LIMITS,
  RULE_FOLDERS,
  SKILL_FOLDERS,
  skillFolderName,
  type InstructionEntry,
  type InstructionListing,
  type InstructionSection,
} from '../../../shared/properties/instructions';

export interface SkillRow {
  readonly path: string;
  readonly name: string;
  /** The frontmatter's description, or what is wrong with the frontmatter. */
  readonly description: string;
  readonly valid: boolean;
}

export type TreeNode =
  | { readonly kind: 'folder'; readonly path: string; readonly label: string; readonly children: readonly TreeNode[] }
  | { readonly kind: 'file'; readonly path: string; readonly label: string; readonly entry: InstructionEntry };

export interface InstructionSections {
  readonly skills: readonly SkillRow[];
  readonly rules: readonly TreeNode[];
  readonly docs: readonly TreeNode[];
}

export function sectionsOf(listing: InstructionListing): InstructionSections {
  const of = (section: InstructionSection): readonly InstructionEntry[] => listing.files.filter((file) => file.section === section);
  const skills = of('skills').map(skillRow);
  const ruleFolders = listing.folders.filter((folder) => RULE_FOLDERS.some((root) => folder.toLowerCase().startsWith(root)));
  const sections = { skills, rules: buildTree(of('rules'), ruleFolders), docs: buildTree(of('docs'), []) };
  assert(skills.length + countFiles(sections.rules) + countFiles(sections.docs) === listing.files.length, 'Every listed file is in one section');
  return sections;
}

function skillRow(entry: InstructionEntry): SkillRow {
  assert(entry.section === 'skills', 'A skill row is a skill');
  const skill = entry.skill;
  assert(skill !== undefined, 'A listed skill carries its frontmatter');
  if (skill.kind === 'valid') {
    return { path: entry.path, name: skill.name, description: skill.description, valid: true };
  }
  return { path: entry.path, name: skillFolderName(entry.path), description: skill.message, valid: false };
}

interface MutableFolder {
  readonly folders: Map<string, MutableFolder>;
  readonly files: InstructionEntry[];
}

/** Files and folders as a tree, folders before files, each sorted by name; single-child chains joined. */
export function buildTree(files: readonly InstructionEntry[], folders: readonly string[]): readonly TreeNode[] {
  assert(files.length <= INSTRUCTION_LIMITS.filesMax, 'A tree is built from a bounded listing');
  const root: MutableFolder = { folders: new Map(), files: [] };
  const folderAt = (segments: readonly string[]): MutableFolder => {
    let current = root;
    for (const segment of segments) {
      let next = current.folders.get(segment);
      if (next === undefined) {
        next = { folders: new Map(), files: [] };
        current.folders.set(segment, next);
      }
      current = next;
    }
    return current;
  };
  for (const folder of folders) {
    folderAt(folder.split('/'));
  }
  for (const file of files) {
    const segments = file.path.split('/');
    folderAt(segments.slice(0, -1)).files.push(file);
  }
  return nodesOf(root, '', 0);
}

// Depth is bounded by the walker's depth bound, so this recursion is too.
function nodesOf(folder: MutableFolder, prefix: string, depth: number): readonly TreeNode[] {
  assert(depth <= INSTRUCTION_LIMITS.depthMax, 'A tree is no deeper than the walk');
  const nodes: TreeNode[] = [];
  for (const [name, child] of [...folder.folders].sort(([left], [right]) => compareNames(left, right))) {
    let label = name;
    let path = prefix === '' ? name : `${prefix}/${name}`;
    let current = child;
    // Join a folder that holds only one folder with it: `.claude` › `rules` is one row.
    for (let step = 0; step < INSTRUCTION_LIMITS.depthMax && current.files.length === 0 && current.folders.size === 1; step += 1) {
      const only = [...current.folders][0];
      assert(only !== undefined, 'A folder with one child has it');
      label = `${label}/${only[0]}`;
      path = `${path}/${only[0]}`;
      current = only[1];
    }
    nodes.push({ kind: 'folder', path, label, children: nodesOf(current, path, depth + 1) });
  }
  for (const file of [...folder.files].sort((left, right) => compareNames(left.path, right.path))) {
    nodes.push({ kind: 'file', path: file.path, label: file.path.slice(file.path.lastIndexOf('/') + 1), entry: file });
  }
  return nodes;
}

function compareNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', { sensitivity: 'base', numeric: true });
}

/** Every file in a tree. */
export function countFiles(nodes: readonly TreeNode[]): number {
  let total = 0;
  const stack: TreeNode[] = [...nodes];
  for (let step = 0; step < INSTRUCTION_LIMITS.filesMax * 4 + INSTRUCTION_LIMITS.foldersMax * 4 && stack.length > 0; step += 1) {
    const node = stack.pop();
    assert(node !== undefined, 'The stack had a node');
    if (node.kind === 'file') {
      total += 1;
    } else {
      stack.push(...node.children);
    }
  }
  assert(stack.length === 0, 'Counting visits every node of a bounded tree');
  return total;
}

/** Every folder path in a tree, for "expand all". */
export function folderPaths(nodes: readonly TreeNode[]): readonly string[] {
  const paths: string[] = [];
  const stack: TreeNode[] = [...nodes];
  for (let step = 0; step < INSTRUCTION_LIMITS.filesMax * 4 + INSTRUCTION_LIMITS.foldersMax * 4 && stack.length > 0; step += 1) {
    const node = stack.pop();
    assert(node !== undefined, 'The stack had a node');
    if (node.kind === 'folder') {
      paths.push(node.path);
      stack.push(...node.children);
    }
  }
  return paths;
}

/** Where new skills go: the skill folder the project already uses, or Claude Code's. */
export function skillHome(listing: InstructionListing): string {
  const used = SKILL_FOLDERS.find((folder) => listing.files.some((file) => file.section === 'skills' && file.path.toLowerCase().startsWith(`${folder}/`)));
  return used ?? SKILL_FOLDERS[0] ?? '.claude/skills';
}

/** The folders a new rule may go in: the rule folders the project has, then the default one. */
export function ruleHomes(listing: InstructionListing): readonly string[] {
  const homes = new Set<string>();
  for (const folder of listing.folders) {
    homes.add(folder);
  }
  for (const file of listing.files) {
    if (file.section === 'rules' && file.path.includes('/')) {
      const folder = file.path.slice(0, file.path.lastIndexOf('/'));
      if (RULE_FOLDERS.some((root) => folder.toLowerCase().startsWith(root))) {
        homes.add(folder);
      }
    }
  }
  homes.add(DEFAULT_RULE_FOLDER);
  return [...homes].sort(compareNames);
}

/** The new file's path for a typed rule name in a folder (`.md` added when missing). */
export function rulePath(folder: string, name: string): string {
  const trimmed = name.trim();
  assert(trimmed.length > 0, 'A rule has a name');
  const file = /\.mdc?$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
  return folder === '' ? file : `${folder}/${file}`;
}

/** The new skill's file for a skill name in the skill folder. */
export function skillPath(home: string, name: string): string {
  assert(name.length > 0, 'A skill has a name');
  return `${home}/${name}/SKILL.md`; // i18n-ignore: a file path, not interface text.
}

/** The hidden pattern "Hide folder" writes for a file: its folder, or the file itself at the root. */
export function folderOf(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? undefined : path.slice(0, slash);
}
