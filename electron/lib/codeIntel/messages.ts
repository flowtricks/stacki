// The envelope between main and the intelligence process: a number to pair an answer with its question. What is inside
// is parsed by the contract (shared/ipc/codeIntel.ts) on whichever side receives it.
import { count, record } from '../../../shared/core/boundary';
import type { CodeIntelReply } from '../../../shared/ipc/codeIntel';

export interface ServiceAnswer {
  readonly id: number;
  readonly reply: CodeIntelReply;
}

export function parseServiceMessage(input: unknown): { readonly id: number; readonly request: unknown } {
  const source = record(input);
  return { id: count(source['id']), request: source['request'] };
}

export function parseServiceAnswer(input: unknown): { readonly id: number; readonly reply: unknown } {
  const source = record(input);
  return { id: count(source['id']), reply: source['reply'] };
}
