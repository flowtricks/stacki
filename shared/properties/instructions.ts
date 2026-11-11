// The Instructions panel's contract: which Markdown files a project keeps for
// its coding agents and people, how each is sorted into a section, what a
// skill's frontmatter must say, and the project's hidden paths
// (`.stacki/instructions.json`, a tracked file shared by Desktop and Studio).
//
// The main process walks the project (electron/project/instructionFiles.ts),
// skipping build output and hidden paths, and answers a bounded listing; the
// renderer parses it here before use. Sections are decided by path alone, so
// main and the renderer cannot disagree about where a file belongs:
//
// - Skills: a `SKILL.md` directly inside a folder of a `skills` folder, as
//   Claude Code, Codex and the other agents lay them out
//   (`.claude/skills/<name>/SKILL.md`, `.agents/skills/<name>/SKILL.md`).
// - Rules: the files agents read on every turn — AGENTS.md, CLAUDE.md,
//   GEMINI.md and the like at any depth, and everything in the rule folders
//   the agents define (`.cursor/rules/`, `.claude/rules/`, …).
// - Docs: every other Markdown file, shown as a folder tree.
//
// Hidden paths are anchored at the project root, like a gitignore pattern
// that starts with `/`: `docs/archive` hides that folder and everything under
// it, `**/CHANGELOG.md` hides every changelog, `*` stays inside one folder
// name and `?` is one character. Anchoring keeps "Hide file" on a root
// AGENTS.md from also hiding the AGENTS.md files nested deeper.
import { assert } from '../core/assert';
import { count, list, pathText, record, text } from '../core/boundary';
import { err, ok, type Result } from '../core/result';

/** The tracked project file that holds the hidden paths. */
export const INSTRUCTIONS_FILE = '.stacki/instructions.json';

// The bounds live beside the parser and the walker that enforce them (AGENTS.md §10).
export const INSTRUCTION_LIMITS = {
  /** Markdown files one listing carries; past it the listing says it is cut short. */
  filesMax: 2_000,
  /** Directories the walker opens: a large monorepo's documentation, never node_modules. */
  directoriesMax: 20_000,
  /** How deep the walker goes below the project root. */
  depthMax: 24,
  /** Empty rule folders a listing carries, so a new folder shows before its first file. */
  foldersMax: 500,
  /** The largest file the panel opens: a long handbook fits many times over. */
  fileBytesMax: 2 * 1024 * 1024,
  /** Characters in one project-relative path. */
  pathCharsMax: 512,
  /** Hidden paths one project keeps. */
  hiddenMax: 200,
  /** Characters in one hidden path or pattern. */
  patternCharsMax: 256,
  /** Characters in the whole settings file. */
  settingsCharsMax: 65_536,
  /** A skill name, as Claude Code limits it. */
  skillNameCharsMax: 64,
  /** A skill description, as Claude Code limits it. */
  skillDescriptionCharsMax: 1_024,
  /** The frontmatter a file may open with before it is read as body. */
  frontmatterCharsMax: 65_536,
  /** A rule or doc file name typed in the panel. */
  fileNameCharsMax: 80,
} as const satisfies Record<string, number>;

export const INSTRUCTION_SECTIONS = ['skills', 'rules', 'docs'] as const;
export type InstructionSection = (typeof INSTRUCTION_SECTIONS)[number];

/** What a skill's frontmatter says, or why it says nothing usable. */
export type SkillMeta =
  { readonly kind: 'valid'; readonly name: string; readonly description: string } | { readonly kind: 'invalid'; readonly message: string };

export interface InstructionEntry {
  /** Project-relative, `/`-separated. */
  readonly path: string;
  readonly section: InstructionSection;
  readonly sizeBytes: number;
  /** A skill's frontmatter; undefined for every file that is not a skill. */
  readonly skill: SkillMeta | undefined;
}

