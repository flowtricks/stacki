// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the renderer's side of `design:session`.
// Requests are checked by the shared parser before they leave, and every reply is parsed before it is trusted.
import { parseDesignSessionReply, parseDesignSessionRequest, type DesignSessionReply, type DesignSessionRequest } from '../../../shared/ipc/designSession';

export async function designSession(request: DesignSessionRequest): Promise<DesignSessionReply> {
  const payload = parseDesignSessionRequest(request);
  const reply: unknown = await window.avb.designSession(payload);
  return parseDesignSessionReply(reply);
}
