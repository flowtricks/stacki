import { record, string } from '../../shared/validation';

export interface HistoryInfo {
  readonly repository: string;
  readonly branch: string;
  readonly branches: readonly string[];
  readonly head: string;
}

export function parseHistoryInfo(input: unknown): HistoryInfo {
  const value = record(input);
  const branches = value['branches'];
  const repository = string(value['repository'], 200);
  const head = string(value['head'], 40);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split('/').includes('..') || !/^[a-f0-9]{40}$/.test(head)) {
    throw new Error('Invalid repository history.');
  }
  if (!Array.isArray(branches) || branches.length > 100) {
    throw new Error('Invalid history branches.');
  }
  return {
    repository,
    head,
    branch: string(value['branch'], 250),
    branches: branches.map((branch: unknown) => string(branch, 250)),
  };
}