export interface InstructionListing {
  /** Sorted by path. */
  readonly files: readonly InstructionEntry[];
  /** Folders inside the rule folders, so an empty one still shows; sorted. */
  readonly folders: readonly string[];
  /** The walk stopped at a bound: more files exist than are listed. */
  readonly truncated: boolean;
}

export interface InstructionSettings {
  readonly version: 1;
  /** Project-relative paths or patterns, anchored at the root, in the order they were added. */
  readonly hidden: readonly string[];
}

export const EMPTY_INSTRUCTION_SETTINGS: InstructionSettings = { version: 1, hidden: [] };

/**
 * Directories the walker never opens, wherever they are: dependencies, version
 * control, Stacki's own metadata and the build output of the frameworks a site
 * uses. They hold Markdown nobody writes (package READMEs, changelogs, copies).
 */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.stacki',
  'dist',
  'build',
  'out',
  '.astro',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vercel',
  '.netlify',
  '.wrangler',
  '.turbo',
  '.cache',
  'coverage',
  '.pnpm-store',
  '.yarn',
]);

/** File names agents read as rules wherever they sit, compared case-insensitively. */
export const RULE_FILE_NAMES: ReadonlySet<string> = new Set([
  'agents.md',
  'agent.md',
  'claude.md',
  'claude.local.md',
  'gemini.md',
  'copilot-instructions.md',
  'conventions.md',
  '.cursorrules.md',
  '.windsurfrules.md',
]);

/** Folders whose Markdown is all rules: each agent's own place for them. */
export const RULE_FOLDERS: readonly string[] = [
  '.claude/rules',
  '.cursor/rules',
  '.windsurf/rules',
  '.clinerules',
  '.github/instructions',
  '.kiro/steering',
  '.amazonq/rules',
  '.roo/rules',
  '.continue/rules',
];

/** Where the panel creates a new rule file or folder when the project has no rule folder yet. */
export const DEFAULT_RULE_FOLDER = '.claude/rules';

/** Folders that hold skills, one folder per skill; the panel creates new ones in the first. */
export const SKILL_FOLDERS: readonly string[] = ['.claude/skills', '.agents/skills', '.codex/skills', '.cursor/skills', '.gemini/skills', '.github/skills'];

/** Whether a file name is one the panel lists: Markdown, or Cursor's `.mdc` rules. */
export function isInstructionFileName(name: string, folder: string): boolean {
  assert(name.length > 0, 'A file name is never empty');
  const lower = name.toLowerCase();
  if (lower.endsWith('.md')) {
    return true;
  }
  if (lower.endsWith('.mdc')) {
    return inRuleFolder(folder === '' ? name : `${folder}/${name}`);
  }
  return false;
}

/** The section a project-relative Markdown path belongs to. */
export function classifyInstruction(path: string): InstructionSection {
  assert(path.length > 0, 'A classified path is never empty');
  assert(!path.startsWith('/'), 'A classified path is project-relative');
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  if (isSkillPath(segments)) {
    return 'skills';
  }
  if (RULE_FILE_NAMES.has(name.toLowerCase())) {
    return 'rules';
  }
  if (inRuleFolder(path)) {
    return 'rules';
  }
  return 'docs';
}

// `…/skills/<name>/SKILL.md`: the skill file of a skill folder, at any depth.
function isSkillPath(segments: readonly string[]): boolean {
  const name = segments[segments.length - 1] ?? '';
  if (name.toLowerCase() !== 'skill.md') {
    return false;
  }
  if (segments.length < 3) {
    return false;
  }
  return (segments[segments.length - 3] ?? '').toLowerCase() === 'skills';
}

/** Whether a path is inside one of the agents' rule folders (at the project root). */
export function inRuleFolder(path: string): boolean {
  const lower = path.toLowerCase();
  return RULE_FOLDERS.some((folder) => lower.startsWith(`${folder}/`));
}

