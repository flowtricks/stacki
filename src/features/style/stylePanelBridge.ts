import { styleTransport } from '../../ipc/editorEnvironment';
import type { Result } from '../../../shared/core/result';
import { count, list, object, pathText, text } from '../../../shared/core/boundary';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { cleanError } from '../../lib/cleanError';

const styleFile = object({ rel: pathText, name: text, path: pathText, size: count });

export function parseStyleFiles(input: unknown) {
  return object({ files: list(styleFile) })(input).files;
}

async function request(invoke: () => Promise<unknown>): Promise<Result<ReturnType<typeof parseStyleFiles>, string>> {
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { ok: false, error: cleanError(error) };
  }
  return { ok: true, value: parseStyleFiles(response) };
}

export function readStyleFiles(projectPath: string) {
  const payload = parseIpcPayload('style:listFiles', projectPath);
  return request(() => styleTransport.listStyleFiles(payload));
}

export function readAstroStyleFiles(projectPath: string) {
  const payload = parseIpcPayload('style:listAstroStyles', projectPath);
  return request(() => styleTransport.listAstroStyleFiles(payload));
}
