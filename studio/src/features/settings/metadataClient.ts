import { request } from '../project/projectClient';
import { parseMetadataFile, type MetadataKind } from '../../../vendor/stacki/shared/properties/projectMetadata';

export async function readMetadata(_project: string, kind: MetadataKind) {
  return parseMetadataFile(await request(`/studio/api/metadata?kind=${kind}`));
}

export async function createDefaultsCanvas(_project: string, file: string, source: string) {
  return parseCanvasFile(
    await request('/studio/api/defaults-canvas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, source }),
    }),
  );
}

export async function removeDefaultsCanvas(_project: string, file: string): Promise<void> {
  await request('/studio/api/defaults-canvas', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file }),
  });
}
export async function writeMetadata(_project: string, input: { readonly kind: MetadataKind; readonly source: string; readonly base?: string }) {
  return parseMetadataFile(
    await request('/studio/api/metadata', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
  );
}
import { parseCanvasFile } from '../../../vendor/stacki/shared/properties/defaultsCanvas';
