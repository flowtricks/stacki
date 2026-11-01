// A deterministic branch lets retries recover a successful push or PR creation
// after a lost response. Closed reviews remain closed; new content gets a new branch.
import { err, ok, type Result } from '../../shared/core/result';
import { parseReviewReceipt, type ReviewReceipt } from '../../shared/properties/publishReview';
import { record, text } from '../../shared/core/boundary';

export interface ReviewRequest {
  readonly repository: string;
  readonly token: string;
  readonly base: string;
  readonly branch: string;
  readonly sha: string;
}

export async function openPublishReview(input: ReviewRequest, transport: typeof fetch = fetch): Promise<Result<ReviewReceipt>> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository)) {
    return err({ code: 'review', message: 'Invalid review repository.' });
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
    return err({ code: 'review', message: 'GitHub returned an incomplete review list.' });
  }
  const previous: unknown = existing.value[0];
  if (previous !== undefined) {
    return reviewReceipt(input, previous);
  }
  const created = await reviewRequest(
    endpoint,
    input.token,
    {
      title: 'Review website changes from Stacki',
      head: input.branch,
      base: input.base,
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
        message: 'This snapshot already has a closed review. ' + 'Sync the base branch or make a new change before submitting.',
      });
    }
    const url = text(value['html_url']);
    if (!url.startsWith(`https://github.com/${input.repository}/pull/`)) {
      return err({ code: 'review', message: 'GitHub returned a different repository review.' });
    }
    return ok(parseReviewReceipt({ sha: input.sha, branch: input.branch, url }));
  } catch {
    return err({ code: 'review-response', message: 'GitHub returned an invalid review receipt.' });
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
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Stacki',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  }).then(ok, () =>
    err({
      code: 'review-network',
      message: 'Review request interrupted. Retry to recover the existing branch or pull request.',
    }),
  );
  if (!response.ok) {
    return response;
  }
  if (!response.value.ok) {
    return err({
      code: 'review-http',
      message: `GitHub review request failed (${response.value.status}). ` + 'Check pull request write permission, then retry.',
    });
  }
  return readReviewResponse(response.value);
}

async function readReviewResponse(response: Response): Promise<Result<unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return err({ code: 'review-response', message: 'GitHub returned an empty review response.' });
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
          message: 'GitHub returned an invalid response chunk.',
        });
      }
      size += chunk.length;
      if (size > 1024 * 1024) {
        break;
      }
      chunks.push(chunk);
    }
    return err({ code: 'review-response', message: 'GitHub review response exceeds its limit.' });
  } catch {
    return err({
      code: 'review-response',
      message: 'GitHub returned an unreadable review response.',
    });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
