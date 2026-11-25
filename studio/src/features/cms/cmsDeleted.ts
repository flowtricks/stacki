import { readFile, rm } from 'node:fs/promises';
import { safePath } from '../project/projectServer';
import { sourcePath } from '../../shared/validation';
export const CMS_DELETED = 'src/data/studio-cms-deleted.json';
function deletedFiles(source: string): readonly string[] {
  const value: unknown = JSON.parse(source);
  if (!Array.isArray(value) || value.length > 1000) {
    throw new Error('Invalid CMS deletion inventory');
  }
  return value.map(sourcePath);
}
export function withCmsDeletions(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  const deleted = new Set(deletedFiles(before.get(CMS_DELETED) ?? '[]'));
  for (const file of before.keys()) {
    if (!after.has(file)) {
      deleted.add(file);
    }
  }
  for (const file of after.keys()) {
    deleted.delete(file);
  }
  const next = new Map(after);
  if (deleted.size || before.has(CMS_DELETED)) {
    next.set(CMS_DELETED, JSON.stringify([...deleted].sort(), null, 2) + '\n');
  }
  return next;
}
export async function restoreCmsDeletions(root: string) {
  let source: string;
  try {
    source = await readFile(await safePath(root, CMS_DELETED), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  for (const file of deletedFiles(source)) {
    if (file === CMS_DELETED) {
      throw new Error('Invalid CMS deletion target');
    }
    await rm(await safePath(root, file), { force: true });
  }
}
