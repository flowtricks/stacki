import { boolean, count, list, object, optional, record, text } from '../core/boundary';
import { assert } from '../core/assert';
import { parseReviewReceipt, type ReviewReceipt } from './publishReview';
import { CUSTOM_DEPLOYS, type CustomDeploy, type PublishTarget } from './publishConfig';
import { DESTINATION_LIMITS, parseDestinationId, parseDestinationLabel, type DestinationId } from './publishDestinations';
import { parseMessageRef, type MessageRef } from '../core/i18n/messageReference';

export type PublishDestinationState = 'current' | 'pending' | 'unknown' | 'unconfigured';

export interface PublishAvailability {
  readonly github: Exclude<PublishDestinationState, 'unconfigured'>;
  readonly hosting: PublishDestinationState;
  readonly githubPush?: GitHubPush;
  readonly hostingPublishedAtMs?: number;
  /** Each added destination's status, from its own record: publishing one never changes another's. Absent with none. */
  readonly destinations?: readonly DestinationStatus[];
}

export interface DestinationStatus {
  readonly id: DestinationId;
  readonly state: Exclude<PublishDestinationState, 'unconfigured'>;
  readonly publishedAtMs?: number;
  readonly url?: string;
}

const DEPLOYMENT_URL_CHARS_MAX = 512;

/** A link to what was published: an https address with no credentials. */
export function parseDeploymentURL(input: unknown): string {
  const value = text(input);
  assert(value.length <= DEPLOYMENT_URL_CHARS_MAX, 'Deployment URL exceeds limit');
  const url = new URL(value);
  assert(url.protocol === 'https:', 'Deployment URL must use HTTPS');
  assert(url.username === '', 'Deployment URL cannot contain a username');
  assert(url.password === '', 'Deployment URL cannot contain a password');
  return value;
}

export interface GitHubPush {
  readonly commits: number;
  readonly repositoryUrl: string;
}

export const UNKNOWN_PUBLISH_AVAILABILITY: PublishAvailability = {
  github: 'unknown',
  hosting: 'unknown',
};

/**
 * What the main Publish half of the split button shows. `current` means the default target has
 * nothing left to commit, push or deploy, read from the same destination states the menu rows
 * use, so the button and the rows can never disagree. The button then rests as a neutral,
 * disabled control while its menu half stays open for settings.
 *
 * `ready` is only ever the answer to a check that confirmed changes. `unconfirmed` is "no
 * check has answered yet": it looks neutral but stays clickable (Publish checks again itself),
 * so the accent never appears for changes nobody has confirmed.
 */
export type PublishButtonState = 'ready' | 'current' | 'unconfirmed';

type DestinationNeed = 'done' | 'needed' | 'unconfirmed';

export function publishButtonState(availability: PublishAvailability, target: PublishTarget): PublishButtonState {
  switch (target) {
    case 'github':
      return buttonStateOf([githubNeed(availability.github)]);
    case 'hosting':
      return buttonStateOf([hostingTargetNeed(availability.hosting)]);
    case 'all':
      // Publishing everything skips a destination that is not set up, so an unconfigured host
      // is as finished as a current one.
      return buttonStateOf([githubNeed(availability.github), hostingNeed(availability.hosting)]);
  }
}

function buttonStateOf(needs: readonly DestinationNeed[]): PublishButtonState {
  if (needs.includes('needed')) {
    return 'ready';
  }
  if (needs.includes('unconfirmed')) {
    return 'unconfirmed';
  }
  return 'current';
}

function githubNeed(state: PublishAvailability['github']): DestinationNeed {
  switch (state) {
    case 'current':
      return 'done';
    case 'pending':
      return 'needed';
    case 'unknown':
      return 'unconfirmed';
  }
}

function hostingNeed(state: PublishDestinationState): DestinationNeed {
  switch (state) {
    case 'current':
    case 'unconfigured':
      return 'done';
    case 'pending':
      return 'needed';
    case 'unknown':
      return 'unconfirmed';
  }
}

// Hosting as the only default: an unconfigured host is not finished, the click opens its setup.
function hostingTargetNeed(state: PublishDestinationState): DestinationNeed {
  return state === 'unconfigured' ? 'needed' : hostingNeed(state);
}

export function parsePublishAvailability(input: unknown): PublishAvailability {
  const value = object({
    github: parseDestinationState,
    hosting: parseDestinationState,
    githubPush: optional(parseGitHubPush),
    hostingPublishedAtMs: optional(count),
    destinations: optional(parseDestinationStatuses),
  })(input);
  assert(value.github !== 'unconfigured', 'GitHub is always a publishing destination');
  if (value.github === 'current') {
    if (value.githubPush !== undefined) {
      assert(value.githubPush.commits === 0, 'Current GitHub status cannot have commits to push');
    }
  }
  return { ...value, github: value.github };
}

function parseDestinationStatuses(input: unknown): readonly DestinationStatus[] {
  const statuses = list(parseDestinationStatus)(input);
  assert(statuses.length <= DESTINATION_LIMITS.destinationsMax, 'Destination statuses stay bounded');
  assert(new Set(statuses.map((status) => status.id)).size === statuses.length, 'Each destination has one status');
  return statuses;
}

