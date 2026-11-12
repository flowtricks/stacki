// What the `@` picker lists (channel `ai:mentions`): the project's text files and
// the skills the person's agents can use, searched by what was typed after `@`.
//
// Files come from `git ls-files` (tracked and untracked, ignore rules applied) and,
// outside a repository, from a bounded walk; both are filtered to text extensions
// and to folders that are never worth mentioning (dependencies, build output, Stacki's
// preview). Skills are `SKILL.md` files in `<project>/.claude/skills/*`,
// `<project>/.agents/skills/*`, `~/.claude/skills/*` and `~/.codex/skills/*`
// (the last location is Codex's convention and is read only if it exists; it has not
// been checked against an installed Codex). The scan is cached per project for
// `mentionCacheMs`, because a keystroke asks again.
//
// Nothing here reads outside those known places: the query is only ever matched
// against names already listed, never turned into a path.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../../shared/core/assert';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { isProjectRelativePath, type MentionCandidate, type MentionKind, type SkillSource } from '../../../shared/properties/ai/mentions';
import { git } from '../../lib/nodeTools';

export interface MentionEnvironment {
  readonly home: () => string;
  readonly now: () => number;
  /** Project-relative paths with forward slashes, in any order. Replaceable in tests. */
  readonly listFiles: (root: string) => Promise<readonly string[]>;
}

export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.astro',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.scss',
  '.html',
  '.yml',
  '.yaml',
  '.toml',
  '.svg',
  '.vue',
  '.svelte',
  '.xml',
]);

const IGNORED_FOLDERS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.astro']);
const PINNED_NAMES: readonly string[] = ['AGENTS.md', 'CLAUDE.md'];
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.mdx']);
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The part of a SKILL.md that can hold its frontmatter. */
const SKILL_HEADER_BYTES = 8 * 1024;

interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly path: string;
}

interface Scan {
  readonly at: number;
  readonly files: readonly string[];
  readonly skills: readonly SkillRecord[];
}

export class MentionIndex {
  private readonly scans = new Map<string, Scan>();

  constructor(private readonly environment: MentionEnvironment) {}

  /** Forget every scan: the next query looks at the disk again. */
  invalidate(): void {
    this.scans.clear();
  }

  async search(root: string, query: string, kinds: readonly MentionKind[]): Promise<readonly MentionCandidate[]> {
    assert(path.isAbsolute(root), 'MentionIndex.search: the project root is absolute');
    const scan = await this.scan(root);
    const needle = query.trim().replace(/^@/, '').toLowerCase();
    const wanted = kinds.length === 0 ? (['file', 'skill'] as const) : kinds;
    const skills = wanted.includes('skill') ? rankSkills(scan.skills, needle).slice(0, SKILLS_SHARE) : [];
    const room = AI_LIMITS.mentionResultsMax - skills.length;
    const files = wanted.includes('file') ? rankFiles(scan.files, needle).filter((file) => fs.existsSync(path.join(root, ...file.split('/')))) : [];
    const results = [...skills, ...files.slice(0, room).map(toFileCandidate)];
    assert(results.length <= AI_LIMITS.mentionResultsMax, 'MentionIndex.search: results are bounded');
    return results;
  }

  private async scan(root: string): Promise<Scan> {
    const now = this.environment.now();
    const cached = this.scans.get(root);
    if (cached !== undefined && now - cached.at < AI_LIMITS.mentionCacheMs) {
      return cached;
    }
    const files = (await this.environment.listFiles(root)).filter(isMentionableFile).slice(0, AI_LIMITS.mentionScanFilesMax);
    const scan: Scan = { at: now, files, skills: readSkills(root, this.environment.home()) };
    if (this.scans.size >= AI_LIMITS.mentionCachedProjectsMax) {
      const oldest = this.scans.keys().next();
      if (oldest.done !== true) {
        this.scans.delete(oldest.value);
      }
    }
    this.scans.set(root, scan);
    assert(this.scans.size <= AI_LIMITS.mentionCachedProjectsMax, 'MentionIndex: cached projects are bounded');
    return scan;
  }
}

