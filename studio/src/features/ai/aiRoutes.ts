import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ProposalStore } from './proposalStore';
import { availableModels } from './configuration';

export async function aiRoute(proposals: ProposalStore, request: IncomingMessage, response: ServerResponse, pathname: string, readBody: () => Promise<string>) {
  if (!pathname.startsWith('/studio/api/ai/')) {
    return false;
  }
  response.setHeader('Content-Type', 'application/json');
  if (pathname === '/studio/api/ai/models' && request.method === 'GET') {
    response.end(JSON.stringify(await availableModels()));
    return true;
  }
  if (pathname === '/studio/api/ai/propose' && request.method === 'POST') {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      response.end(JSON.stringify(await proposals.create(JSON.parse(await readBody()), controller.signal)));
    } finally {
      response.off('close', cancel);
    }
    return true;
  }
  if (pathname === '/studio/api/ai/apply' && request.method === 'POST') {
    response.end(JSON.stringify(await proposals.apply(JSON.parse(await readBody()))));
    return true;
  }
  return false;
}
