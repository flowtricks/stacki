// `stacki-model://whisper/<model>/<revision>/<file>`: how the Whisper worker reads the downloaded
// model. A scheme instead of IPC because the worker streams 80 MB straight into the runtime; through
// IPC it would be copied twice into the renderer first. The scheme serves only the files the
// manifest pins, of an installed model, read-only: any page can ask (a preview frame included), but
// all it could get is a public model's weights. Never a project file, never another path.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { assert } from '../../shared/core/assert';
import { WHISPER_MODELS, parseWhisperModelId, type WhisperModel } from '../../shared/properties/voice/whisperModels';
import { fileTarget } from './dictationDownload';
import { modelDirectory, readInstall } from './dictationStore';

export const MODEL_SCHEME = 'stacki-model';

/** `standard` gives the scheme an origin, `supportFetchAPI` lets a worker fetch it, `corsEnabled` lets the file:// page's worker read it. */
export const MODEL_SCHEME_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } as const;

/** The base address of a model's files, as the worker is told it. */
export function modelBaseURL(model: WhisperModel): string {
  const base = `${MODEL_SCHEME}://whisper/${model.id}/${model.revision}/`;
  assert(base.endsWith('/'), 'modelBaseURL: a folder address');
  assert(base.includes(model.revision), 'modelBaseURL: pinned to the revision');
  return base;
}

/** The response for one request to the scheme. */
export async function serveModelRequest(requestURL: string, method: string, root: string): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(undefined, { status: 405 });
  }
  const located = locate(requestURL);
  if (located === undefined) {
    return new Response(undefined, { status: 404 });
  }
  const { model, file } = located;
  // Only a verified model: a half-downloaded file would fail inside the runtime with a worse message.
  if ((await readInstall(root, model)).kind !== 'installed') {
    return new Response(undefined, { status: 404 });
  }
  const target = fileTarget(modelDirectory(root, model), file);
  const size = (await stat(target)).size;
  assert(size === file.sizeBytes, 'serveModelRequest: an installed file has its manifest size');
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Length': String(size),
    'Content-Type': file.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
    'Cache-Control': 'no-store',
  };
  if (method === 'HEAD') {
    return new Response(undefined, { status: 200, headers });
  }
  return new Response(fileStream(target), { status: 200, headers });
}

// The model and manifest file an address names, or undefined for anything else.
function locate(requestURL: string): { readonly model: WhisperModel; readonly file: WhisperModel['files'][number] } | undefined {
  let url: URL;
  try {
    url = new URL(requestURL);
  } catch {
    return undefined;
  }
  if (url.protocol !== `${MODEL_SCHEME}:` || url.hostname !== 'whisper' || url.search !== '' || url.username !== '') {
    return undefined;
  }
  const [, id, revision, ...rest] = decodeURIComponent(url.pathname).split('/');
  let model: WhisperModel;
  try {
    model = WHISPER_MODELS[parseWhisperModelId(id)];
  } catch {
    return undefined;
  }
  if (revision !== model.revision) {
    return undefined;
  }
  const filePath = rest.join('/');
  const file = model.files.find((candidate) => candidate.path === filePath);
  return file === undefined ? undefined : { model, file };
}

// The file as a web stream, read in the file system's own chunks: a model file is tens of megabytes,
// so it is never held whole in the main process.
function fileStream(target: string): ReadableStream<Uint8Array> {
  const chunks = createReadStream(target)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done === true) {
        controller.close();
        return;
      }
      const chunk: unknown = next.value;
      if (chunk instanceof Uint8Array) {
        controller.enqueue(chunk);
      } else {
        controller.error(new Error('fileStream: a file read returns bytes'));
      }
    },
    async cancel() {
      await chunks.return?.();
    },
  });
}
