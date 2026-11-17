// The project's .env: read for the values a sample request needs, and written
// only by a person's explicit save. A secret goes nowhere else. Before one is
// written, .env is proved to be outside Git, because a secret in a tracked file
// is published with the site and stays in its history.

import fs from 'node:fs';
import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { toRecord } from '../../shared/core/record';
import { SECRETS_FILE_DEFAULT, SECRETS_FILE_NAMES, type SecretsFileName } from '../../shared/properties/secrets';
import { createProjectText, writeProjectText } from '../documents/documentWrites';

// A secret saved from a page template's connection goes where the Secrets tab opens.
const ENV_FILE = SECRETS_FILE_DEFAULT;
const ENV_BYTES_MAX = 256 * 1024;
const ENV_LINES_MAX = 4000;
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export type IgnoreChange = 'already-ignored' | 'added';

/** Runs git in a project, rejecting on a non-zero exit (lib/nodeTools.ts). */
export type Git = (projectPath: string, args: readonly string[]) => Promise<unknown>;

/** Every variable the project's env files set, by name. Values stay in this process. */
export function readProjectEnv(projectRoot: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  // Vite's order: a later file wins, and every one of these is read in dev.
  for (const name of SECRETS_FILE_NAMES) {
    for (const [key, value] of envEntries(readEnvFile(path.join(projectRoot, name)) ?? '')) {
      values.set(key, value);
    }
  }
  return values;
}

/** The assignments in an env file's text, unquoted. */
export function envEntries(source: string): readonly (readonly [string, string])[] {
  const out: (readonly [string, string])[] = [];
  for (const line of source.split(/\r?\n/).slice(0, ENV_LINES_MAX)) {
    const match = ASSIGNMENT.exec(line);
    if (match?.[1] !== undefined) {
      out.push([match[1], envValue(match[2] ?? '')]);
    }
  }
  return out;
}

/** The env file's text with `name` set: its line replaced, or one added at the end. */
export function withEnvValue(source: string, name: string, value: string): string {
  assert(/^[A-Z_][A-Z0-9_]*$/.test(name), 'withEnvValue: a variable name is checked at the boundary');
  assert(!/[\r\n]/.test(value), 'withEnvValue: a value is one line');
  const line = `${name}=${encodedValue(value)}`;
  const lines = source.split('\n');
  const at = lines.findIndex((candidate) => ASSIGNMENT.exec(candidate)?.[1] === name);
  if (at === -1) {
    const lead = source.length === 0 || source.endsWith('\n') ? source : `${source}\n`;
    return `${lead}${line}\n`;
  }
  return lines.map((candidate, index) => (index === at ? line : candidate)).join('\n');
}

/** The .gitignore text that ignores `file`, or undefined when a rule for it is already written. */
export function gitignoreWithEnv(source: string | undefined, file: SecretsFileName): string | undefined {
  // `*.env` matches `.env` alone; `.env*` matches every dev env file.
  const rules = file === '.env' ? [file, `/${file}`, '.env*', '*.env'] : [file, `/${file}`, '.env*'];
  const lines = (source ?? '').split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => rules.includes(line))) {
    return undefined;
  }
  const text = source ?? '';
  const lead = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
  const next = `${lead}${file}\n`;
  assert(next.startsWith(text), 'gitignoreWithEnv: the existing rules are kept as written');
  return next;
}

/**
 * Sets `name` in the project's .env. Refuses, writing nothing, when .env is
 * tracked by Git or cannot be ignored; ignoring it is added to .gitignore when
 * missing, before the secret is written.
 */
export async function writeProjectSecret(projectRoot: string, input: { readonly name: string; readonly value: string }, git: Git): Promise<IgnoreChange> {
  if (await isTracked(projectRoot, git, ENV_FILE)) {
    throw new Error('.env is tracked by Git, so a secret saved there would be published. Remove it from Git first.');
  }
  const change = writeIgnoreRule(projectRoot, ENV_FILE);
  if ((await ignoreState(projectRoot, git, ENV_FILE)) === 'not-ignored') {
    throw new Error('.gitignore does not ignore .env, so the secret was not saved. Check .gitignore for a rule that brings it back.');
  }
  const file = path.join(projectRoot, ENV_FILE);
  const before = readEnvFile(file);
  const text = withEnvValue(before ?? '', input.name, input.value);
  if (before === undefined) {
    createProjectText(file, text);
  } else {
    writeProjectText(file, text, before);
  }
  assert(readProjectEnv(projectRoot).has(input.name), 'A saved variable reads back');
  return change;
}

export function writeIgnoreRule(projectRoot: string, envFile: SecretsFileName): IgnoreChange {
  const file = path.join(projectRoot, '.gitignore');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const text = gitignoreWithEnv(before, envFile);
  if (text === undefined) {
    return 'already-ignored';
  }
  if (before === undefined) {
    createProjectText(file, text);
  } else {
    writeProjectText(file, text, before);
  }
  return 'added';
}

// `git ls-files --error-unmatch` fails for a path Git does not track, and in a
// folder that is not a repository, and both mean the file is not tracked.
export async function isTracked(projectRoot: string, git: Git, file: SecretsFileName): Promise<boolean> {
  try {
    await git(projectRoot, ['ls-files', '--error-unmatch', '--', file]);
    return true;
  } catch {
    return false;
  }
}

// `git check-ignore` exits 1 for a path it does not ignore, and 128 outside a repository.
export async function ignoreState(projectRoot: string, git: Git, file: SecretsFileName): Promise<'ignored' | 'not-ignored' | 'no-repository'> {
  try {
    await git(projectRoot, ['check-ignore', '--quiet', '--', file]);
    return 'ignored';
  } catch (error: unknown) {
    return toRecord(error)?.['code'] === 1 ? 'not-ignored' : 'no-repository';
  }
}

function readEnvFile(file: string): string | undefined {
  try {
    return fs.statSync(file).size > ENV_BYTES_MAX ? undefined : fs.readFileSync(file, 'utf8');
  } catch {
    // A project without this env file is the ordinary case.
    return undefined;
  }
}

function envValue(raw: string): string {
  const value = raw.trim();
  const quote = value.charAt(0);
  if (quote === '"' || quote === "'") {
    const close = value.lastIndexOf(quote);
    if (close > 0) {
      const inner = value.slice(1, close);
      return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
    }
  }
  return value.replace(/\s+#.*$/, '');
}

function encodedValue(value: string): string {
  return /^[\w.:/+=@-]*$/.test(value) ? value : `"${value.replace(/(["\\])/g, '\\$1')}"`;
}
