import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseMetadataResult, type MetadataKind } from '../../shared/properties/projectMetadata';

export async function readMetadata(projectPath: string, kind: MetadataKind) {
  const input = parseIpcPayload('project:metadata', { projectPath, kind });
  const result = parseMetadataResult(await window.avb.projectMetadata(input));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export async function createDefaultsCanvas(projectPath: string, file: string, source: string) {
  const input = parseIpcPayload('project:createDefaultsCanvas', {
    projectPath,
    canvas: { file, source },
  });
  return parseCanvasFile(await window.avb.createDefaultsCanvas(input));
}

export async function removeDefaultsCanvas(projectPath: string, file: string): Promise<void> {
  const input = parseIpcPayload('project:removeDefaultsCanvas', { projectPath, file });
  await window.avb.removeDefaultsCanvas(input);
}

export async function writeMetadata(projectPath: string, write: { readonly kind: MetadataKind; readonly source: string; readonly base?: string }) {
  const input = parseIpcPayload('project:writeMetadata', { projectPath, write });
  const result = parseMetadataResult(await window.avb.writeProjectMetadata(input));
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}
import { parseCanvasFile } from '../../shared/properties/defaultsCanvas';