function parseDestinationStatus(input: unknown): DestinationStatus {
  const value = object({ id: parseDestinationId, state: parseDestinationState, publishedAtMs: optional(count), url: optional(parseDeploymentURL) })(input);
  assert(value.state !== 'unconfigured', 'A saved destination is configured');
  return { ...value, state: value.state };
}

export function parseGitHubPush(input: unknown): GitHubPush {
  const value = object({ commits: count, repositoryUrl: text })(input);
  assert(value.commits <= 1_000_000, 'GitHub push commit count exceeds limit');
  assert(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(value.repositoryUrl), 'GitHub repository link must be a repository on github.com');
  return value;
}

function parseDestinationState(input: unknown): PublishDestinationState {
  assert(typeof input === 'string', 'Publish destination state must be a string');
  switch (input) {
    case 'current':
    case 'pending':
    case 'unknown':
    case 'unconfigured':
      return input;
    default:
      throw new Error('Invalid publish destination state.');
  }
}

export type DesktopPublishState =
  | ({ readonly kind: 'review-open' } & ReviewReceipt)
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly step: string;
      /** The translatable form of `step`; absent from older producers, which show the English `step`. */
      readonly stepRef?: MessageRef | undefined;
      readonly progress?: DesktopPublishProgress;
      /** Absent for production. */
      readonly destination?: PublishedDestination | undefined;
    }
  | {
      readonly kind: 'done';
      readonly github: boolean;
      readonly hosting: boolean;
      /** Set for a custom host, so the popup says only what Stacki saw happen, never that the site is live. */
      readonly handoff?: CustomDeploy | undefined;
      /** Absent for production. */
      readonly destination?: PublishedDestination | undefined;
    }
  | {
      readonly kind: 'failed';
      readonly message: string;
      /** The translatable form of `message` when Stacki wrote the sentence; free-form tool output has none. */
      readonly messageRef?: MessageRef | undefined;
      readonly github: boolean;
      readonly hosting: boolean;
      readonly handoff?: CustomDeploy | undefined;
      readonly destination?: PublishedDestination | undefined;
    };

/** The destination a publish is about, with the label it had when the publish started. */
export interface PublishedDestination {
  readonly id: DestinationId;
  readonly label: string;
}

export interface DesktopPublishProgress {
  readonly completed: number;
  readonly total: number;
}

export function parseDesktopPublishProgress(input: unknown): DesktopPublishProgress {
  const value = object({ completed: count, total: count })(input);
  assert(value.total >= 3, 'Publish progress must have at least 3 stages');
  assert(value.total <= 5, 'Publish progress cannot exceed 5 stages');
  assert(value.completed < value.total, 'Running publish progress must be incomplete');
  return value;
}

export function parseDesktopPublishState(input: unknown): DesktopPublishState {
  const value = record(input);
  switch (value['kind']) {
    case 'review-open':
      return { kind: 'review-open', ...parseReviewReceipt(value) };
    case 'idle':
      return { kind: 'idle' };
    case 'running':
      return {
        kind: 'running',
        ...object({ step: text, progress: optional(parseDesktopPublishProgress) })(value),
        ...destinationField(value['destination']),
        ...stepRefField(optionalRef(value, 'stepRef')),
      };
    case 'done':
      return {
        kind: 'done',
        ...object({ github: boolean, hosting: boolean })(value),
        ...handoffField(value['handoff']),
        ...destinationField(value['destination']),
      };
    case 'failed':
      return {
        kind: 'failed',
        ...object({ message: text, github: boolean, hosting: boolean })(value),
        ...handoffField(value['handoff']),
        ...destinationField(value['destination']),
        ...messageRefField(optionalRef(value, 'messageRef')),
      };
    default:
      throw new Error('Invalid publish status.');
  }
}

function destinationField(input: unknown): { readonly destination?: PublishedDestination } {
  return input === undefined ? {} : { destination: object({ id: parseDestinationId, label: parseDestinationLabel })(input) };
}

function handoffField(input: unknown): { readonly handoff?: CustomDeploy } {
  if (input === undefined) {
    return {};
  }
  const handoff = CUSTOM_DEPLOYS.find((entry) => entry === input);
  assert(handoff !== undefined, 'Unknown custom deploy kind');
  return { handoff };
}

// A reference that crossed the wire is dropped when invalid: the English text beside it is always shown instead.
function optionalRef(value: Readonly<Record<string, unknown>>, name: string): MessageRef | undefined {
  const field = value[name];
  if (field === undefined) {
    return undefined;
  }
  const parsed = parseMessageRef(field);
  return parsed.ok ? parsed.value : undefined;
}

function stepRefField(stepRef: MessageRef | undefined): { readonly stepRef?: MessageRef } {
  return stepRef === undefined ? {} : { stepRef };
}
function messageRefField(messageRef: MessageRef | undefined): { readonly messageRef?: MessageRef } {
  return messageRef === undefined ? {} : { messageRef };
}
