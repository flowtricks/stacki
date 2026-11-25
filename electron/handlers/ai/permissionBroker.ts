// Permission requests from agents, waiting on the person. An agent in "ask"
// mode (every new chat's default) asks before it edits or runs anything; the
// request shows as a card in the chat, and the agent's turn waits until the
// person answers — or the turn is stopped, which answers `cancelled`, as ACP
// requires of a client that cancels a prompt.
//
// Bounded: at most AI_LIMITS.permissionsPendingMax wait at once, across chats;
// a request past that is answered `cancelled` at once rather than queued.
import { assert } from '../../../shared/core/assert';
import { ok } from '../../../shared/core/result';
import type { PermissionAnswer } from '../../../shared/ipc/aiChat';
import { AI_LIMITS } from '../../../shared/properties/ai/aiLimits';
import { toPermissionRequestId, type ChatId, type PermissionRequestId } from '../../../shared/properties/ai/chatModel';
import type { AcpAnswer } from './acpConnection';

interface Waiting {
  readonly chat: ChatId;
  readonly optionIds: ReadonlySet<string>;
  readonly settle: (answer: AcpAnswer, outcome: { readonly outcome: 'selected' | 'cancelled'; readonly optionId: string | undefined }) => void;
}

/**
 * How many person-answered request ids are remembered. A repeat of an answer (a held key, a double
 * click, the card and the pinned strip both firing) arrives within moments, so a short memory is enough;
 * the cap keeps it from growing for the life of the app.
 */
const ANSWERED_MEMORY_MAX = 256;

/** How an answer fared: taken, an echo of one already taken, or aimed at nothing that waits. */
export type AnswerOutcome = 'accepted' | 'repeat' | 'unknown';

export class PermissionBroker {
  private next = 1;
  private readonly waiting = new Map<PermissionRequestId, Waiting>();
  // Requests the person answered, with the chat that asked. A cancelled or stopped request is not here:
  // an answer to it is genuinely too late, and the person is told.
  private readonly answered = new Map<PermissionRequestId, ChatId>();

  /**
   * Registers a request; `answered` hears how it ended. Undefined when too many
   * already wait: the caller answers `cancelled` itself.
   */
  ask(
    chat: ChatId,
    optionIds: readonly string[],
    answered: (outcome: { readonly outcome: 'selected' | 'cancelled'; readonly optionId: string | undefined }) => void,
  ): { readonly request: PermissionRequestId; readonly answer: Promise<AcpAnswer> } | undefined {
    assert(optionIds.length > 0, 'PermissionBroker.ask: a request offers options');
    if (this.waiting.size >= AI_LIMITS.permissionsPendingMax) {
      return undefined;
    }
    const request = toPermissionRequestId(`p${this.next}`);
    this.next += 1;
    const answer = new Promise<AcpAnswer>((resolve) => {
      this.waiting.set(request, {
        chat,
        optionIds: new Set(optionIds),
        settle: (reply, outcome) => {
          this.waiting.delete(request);
          answered(outcome);
          resolve(reply);
        },
      });
    });
    assert(this.waiting.size <= AI_LIMITS.permissionsPendingMax, 'PermissionBroker.ask: pending requests are bounded');
    return { request, answer };
  }

  /**
   * The person's answer. `repeat` when the person already answered this request (the first answer
   * stands); `unknown` when it is not waiting and was never answered (cancelled, expired, another chat's)
   * or the option is not one it offered.
   */
  answer(chat: ChatId, request: PermissionRequestId, answer: PermissionAnswer): AnswerOutcome {
    const waiting = this.waiting.get(request);
    if (waiting === undefined) {
      return this.answered.get(request) === chat ? 'repeat' : 'unknown';
    }
    if (waiting.chat !== chat) {
      return 'unknown';
    }
    if (answer.kind === 'cancel') {
      waiting.settle(cancelled(), { outcome: 'cancelled', optionId: undefined });
      this.remember(request, chat);
      return 'accepted';
    }
    if (!waiting.optionIds.has(answer.optionId)) {
      return 'unknown';
    }
    waiting.settle(ok({ outcome: { outcome: 'selected', optionId: answer.optionId } }), { outcome: 'selected', optionId: answer.optionId });
    assert(!this.waiting.has(request), 'PermissionBroker.answer: an answered request stops waiting');
    this.remember(request, chat);
    assert(this.answered.size <= ANSWERED_MEMORY_MAX, 'PermissionBroker.answer: the memory of answers is bounded');
    return 'accepted';
  }

  private remember(request: PermissionRequestId, chat: ChatId): void {
    this.answered.set(request, chat);
    if (this.answered.size > ANSWERED_MEMORY_MAX) {
      // Maps iterate in insertion order, so the first key is the oldest answer.
      const oldest = this.answered.keys().next();
      if (oldest.done !== true) {
        this.answered.delete(oldest.value);
      }
    }
  }

  /** Answers every request of `chat` (or of every chat) `cancelled`. */
  cancel(chat: ChatId | undefined): void {
    for (const [request, waiting] of [...this.waiting]) {
      if (chat === undefined || waiting.chat === chat) {
        waiting.settle(cancelled(), { outcome: 'cancelled', optionId: undefined });
        assert(!this.waiting.has(request), 'PermissionBroker.cancel: settled requests leave');
      }
    }
  }

  get pendingCount(): number {
    return this.waiting.size;
  }
}

export function cancelled(): AcpAnswer {
  return ok({ outcome: { outcome: 'cancelled' } });
}
