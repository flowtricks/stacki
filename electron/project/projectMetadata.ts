import { ensureExcluded } from '../lib/projectExclusions';
import { createHash } from 'node:crypto';
import { toDigest } from '../../shared/core/brand';
// Metadata uses the same witnessed document writes as pages, so stale settings cannot overwrite.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, ok, type Result } from '../../shared/core/result';
import { METADATA_FILES, metadataSource, validateMetadata, type MetadataFile, type MetadataKind } from '../../shared/properties/projectMetadata';
import { documentHost, describeWriteReport } from '../documents/documentWrites';
import { readSource } from '../lib/mainLimits';

export function readProjectMetadata(root: string, kind: MetadataKind): Result<MetadataFile> {
  const target = metadataPath(root, kind);
  if (!target.ok) {
    return target;
  }
  try {
    if (!fs.existsSync(target.value)) {
      return ok({});
    }
    return ok({ source: metadataSource(readSource(target.value)) });
  } catch (error: unknown) {
    return metadataFailure(error);
  }
}

export function writeProjectMetadata(
  root: string,
  input: { readonly kind: MetadataKind; readonly source: string; readonly base?: string },
): Result<MetadataFile> {
  try {
    validateMetadata(input.kind, input.source);
  } catch (error: unknown) {
    return metadataFailure(error);
  }
  const target = metadataPath(root, input.kind);
  if (!target.ok) {
    return target;
  }
  const current = readProjectMetadata(root, input.kind);
  if (!current.ok) {
    return current;
  }
  if (current.value.source !== input.base) {
    return err({ code: 'conflict', message: 'Project settings changed. Reload before saving.' });
  }
  try {
    fs.mkdirSync(path.dirname(target.value), { recursive: true });
  } catch (error: unknown) {
    return metadataFailure(error);
  }
  const host = documentHost();
  if (input.base === undefined) {
    const created = host.documents.create(target.value, input.source);
    if (!created.ok) {
      return created;
    }
  } else {
    const checksum = toDigest(createHash('sha256').update(input.base).digest('hex'));
    const report = host.documents.writeText(target.value, input.source, checksum);
    if (report.tag !== 'applied') {
      return err({ code: 'write-failed', message: describeWriteReport(target.value, report) });
    }
  }
  // Migrate legacy local exclusions before these project settings are committed.
  ensureExcluded(root);
  host.noteWrite(target.value);
  const saved = readProjectMetadata(root, input.kind);
  if (saved.ok && saved.value.source !== input.source) {
    return err({
      code: 'write-race',
      message: 'Project settings changed during save. Reload to inspect them.',
    });
  }
  return saved;
}

function metadataPath(root: string, kind: MetadataKind): Result<string> {
  try {
    const canonical = fs.realpathSync(root);
    const directory = path.join(canonical, '.stacki');
    const target = path.join(canonical, METADATA_FILES[kind]);
    for (const candidate of [directory, target]) {
      if (fs.existsSync(candidate)) {
        if (fs.lstatSync(candidate).isSymbolicLink()) {
          return err({
            code: 'invalid-path',
            message: 'Project settings cannot be symbolic links.',
          });
        }
      }
    }
    return ok(target);
  } catch (error: unknown) {
    return metadataFailure(error);
  }
}

function metadataFailure(error: unknown): Result<never> {
  return err({
    code: 'metadata',
    message: error instanceof Error ? error.message : 'Could not access project settings.',
  });
}
