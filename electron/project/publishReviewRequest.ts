// A deterministic branch lets retries recover a successful push or PR creation
// after a lost response. Closed reviews remain closed; new content gets a new branch.
import { err, ok, type Result } from '../../shared/core/result';
import { parseReviewReceipt, type ReviewReceipt } from '../../shared/properties/publishReview';
import { record, text } from '../../shared/core/boundary';
import { described } from '../../shared/properties/i18n/messageRef';

export interface ReviewRequest {
  readonly repository: string;
  readonly token: string;
  readonly base: string;
  readonly branch: string;
  readonly sha: string;
}

export async function openPublishReview(input: ReviewRequest, transport: typeof fetch = fetch): Promise<Result<ReviewReceipt>> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository)) {
    return err({ code: 'review', ...described('publish.review.error.invalidRepository') });
  }
  const owner = input.repository.split('/')[0];
  const endpoint = `https://api.github.com/repos/${input.repository}/pulls`;
  const query = new URLSearchParams({
    state: 'all',
    head: `${owner}:${input.branch}`,
    base: input.base,
    per_page: '100',
  });
  const existing = await reviewRequest(endpoint + '?' + query, input.token, undefined, transport);
  if (!existing.ok) {
    return existing;
  }
  if (!Array.isArray(existing.value) || existing.value.length >= 100) {
    return err({ code: 'review', ...described('publish.review.error.incompleteList') });
  }
  const previous: unknown = existing.value[0];
  if (previous !== undefined) {
    return reviewReceipt(input, previous);
  }
  const created = await reviewRequest(
    endpoint,
    input.token,
    {
      // i18n-ignore: the pull request title is written to GitHub for every collaborator, not shown in Stacki.
      title: 'Review website changes from Stacki',
      head: input.branch,
      base: input.base,
      // i18n-ignore: the pull request description is written to GitHub for every collaborator, not shown in Stacki.
      body: 'Submitted from Stacki. This snapshot has not been deployed by Stacki. ' + 'Review and merge through the repository workflow.',
    },
    transport,
  );
  return created.ok ? reviewReceipt(input, created.value) : created;
}

function reviewReceipt(input: ReviewRequest, data: unknown): Result<ReviewReceipt> {
  // This is an external response parser; malformed shapes are operating failures.
  try {
    const value = record(data);
    if (value['state'] !== 'open') {
      return err({
        code: 'review-closed',
        ...described('publish.review.error.closed'),
      });
    }
    const url = text(value['html_url']);
    if (!url.startsWith(`https://github.com/${input.repository}/pull/`)) {
      return err({ code: 'review', ...described('publish.review.error.differentRepository') });
    }
    return ok(parseReviewReceipt({ sha: input.sha, branch: input.branch, url }));
  } catch {
    return err({ code: 'review-response', ...described('publish.review.error.invalidReceipt') });
  }
}

async function reviewRequest(
  url: string,
  token: string,
  body: Readonly<Record<string, string>> | undefined,
  transport: typeof fetch,
): Promise<Result<unknown>> {
  const response = await transport(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      // i18n-ignore: HTTP header value or request path, protocol text.
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      // i18n-ignore: HTTP header value or request path, protocol text.
      'User-Agent': 'Stacki',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  }).then(ok, () =>
    err({
      code: 'review-network',
      ...described('publish.review.error.interrupted'),
    }),
  );
  if (!response.ok) {
    return response;
  }
  if (!response.value.ok) {
    return err({
      code: 'review-http',
      ...described('publish.review.error.requestFailed', { status: response.value.status }),
    });
  }
  return readReviewResponse(response.value);
}

async function readReviewResponse(response: Response): Promise<Result<unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return err({ code: 'review-response', ...described('publish.review.error.emptyResponse') });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (let index = 0; index < 1024; index++) {
      const part = await reader.read();
      if (part.done) {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        return ok(value);
      }
      const chunk: unknown = part.value;
      if (!(chunk instanceof Uint8Array)) {
        return err({
          code: 'review-response',
          ...described('publish.review.error.invalidChunk'),
        });
      }
      size += chunk.length;
      if (size > 1024 * 1024) {
        break;
      }
      chunks.push(chunk);
    }
    return err({ code: 'review-response', ...described('publish.review.error.responseLimit') });
  } catch {
    return err({
      code: 'review-response',
      ...described('publish.review.error.unreadable'),
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
