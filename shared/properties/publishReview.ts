// Review submissions are not published revisions. Their receipt never authorizes
// production deployment, asset cleanup, or advancing a draft's synchronization base.
import { object, text } from '../core/boundary';

export interface ReviewReceipt {
  readonly sha: string;
  readonly branch: string;
  readonly url: string;
}

export type GitHubWorkflow = { readonly kind: 'direct' } | { readonly kind: 'pull-request' };

export function parseGitHubWorkflow(input: unknown): GitHubWorkflow {
  const value = object({ kind: text })(input);
  if (value.kind === 'direct' || value.kind === 'pull-request') {
    return { kind: value.kind };
  }
  throw new Error('Choose direct publishing or pull request review.');
}

export function parseReviewReceipt(input: unknown): ReviewReceipt {
  const value = object({ sha: text, branch: text, url: text })(input);
  if (!/^[a-f0-9]{40}$/.test(value.sha)) {
    throw new Error('Invalid review commit.');
  }
  if (!/^stacki\/review-[a-f0-9]{40}-[a-f0-9]{40}$/.test(value.branch)) {
    throw new Error('Invalid review branch.');
  }
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d{0,9}$/.test(value.url)) {
    throw new Error('Invalid pull request URL.');
  }
  return value;
}

export function reviewBranch(parent: string, tree: string): string {
  if (!/^[a-f0-9]{40}$/.test(parent) || !/^[a-f0-9]{40}$/.test(tree)) {
    // i18n-ignore: programmer error; callers pass Git object ids they already validated.
    throw new Error('Review requires validated Git objects.');
  }
  // i18n-ignore: a Git branch name, not interface text.
  return `stacki/review-${parent}-${tree}`;
}