/** Skills listed before files when both are asked for, so a long file list cannot push them out. */
const SKILLS_SHARE = 15;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Whether a project-relative path is a text file in a folder worth mentioning. */
export function isMentionableFile(relative: string): boolean {
  if (!isProjectRelativePath(relative)) {
    return false;
  }
  const segments = relative.split('/');
  if (segments.slice(0, -1).some((segment) => IGNORED_FOLDERS.has(segment))) {
    return false;
  }
  // Stacki's generated preview of the project, never the person's own files.
  if (relative.startsWith('.stacki/preview/')) {
    return false;
  }
  return TEXT_EXTENSIONS.has(path.posix.extname(relative).toLowerCase());
}

/**
 * Files matching `needle`, best first: AGENTS.md and CLAUDE.md, then Markdown, then the rest;
 * within each group by how well the name and path match, then shorter paths first. An empty needle
 * lists everything in that order.
 */
export function rankFiles(files: readonly string[], needle: string): readonly string[] {
  const scored: { readonly file: string; readonly tier: number; readonly score: number }[] = [];
  for (const file of files) {
    const score = needle === '' ? 1 : matchScore(file, needle);
    if (score > 0) {
      scored.push({ file, tier: tierOf(file), score });
    }
  }
  scored.sort(
    (left, right) => left.tier - right.tier || right.score - left.score || left.file.length - right.file.length || left.file.localeCompare(right.file),
  );
  return scored.slice(0, AI_LIMITS.mentionResultsMax * 2).map((entry) => entry.file);
}

function tierOf(file: string): number {
  if (PINNED_NAMES.includes(path.posix.basename(file))) {
    return 0;
  }
  return MARKDOWN_EXTENSIONS.has(path.posix.extname(file).toLowerCase()) ? 1 : 2;
}

/**
 * 0 for no match. A name that starts with the needle beats a name that contains it, which beats
 * a path that contains it, which beats the needle's letters appearing in order (a subsequence).
 */
export function matchScore(file: string, needle: string): number {
  const lower = file.toLowerCase();
  const name = path.posix.basename(lower);
  if (name === needle) {
    return 100;
  }
  if (name.startsWith(needle)) {
    return 80;
  }
  if (name.includes(needle)) {
    return 60;
  }
  if (lower.includes(needle)) {
    return 40;
  }
  return isSubsequence(needle, lower) ? 20 : 0;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let position = 0;
  for (const letter of haystack) {
    if (letter === needle[position]) {
      position += 1;
      if (position === needle.length) {
        return true;
      }
    }
  }
  return needle.length === 0;
}

function toFileCandidate(file: string): MentionCandidate {
  return { kind: 'file', path: file, name: path.posix.basename(file) };
}

/** The project's files: git's list (tracked and untracked, ignore rules applied), else a bounded walk. */
export async function listProjectFiles(root: string): Promise<readonly string[]> {
  try {
    const output = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      timeout: AI_LIMITS.snapshotMsMax,
      maxBuffer: AI_LIMITS.mentionScanFilesMax * 1024,
    });
    return output.stdout.split('\0').filter((entry) => entry !== '');
  } catch {
    return walkProject(root);
  }
}

/** Depth-first, never following links, never past `mentionScanFilesMax` files or the folders worth skipping. */
export function walkProject(root: string): readonly string[] {
  const files: string[] = [];
  const pending: string[] = [''];
  let visited = 0;
  while (pending.length > 0 && files.length < AI_LIMITS.mentionScanFilesMax && visited < AI_LIMITS.mentionScanFilesMax) {
    const relative = pending.pop();
    if (relative === undefined) {
      break;
    }
    visited += 1;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...relative.split('/').filter((segment) => segment !== '')), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!IGNORED_FOLDERS.has(entry.name) && child !== '.stacki/preview') {
          pending.push(child);
        }
      } else if (entry.isFile() && files.length < AI_LIMITS.mentionScanFilesMax) {
        files.push(child);
      }
    }
  }
  assert(files.length <= AI_LIMITS.mentionScanFilesMax, 'walkProject: bounded');
  return files;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** Every skill the person's agents can use here, the project's first (a project skill hides a user skill of the same name). */