/** The skill folder's name: what a skill is called when its frontmatter says nothing usable. */
export function skillFolderName(path: string): string {
  const segments = path.split('/');
  assert(segments.length >= 2, 'A skill file is inside its folder');
  const folder = segments[segments.length - 2] ?? '';
  assert(folder.length > 0, 'A skill folder has a name');
  return folder;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/** A file's opening YAML block, exactly as written, and the body after it. `raw + body` is the file. */
export interface FrontmatterSplit {
  /** The `---` lines and what is between them, with the closing line's break; empty when there is none. */
  readonly raw: string;
  /** The YAML between the fences, without them. */
  readonly yaml: string;
  readonly body: string;
}

const FENCE_OPEN = /^---[ \t]*\r?\n/;

/** The frontmatter of a Markdown file, split without touching a byte. Total: no fence, or no close, is all body. */
export function splitFrontmatter(source: string): FrontmatterSplit {
  const open = FENCE_OPEN.exec(source);
  if (open === null) {
    return { raw: '', yaml: '', body: source };
  }
  const start = open[0].length;
  // A fresh expression per call: a shared global one would carry its position between files.
  const fenceClose = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/gm;
  fenceClose.lastIndex = start;
  const close = fenceClose.exec(source);
  if (close === null) {
    return { raw: '', yaml: '', body: source };
  }
  const end = close.index + close[0].length;
  if (end > INSTRUCTION_LIMITS.frontmatterCharsMax) {
    return { raw: '', yaml: '', body: source };
  }
  const split = { raw: source.slice(0, end), yaml: source.slice(start, close.index), body: source.slice(end) };
  assert(split.raw + split.body === source, 'Frontmatter and body are the whole file');
  return split;
}

/** A skill's name and description from its parsed frontmatter (YAML read by the caller). */
export function parseSkillMeta(frontmatter: unknown): SkillMeta {
  if (typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)) {
    return { kind: 'invalid', message: 'This skill has no frontmatter. Add a name and a description.' };
  }
  const fields = record(frontmatter);
  const name = fields['name'];
  const description = fields['description'];
  if (typeof name !== 'string' || name.trim() === '') {
    return { kind: 'invalid', message: 'This skill has no name in its frontmatter.' };
  }
  if (name.length > INSTRUCTION_LIMITS.skillNameCharsMax) {
    return { kind: 'invalid', message: `A skill name is at most ${INSTRUCTION_LIMITS.skillNameCharsMax} characters.` };
  }
  if (typeof description !== 'string' || description.trim() === '') {
    return { kind: 'invalid', message: 'This skill has no description in its frontmatter.' };
  }
  if (description.length > INSTRUCTION_LIMITS.skillDescriptionCharsMax) {
    return { kind: 'invalid', message: `A skill description is at most ${INSTRUCTION_LIMITS.skillDescriptionCharsMax} characters.` };
  }
  return { kind: 'valid', name: name.trim(), description: description.trim() };
}

/** Why a typed skill name cannot name a skill folder, or undefined when it can: lowercase letters, digits and hyphens. */
export function skillNameProblem(name: string): string | undefined {
  if (name === '') {
    return 'Give the skill a name.';
  }
  if (name.length > INSTRUCTION_LIMITS.skillNameCharsMax) {
    return `A skill name is at most ${INSTRUCTION_LIMITS.skillNameCharsMax} characters.`;
  }
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return undefined;
  }
  return 'Use lowercase letters, numbers and single hyphens, like "write-tests".';
}

/** A name typed in any case and spacing, as a skill or file name: `Write Tests!` → `write-tests`. */
export function slugName(typed: string): string {
  const slug = typed
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  assert(!slug.includes('--'), 'A slug has single hyphens');
  return slug.slice(0, INSTRUCTION_LIMITS.skillNameCharsMax).replace(/-+$/, '');
}

