// The renderer's side of a data file's variables (shared/properties/cmsConstants.ts):
// the listing and the edits, each reply parsed before a component sees it. A
// refusal (the file does not parse, the name is taken) is a value the view words;
// a failure to reach the file at all is the message main threw.
import { cmsTransport } from '../../ipc/editorEnvironment';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import type { Result } from '../../../shared/core/result';
import {
  parseConstantEditReply,
  parseConstantListingReply,
  type ConstantEdit,
  type ConstantListing,
  type ConstantRefusal,
} from '../../../shared/properties/cmsConstants';
import { cleanError } from '../../lib/cleanError';

/** What a request came back with: the answer, a refusal the file gave, or a failure message. */
export type ConstantAnswer<Value> =
  | { readonly kind: 'done'; readonly value: Value }
  | { readonly kind: 'refused'; readonly refusal: ConstantRefusal }
  | { readonly kind: 'failed'; readonly message: string }
  /** This window's bridge has no such methods: the app was updated without a restart. */
  | { readonly kind: 'unavailable' };

export function readCmsConstants(projectPath: string, fileRel: string): Promise<ConstantAnswer<ConstantListing>> {
  const payload = parseIpcPayload('cms:constants', { projectPath, rel: fileRel });
  return answered(parseConstantListingReply, () => cmsTransport.cmsConstants(payload));
}

export function editCmsConstants(
  projectPath: string,
  fileRel: string,
  edit: ConstantEdit,
): Promise<ConstantAnswer<{ readonly before: string; readonly after: string }>> {
  const payload = parseIpcPayload('cms:editConstants', { projectPath, rel: fileRel, edit });
  return answered(parseConstantEditReply, () => cmsTransport.editCmsConstants(payload));
}

async function answered<Value>(parse: (input: unknown) => Result<Value, ConstantRefusal>, invoke: () => Promise<unknown>): Promise<ConstantAnswer<Value>> {
  if (!cmsTransport.cmsConstantsAvailable()) {
    return { kind: 'unavailable' };
  }
  let response: unknown;
  try {
    response = await invoke();
  } catch (error: unknown) {
    return { kind: 'failed', message: cleanError(error) };
  }
  // A reply that breaks the contract is a programmer error: parsed outside the catch, so it throws.
  const parsed = parse(response);
  return parsed.ok ? { kind: 'done', value: parsed.value } : { kind: 'refused', refusal: parsed.error };
}
