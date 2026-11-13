import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Result } from '../../shared/core/result';
import type { ConversionResult, ImageFormat } from '../../shared/ipc/assetConversion';
import { parseImagePath } from '../../shared/ipc/assetConversion';
import { documentHost } from '../documents/documentWrites';
import { assetAbs } from './assetFiles';
import { isPathWithin } from '../lib/platform';
import { encodeImage, IMAGE_BYTES_MAX } from './imageEncoder';
import { planImageReferences, imageReferenceDigest } from './imageReferences';
import type { ImageReferenceEdit, ImageAliases } from './imageReferences';
import { translateMain } from '../lib/mainLocale';

export async function convertImage(options: {
  readonly projectPath: string;
  readonly rel: string;
  readonly format: ImageFormat;
  readonly aliases?: ImageAliases;
  readonly trash: (file: string) => Promise<void>;
}): Promise<Result<ConversionResult, string>> {
  const rel = parseImagePath(options.rel);
  const prepared = prepareImage(options.projectPath, rel, options.format);
  if (!prepared.ok) {
    return prepared;
  }
  const { from, to, bytes } = prepared.value;
  const encoded = await encodeImage(bytes, options.format);
  if (!encoded.ok) {
    return encoded;
  }
  const staged = stageImage(options.projectPath, from, to, encoded.value, options.aliases ?? []);
  if (!staged.ok) {
    return staged;
  }
  const unchanged = verifyImages(from, bytes, to, encoded.value);
  if (!unchanged.ok) {
    return unchanged;
  }
  const references = applyReferences(staged.value);
  if (!references.ok) {
    return {
      ok: false,
      error: references.error + ' Both images were kept so references still work.',
    };
  }
  try {
    const verified = verifyImages(from, bytes, to, encoded.value);
    if (!verified.ok) {
      return verified;
    }
    await options.trash(from);
  } catch (error: unknown) {
    return { ok: false, error: translateMain('error.images.referencesKept', { reason: String(error) }) };
  }
  return {
    ok: true,
    value: {
      rel: path.relative(options.projectPath, to).split(path.sep).join('/'),
      references: staged.value.length,
      bytesBefore: bytes.length,
      bytesAfter: encoded.value.length,
    },
  };
}

function prepareImage(projectPath: string, rel: string, format: ImageFormat) {
  try {
    const from = assetAbs(projectPath, rel);
    const to = from.replace(/\.[^.]+$/, `.${format}`);
    const root = fs.realpathSync(projectPath);
    if (!isPathWithin(root, fs.realpathSync(from)) || fs.lstatSync(from).isSymbolicLink()) {
      throw new Error(translateMain('error.images.outsideProject'));
    }
    if (fs.existsSync(to)) {
      throw new Error(translateMain('error.images.targetExists', { name: path.basename(to) }));
    }
    if (fs.statSync(from).size > IMAGE_BYTES_MAX) {
      throw new Error(translateMain('error.images.tooLarge'));
    }
    return { ok: true as const, value: { from, to, bytes: fs.readFileSync(from) } };
  } catch (error: unknown) {
    return { ok: false as const, error: String(error) };
  }
}
function stageImage(projectPath: string, from: string, to: string, bytes: Buffer, aliases: ImageAliases) {
  try {
    const edits = planImageReferences(projectPath, from, to, aliases);
    // Exclusive binary creation never overwrites an asset; text uses actors below.
    if (!isPathWithin(fs.realpathSync(projectPath), fs.realpathSync(path.dirname(to)))) {
      throw new Error(translateMain('error.images.directoryMoved'));
    }
    fs.writeFileSync(to, bytes, { flag: 'wx', mode: fs.statSync(from).mode & 0o777 });
    if (!fs.readFileSync(to).equals(bytes)) {
      throw new Error(translateMain('error.images.verificationFailed'));
    }
    return { ok: true as const, value: edits };
  } catch (error: unknown) {
    return { ok: false as const, error: String(error) };
  }
}
function applyReferences(edits: readonly ImageReferenceEdit[]): Result<void, string> {
  const host = documentHost();
  const result = host.documents.withLeases(edits, (ordered): Result<void, string> => {
    const applied: ImageReferenceEdit[] = [];
    for (const edit of ordered) {
      const report = host.documents.writeText(edit.file, edit.after, imageReferenceDigest(edit.before));
      if (report.tag !== 'applied') {
        let rollbackFailures = 0;
        for (const previous of [...applied].reverse()) {
          const rollback = host.documents.writeText(previous.file, previous.before, imageReferenceDigest(previous.after));
          if (rollback.tag !== 'applied') {
            rollbackFailures += 1;
          }
        }
        return {
          ok: false,
          error: translateMain('error.images.rollbackFailed', { file: edit.file, reason: report.tag, count: rollbackFailures }),
        };
      }
      host.noteWrite(edit.file);
      applied.push(edit);
    }
    return { ok: true, value: undefined };
  });
  return result.ok ? result.value : result;
}

function verifyImages(from: string, before: Buffer, to: string, after: Buffer): Result<void, string> {
  try {
    for (const [file, bytes] of [
      [from, before],
      [to, after],
    ] as const) {
      if (fs.statSync(file).size !== bytes.length || !fs.readFileSync(file).equals(bytes)) {
        return { ok: false, error: translateMain('error.images.changedDuringConversion') };
      }
    }
    return { ok: true, value: undefined };
  } catch (error: unknown) {
    return {
      ok: false,
      error: translateMain('error.images.verifyFailed', { reason: String(error) }),
    };
  }
}