/** A new skill's SKILL.md: the frontmatter every agent requires, and a heading to start from. */
export function skillScaffold(name: string, description: string): string {
  assert(skillNameProblem(name) === undefined, 'A scaffolded skill has a valid name');
  const summary = description.trim().replace(/\s+/g, ' ');
  assert(summary.length > 0, 'A scaffolded skill has a description');
  const title = name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return `---\nname: ${name}\ndescription: ${yamlScalar(summary)}\n---\n\n# ${title}\n\n`;
}

/** A new rule file: a heading named after it. */
export function ruleScaffold(title: string): string {
  const heading = title.trim();
  assert(heading.length > 0, 'A scaffolded rule has a title');
  return `# ${heading}\n\n`;
}

/** A one-line YAML value: plain when YAML reads it back as the same text, double-quoted otherwise. */
export function yamlScalar(value: string): string {
  assert(!value.includes('\n'), 'A one-line YAML value has no line break');
  const plain =
    value !== '' && !/^[\s!&*%@`'"#|>{}[\],?:-]|[:#]\s|\s[#:]|\s$|:$/.test(value) && !/^(?:true|false|null|yes|no|on|off|~|[-+.\d].*)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

/** Why a typed rule file or folder name is unusable, or undefined. One name, no path. */
export function fileNameProblem(name: string): string | undefined {
  if (name.trim() === '') {
    return 'Give it a name.';
  }
  if (name.length > INSTRUCTION_LIMITS.fileNameCharsMax) {
    return `A name is at most ${INSTRUCTION_LIMITS.fileNameCharsMax} characters.`;
  }
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) {
    return 'A name cannot hold / \\ : * ? " < > or |.';
  }
  if (name.startsWith('.')) {
    return 'A name cannot start with a dot.';
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Hidden paths
// ---------------------------------------------------------------------------

/** A hidden path or pattern, normalized; throws on one the panel could never match. */
export function parseHiddenPattern(input: unknown): string {
  const raw = text(input).trim();
  if (raw.length > INSTRUCTION_LIMITS.patternCharsMax) {
    throw new Error(`A hidden path is at most ${INSTRUCTION_LIMITS.patternCharsMax} characters.`);
  }
  const pattern = raw.replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (pattern === '') {
    throw new Error('A hidden path is never empty.');
  }
  if (pattern.startsWith('/') || /^[A-Za-z]:/.test(pattern)) {
    throw new Error('A hidden path is relative to the project.');
  }
  if (pattern.includes('\\')) {
    throw new Error('A hidden path uses / between folders.');
  }
  if (/[\u0000-\u001f]/.test(pattern)) {
    throw new Error('A hidden path has no control characters.');
  }
  if (pattern.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) {
    throw new Error('A hidden path stays inside the project.');
  }
  return pattern;
}

/** `.stacki/instructions.json`, parsed and bounded. */
export function parseInstructionSettings(input: unknown): InstructionSettings {
  const fields = record(input);
  if (fields['version'] !== 1) {
    throw new Error('Unsupported instructions settings version');
  }
  const hidden = fields['hidden'] === undefined ? [] : list(parseHiddenPattern)(fields['hidden']);
  if (hidden.length > INSTRUCTION_LIMITS.hiddenMax) {
    throw new Error(`At most ${INSTRUCTION_LIMITS.hiddenMax} hidden paths.`);
  }
  if (new Set(hidden).size !== hidden.length) {
    throw new Error('A hidden path is listed twice.');
  }
  return { version: 1, hidden };
}

/** The settings file's text read back: a missing file is no hidden paths. */
export function readInstructionSettingsSource(source: string | undefined): Result<InstructionSettings, string> {
  if (source === undefined) {
    return ok(EMPTY_INSTRUCTION_SETTINGS);
  }
  if (source.length > INSTRUCTION_LIMITS.settingsCharsMax) {
    return err(`${INSTRUCTIONS_FILE} is larger than ${INSTRUCTION_LIMITS.settingsCharsMax} characters.`);
  }
  try {
    return ok(parseInstructionSettings(JSON.parse(source) as unknown));
  } catch (failure: unknown) {
    return err(failure instanceof Error ? failure.message : String(failure));
  }
}

/** The settings as the file writes them: stable, two-space JSON with a final newline. */
export function instructionSettingsSource(settings: InstructionSettings): string {
  const source = `${JSON.stringify({ version: settings.version, hidden: settings.hidden }, undefined, 2)}\n`;
  assert(source.length <= INSTRUCTION_LIMITS.settingsCharsMax, 'Bounded settings serialize inside the file bound');
  return source;
}

/** The settings with one more hidden path; an equal one already there leaves them as they are. */
export function withHidden(settings: InstructionSettings, pattern: string): Result<InstructionSettings, string> {
  let normal: string;
  try {
    normal = parseHiddenPattern(pattern);
  } catch (failure: unknown) {
    return err(failure instanceof Error ? failure.message : String(failure));
  }
  if (settings.hidden.includes(normal)) {
    return ok(settings);
  }
  if (settings.hidden.length < INSTRUCTION_LIMITS.hiddenMax) {
    return ok({ version: 1, hidden: [...settings.hidden, normal] });
  }
  return err(`A project hides at most ${INSTRUCTION_LIMITS.hiddenMax} paths.`);
}

/** The settings without one hidden path. */
export function withoutHidden(settings: InstructionSettings, pattern: string): InstructionSettings {
  const hidden = settings.hidden.filter((each) => each !== pattern);
  assert(hidden.length <= settings.hidden.length, 'Removing never adds');
  return { version: 1, hidden };
}

/** One compiled hidden pattern: whether it hides a path, and every path below one it hides. */
export type HiddenMatcher = (path: string) => boolean;

/** The patterns as one test. A pattern matching a folder hides everything inside it. */
export function hiddenMatcher(patterns: readonly string[]): HiddenMatcher {
  assert(patterns.length <= INSTRUCTION_LIMITS.hiddenMax, 'Hidden patterns are bounded');
  const expressions = patterns.map(patternExpression);
  return (path) => expressions.some((expression) => expression.test(path));
}

// `**/` is any number of folders, a final `/**` everything inside, `*` part of one name, `?` one character.
function patternExpression(pattern: string): RegExp {
  assert(pattern.length <= INSTRUCTION_LIMITS.patternCharsMax, 'A compiled pattern is bounded');
  let source = '';
  let index = 0;
  while (index < pattern.length) {
    const rest = pattern.slice(index);
    if (rest.startsWith('**/')) {
      source += '(?:[^/]+/)*';
      index += 3;
    } else if (rest === '/**') {
      source += '(?:/.*)?';
      index += 3;
    } else if (rest.startsWith('**')) {
      source += '.*';
      index += 2;
    } else if (rest.startsWith('*')) {
      source += '[^/]*';
      index += 1;
    } else if (rest.startsWith('?')) {
      source += '[^/]';
      index += 1;
    } else {
      source += (rest[0] ?? '').replace(/[.+^${}()|[\]\\]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${source}(?:/.*)?$`, 'i');
}

// ---------------------------------------------------------------------------
// The listing on the wire
// ---------------------------------------------------------------------------

function parseSection(input: unknown): InstructionSection {
  const found = INSTRUCTION_SECTIONS.find((section) => section === input);
  if (found === undefined) {
    throw new Error('Unknown instructions section');
  }
  return found;
}

function parseSkill(input: unknown): SkillMeta | undefined {
  if (input === undefined) {
    return undefined;
  }
  const fields = record(input);
  if (fields['kind'] === 'valid') {
    const name = text(fields['name']);
    const description = text(fields['description']);
    if (name.length > INSTRUCTION_LIMITS.skillNameCharsMax || description.length > INSTRUCTION_LIMITS.skillDescriptionCharsMax) {
      throw new Error('A skill exceeds its limits');
    }
    return { kind: 'valid', name, description };
  }
  if (fields['kind'] === 'invalid') {
    return { kind: 'invalid', message: text(fields['message']) };
  }
  throw new Error('Unknown skill kind');
}

/** A project-relative path the panel accepts: bounded, `/`-separated, inside the project. */
export function parseInstructionPath(input: unknown): string {
  const path = pathText(input);
  if (path.length === 0 || path.length > INSTRUCTION_LIMITS.pathCharsMax) {
    throw new Error('An instructions path is between 1 and 512 characters.');
  }
  if (path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) {
    throw new Error('An instructions path is project-relative.');
  }
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('An instructions path stays inside the project.');
  }
  return path;
}

/** A Markdown file's path: an instructions path ending in `.md` (or `.mdc` in a rule folder). */
export function parseInstructionFilePath(input: unknown): string {
  const path = parseInstructionPath(input);
  const slash = path.lastIndexOf('/');
  if (!isInstructionFileName(path.slice(slash + 1), slash < 0 ? '' : path.slice(0, slash))) {
    throw new Error('Only Markdown files open in the Instructions panel.');
  }
  return path;
}

// Built field by field: `skill` is always present on an entry, undefined for a file that is no skill.
function parseEntry(input: unknown): InstructionEntry {
  const fields = record(input);
  return {
    path: parseInstructionFilePath(fields['path']),
    section: parseSection(fields['section']),
    sizeBytes: count(fields['sizeBytes']),
    skill: parseSkill(fields['skill']),
  };
}

/** The listing main sends, checked: bounded, and every file in the section its path decides. */
export function parseInstructionListing(input: unknown): InstructionListing {
  const fields = record(input);
  const files = list(parseEntry)(fields['files']);
  const folders = list(parseInstructionPath)(fields['folders']);
  if (files.length > INSTRUCTION_LIMITS.filesMax) {
    throw new Error('An instructions listing exceeds its file limit');
  }
  if (folders.length > INSTRUCTION_LIMITS.foldersMax) {
    throw new Error('An instructions listing exceeds its folder limit');
  }
  for (const file of files) {
    if (file.section !== classifyInstruction(file.path)) {
      throw new Error(`${file.path} is listed in the wrong section`);
    }
    if ((file.section === 'skills') !== (file.skill !== undefined)) {
      throw new Error(`${file.path}: only a skill carries skill frontmatter`);
    }
  }
  const truncated = fields['truncated'];
  if (typeof truncated !== 'boolean') {
    throw new Error('InstructionListing.truncated: expected boolean');
  }
  return { files, folders, truncated };
}

/** One file's text as main read it. */
export interface InstructionText {
  readonly source: string;
}

export function parseInstructionText(input: unknown): InstructionText {
  const source = text(record(input)['source']);
  if (source.length > INSTRUCTION_LIMITS.fileBytesMax) {
    throw new Error('An instructions file exceeds its size limit');
  }
  return { source };
}

/** What a create, write or folder call answers: the file's new text, or why it was refused. */
export type InstructionWriteResult = Result<InstructionText, { readonly code: InstructionWriteFailure; readonly message: string }>;
export const INSTRUCTION_WRITE_FAILURES = ['conflict', 'exists', 'too-large', 'invalid', 'write-failed'] as const;
export type InstructionWriteFailure = (typeof INSTRUCTION_WRITE_FAILURES)[number];

export function parseInstructionWriteResult(input: unknown): InstructionWriteResult {
  const fields = record(input);
  if (fields['ok'] === true) {
    return ok(parseInstructionText(fields['value']));
  }
  if (fields['ok'] !== false) {
    throw new Error('InstructionWriteResult.ok: expected boolean');
  }
  const failure = record(fields['error']);
  const code = INSTRUCTION_WRITE_FAILURES.find((each) => each === failure['code']);
  if (code === undefined) {
    throw new Error('Unknown instructions write failure');
  }
  return err({ code, message: text(failure['message']) });
}
