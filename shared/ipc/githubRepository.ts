import { assert } from '../core/assert';
import { list, text, record, boolean, pathText } from '../core/boundary';
import { parseOptionalMessageRef } from '../core/i18n/messageReference';

export function parseGitHubRepository(input: unknown): string {
  const value = text(input);
  if (value.length > 140 || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[\w.-]{1,100}$/.test(value)) {
    throw new Error('Enter a GitHub repository as owner/name.');
  }
  const segments = value.split('/');
  assert(segments.length === 2, 'Repository parser produces exactly owner/name');
  const name = segments[1];
  assert(name !== undefined, 'Repository parser produces a name');
  if (name === '.' || name === '..') {
    throw new Error('Invalid GitHub repository name.');
  }
  return value;
}

export function parseGitHubRepositories(input: unknown): readonly string[] {
  const repositories = list(parseGitHubRepository)(input);
  if (repositories.length > 100) {
    throw new Error('GitHub repository list exceeds limit.');
  }
  return repositories;
}

export function parseCloneResult(input: unknown) {
  const value = record(input);
  if (boolean(value['canceled'])) {
    return { canceled: true as const };
  }
  if (value['error'] !== undefined) {
    const errorRef = parseOptionalMessageRef(value['errorRef']);
    return errorRef === undefined
      ? { canceled: false as const, error: text(value['error']) }
      : { canceled: false as const, error: text(value['error']), errorRef };
  }
  return { canceled: false as const, projectPath: pathText(value['projectPath']) };
}
