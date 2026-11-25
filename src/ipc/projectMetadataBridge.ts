import { parseIpcPayload } from '../../shared/ipc/ipcPayloads';
import { parseMetadataResult, type MetadataKind } from '../../shared/properties/projectMetadata';

// Moves whenever the app writes project metadata (the component defaults among it), so a read kept
// for a moment (src/app/model/componentWarm.ts) is never older than the last write.
let metadataVersion = 0;
export const metadataVersionNow = (): number => metadataVersion;
// Who rereads metadata after the app writes it: the component editing settings the canvas and the panel follow.
const metadataWritten = new Set<() => void>();
export function onMetadataWrite(listener: () => void): () => void {
  metadataWritten.add(listener);
  return () => metadataWritten.delete(listener);
}

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
  const canvas = parseCanvasFile(await window.avb.createDefaultsCanvas(input));
  metadataVersion += 1;
  return canvas;
}

export async function removeDefaultsCanvas(projectPath: string, file: string): Promise<void> {
  const input = parseIpcPayload('project:removeDefaultsCanvas', { projectPath, file });
  await window.avb.removeDefaultsCanvas(input);
  metadataVersion += 1;
}

export async function writeMetadata(projectPath: string, write: { readonly kind: MetadataKind; readonly source: string; readonly base?: string }) {
  const input = parseIpcPayload('project:writeMetadata', { projectPath, write });
  const result = parseMetadataResult(await window.avb.writeProjectMetadata(input));
  metadataVersion += 1;
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  metadataWritten.forEach((listener) => listener());
  return result.value;
}
import { parseCanvasFile } from '../../shared/properties/defaultsCanvas';