export function readSkills(root: string, home: string): readonly SkillRecord[] {
  const places: readonly { readonly directory: string; readonly source: SkillSource; readonly display: string }[] = [
    { directory: path.join(root, '.claude', 'skills'), source: 'project', display: '.claude/skills' },
    { directory: path.join(root, '.agents', 'skills'), source: 'project', display: '.agents/skills' },
    { directory: path.join(home, '.claude', 'skills'), source: 'user', display: '~/.claude/skills' },
    { directory: path.join(home, '.codex', 'skills'), source: 'user', display: '~/.codex/skills' },
  ];
  const skills: SkillRecord[] = [];
  const names = new Set<string>();
  for (const place of places) {
    for (const folder of skillFolders(place.directory)) {
      const skill = readSkill(path.join(place.directory, folder, 'SKILL.md'), folder, place.source, `${place.display}/${folder}/SKILL.md`);
      if (skill !== undefined && !names.has(skill.name) && skills.length < AI_LIMITS.mentionSkillsMax) {
        names.add(skill.name);
        skills.push(skill);
      }
    }
  }
  assert(skills.length <= AI_LIMITS.mentionSkillsMax, 'readSkills: bounded');
  return skills;
}

function skillFolders(directory: string): readonly string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
      .slice(0, AI_LIMITS.mentionSkillsMax);
  } catch {
    return [];
  }
}

function readSkill(file: string, folder: string, source: SkillSource, display: string): SkillRecord | undefined {
  let header: string;
  try {
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(SKILL_HEADER_BYTES);
      const read = fs.readSync(handle, buffer, 0, SKILL_HEADER_BYTES, 0);
      header = buffer.toString('utf8', 0, read);
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return undefined; // No SKILL.md, or not readable: not a skill.
  }
  const front = parseFrontmatter(header);
  const name = front.get('name') ?? folder;
  if (!SKILL_NAME.test(name) || !isProjectRelativePath(display.replace(/^~\//, ''))) {
    return undefined;
  }
  return { name, description: (front.get('description') ?? '').slice(0, AI_LIMITS.mentionSkillDescriptionCharsMax), source, path: display };
}

/**
 * The `key: value` lines of a leading `---` block. A value may be quoted, or a block scalar
 * (`>` or `|`) whose indented lines are joined with spaces. Anything else in the block is ignored.
 */
export function parseFrontmatter(source: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return values;
  }
  for (let position = 1; position < lines.length && position < 200; position += 1) {
    const line = lines[position] ?? '';
    if (line.trim() === '---') {
      break;
    }
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = (match[1] ?? '').toLowerCase();
    let value = (match[2] ?? '').trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const folded: string[] = [];
      while (position + 1 < lines.length && position < 200 && /^\s+\S/.test(lines[position + 1] ?? '')) {
        position += 1;
        folded.push((lines[position] ?? '').trim());
      }
      value = folded.join(' ');
    } else if (/^(".*"|'.*')$/.test(value)) {
      value = value.slice(1, -1);
    }
    if (!values.has(key)) {
      values.set(key, value);
    }
  }
  return values;
}

function rankSkills(skills: readonly SkillRecord[], needle: string): readonly MentionCandidate[] {
  const scored: { readonly skill: SkillRecord; readonly score: number }[] = [];
  for (const skill of skills) {
    const name = skill.name.toLowerCase();
    let score = 0;
    if (needle === '') {
      score = 1;
    } else if (name === needle) {
      score = 100;
    } else if (name.startsWith(needle)) {
      score = 80;
    } else if (name.includes(needle)) {
      score = 60;
    } else if (skill.description.toLowerCase().includes(needle)) {
      score = 30;
    } else if (isSubsequence(needle, name)) {
      score = 20;
    }
    if (score > 0) {
      scored.push({ skill, score });
    }
  }
  scored.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  return scored.map(({ skill }) => ({ kind: 'skill', name: skill.name, description: skill.description, source: skill.source, path: skill.path }));
}
