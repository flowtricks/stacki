// A believable, connected publish with nothing behind it. Studio's Publish menu reads
// `/studio/api/publish/availability`, posts to `/studio/api/publish` and then polls
// `/studio/api/status`; the demo answers all three from this model. The project looks
// connected to a GitHub repository and a Cloudflare Worker: it starts with three commits
// to push and changes to deploy, a push clears the commits, a deploy clears the deploy,
// and each batch of edits adds a commit and something to deploy again. Runs advance one
// stage per poll, so the real popup plays its steps in a few seconds. No git, build,
// deploy or network call ever happens, and the demo says so on the popup.
import { assert } from '../vendor/stacki/shared/core/assert';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, parsePublishTarget, type PublishTarget } from '../vendor/stacki/shared/properties/publishConfig';

export const PUBLISH_NOTE = 'This is a demo, so nothing is really published. Your edits stay in this browser.';

/** The project Stacki's own site is built from: the one this demo is a copy of. */
export const DEMO_REPOSITORY = 'flowtricks/stacki';
export const DEMO_GITHUB_ACCOUNT = 'stacki-demo';
/** Plainly not an account ID, so it can never be mistaken for a credential. */
export const DEMO_CLOUDFLARE_ACCOUNT = 'demo-account';
export const DEMO_CLOUDFLARE_PROJECT = 'stacki-build';
export const DEMO_COMMITS_START = 3;
/** Where the model is kept with the visitor's other edits; never served to the client. */
export const DEMO_PUBLISH_STATE_FILE = '.stacki/demo-publish-state.json';

const HOSTING = { provider: 'cloudflare-workers', accountId: DEMO_CLOUDFLARE_ACCOUNT, project: DEMO_CLOUDFLARE_PROJECT } as const;

/** Publish settings for a project connected to both destinations. */
export const DEMO_PUBLISH_SOURCE = `${JSON.stringify(
  parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, defaultTarget: 'all', githubAccount: DEMO_GITHUB_ACCOUNT, hosting: HOSTING }),
  undefined,
  2,
)}\n`;

const COMMITS_MAX = 1_000;
const RUNS_MAX = 1_000;

// The stages a real publish reports for each target, in order. A run ends one poll after its last.
type Stage = 'preparing' | 'building' | 'committing' | 'deploying';
const STAGES: Readonly<Record<PublishTarget, readonly Stage[]>> = {
  github: ['preparing', 'committing'],
  hosting: ['preparing', 'building', 'deploying'],
  all: ['preparing', 'building', 'committing', 'deploying'],
};

export type PublishStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'building'; readonly id: string; readonly stage: Stage; readonly deployment?: 'pending' }
  | {
      readonly kind: 'committed';
      readonly id: string;
      readonly sha: string;
      readonly url: string;
      readonly deployment?: 'live';
      readonly github?: 'skipped';
    };

/** What survives a reload: how far the project is ahead of each destination. */
export interface PublishModel {
  readonly commits: number;
  readonly deployPending: boolean;
}

const START: PublishModel = { commits: DEMO_COMMITS_START, deployPending: true };

/** Reads the saved model; anything unreadable starts over, since it is only a demo's state. */
export function parsePublishModel(text: string | undefined): PublishModel {
  if (text === undefined) {
    return START;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && 'commits' in value && 'deployPending' in value) {
      const { commits, deployPending } = value;
      if (Number.isSafeInteger(commits) && typeof commits === 'number' && commits >= 0 && commits <= COMMITS_MAX && typeof deployPending === 'boolean') {
        return { commits, deployPending };
      }
    }
  } catch {
    /* A damaged record starts the demo over. */
  }
  return START;
}

export interface DemoPublishOptions {
  /** Where the "published" site is: the demo's own baked copy, never a fake deploy. */
  readonly siteURL: string;
  readonly saved: string | undefined;
  readonly persist: (text: string) => void;
  readonly finished: () => void;
}

export class DemoPublish {
  private model: PublishModel;
  private edited = false;
  private runs = 0;
  private step = 0;
  private id = '';
  private target: PublishTarget = 'all';

  constructor(private readonly options: DemoPublishOptions) {
    this.model = parsePublishModel(options.saved);
  }

  /** An edit landed. Edits are counted in batches: one commit per availability check. */
  edit(): void {
    this.edited = true;
  }

  /** `/studio/api/publish/availability`, as a connected project reports it. */
  availability(): unknown {
    if (this.edited && !this.running()) {
      this.edited = false;
      this.save({ commits: Math.min(this.model.commits + 1, COMMITS_MAX), deployPending: true });
    }
    const github = this.model.commits > 0 ? 'pending' : 'current';
    return {
      github,
      hosting: this.model.deployPending ? 'pending' : 'current',
      githubPush: { commits: this.model.commits, repositoryUrl: `https://github.com/${DEMO_REPOSITORY}` },
    };
  }

  /** The POST's answer. A second click while running joins the same run. */
  start(input: unknown): PublishStatus {
    if (this.running()) {
      return this.current();
    }
    assert(this.runs < RUNS_MAX, 'A demo session stays under its publish limit');
    this.target = parsePublishTarget(input ?? 'all');
    this.runs++;
    this.id = `demo-${this.runs}`;
    this.step = 0;
    return this.current();
  }

  /** One poll: the next stage, then the finished state, which then stays. */
  poll(): PublishStatus {
    if (this.running()) {
      this.step++;
      if (!this.running()) {
        this.finish();
      }
    }
    return this.current();
  }

  private finish(): void {
    const pushed = this.target !== 'hosting';
    const deployed = this.target !== 'github';
    this.save({ commits: pushed ? 0 : this.model.commits, deployPending: deployed ? false : this.model.deployPending });
    this.options.finished();
  }

  private save(model: PublishModel): void {
    this.model = model;
    this.options.persist(JSON.stringify(model));
  }

  private running(): boolean {
    return this.id !== '' && this.step < STAGES[this.target].length;
  }

  private current(): PublishStatus {
    if (this.id === '') {
      return { kind: 'idle' };
    }
    const stage = STAGES[this.target][this.step];
    const deploys = this.target !== 'github';
    if (stage !== undefined) {
      return stage === 'deploying' ? { kind: 'building', id: this.id, stage, deployment: 'pending' } : { kind: 'building', id: this.id, stage };
    }
    assert(this.step === STAGES[this.target].length, 'A run never passes its last stage');
    return {
      kind: 'committed',
      id: this.id,
      sha: 'demo',
      url: this.options.siteURL,
      ...(deploys ? { deployment: 'live' as const } : {}),
      ...(this.target === 'hosting' ? { github: 'skipped' as const } : {}),
    };
  }
}
