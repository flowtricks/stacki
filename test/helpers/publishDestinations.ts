// What the destination publishing tests share: stand-ins for every question only a host can answer, a site with saved
// destinations, and the invariant each publish is held to. Nothing here reaches a host or signs in anywhere.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { git } from '#dist/electron/lib/nodeTools.js';
import { DesktopPublisher } from '#dist/electron/project/publisher.js';
import { DESTINATION_SERVICES, type DestinationServices } from '#dist/electron/project/publishDestination.js';
import { readDeploymentReceipt } from '#dist/electron/project/publishReceipt.js';
import { PUBLISH_TEMPORARY_SEAMS } from '#dist/electron/project/publishTemporary.js';
import type { DeployTransport } from '#dist/electron/project/deployRequest.js';
import { DEFAULT_PUBLISH_CONFIG, type Hosting, type PublishConfig } from '#dist/shared/properties/publishConfig.js';
import type { DestinationTarget } from '#dist/shared/properties/publishDestinations.js';
import { fakeLinkStore, finished, publishSite, write, type SiteOptions } from './publishSite.ts';

export type Site = Awaited<ReturnType<typeof publishSite>>;

/** The answers a test gives in place of a host. */
export type ServiceAnswers = { readonly [Question in Exclude<keyof DestinationServices, 'run'>]?: DestinationServices[Question] };

/** Production's own hooks, which must never run for a destination. */
export function production(hosting: Hosting, extra: Pick<PublishConfig, 'customHosting' | 'publishedSite'> = {}): PublishConfig {
  return { ...DEFAULT_PUBLISH_CONFIG, hosting, beforePublish: ['before'], afterPublish: ['after'], ...extra };
}

export function entry(id: string, target: DestinationTarget, extra: Readonly<Record<string, unknown>> = {}) {
  const label = id === 'staging' ? 'Staging' : id.toUpperCase();
  return { id, label, target, buildScript: 'build:staging', beforePublish: [], afterPublish: [], ...extra };
}

export function destinationsFile(destinations: readonly Readonly<Record<string, unknown>>[]) {
  return { version: 1, destinations };
}

const NOTHING_SERVED = { domains: [], repository: undefined };

/** Every question answered the safe way, unless a test answers otherwise. No question reaches a real host. */
export function services(changes: ServiceAnswers = {}): DestinationServices {
  return {
    ...DESTINATION_SERVICES,
    workerToolInstalled: () => true,
    pagesProject: async () => ({ ...NOTHING_SERVED, productionBranch: 'main' }),
    vercelHasProduction: async () => true,
    vercelProject: async () => NOTHING_SERVED,
    netlifyProject: async () => NOTHING_SERVED,
    workerHostnames: async () => [],
    netlifySite: async () => undefined,
    ...changes,
  };
}

export function publisherFor(
  options: { readonly services?: DestinationServices; readonly store?: ReturnType<typeof fakeLinkStore>; readonly transport?: DeployTransport } = {},
) {
  return new DesktopPublisher(PUBLISH_TEMPORARY_SEAMS, {
    destinations: options.services ?? services(),
    ...(options.store === undefined ? {} : { deployLinks: options.store }),
    transport:
      options.transport ??
      (async () => {
        throw new Error('No request is expected');
      }),
  });
}

export async function destinationSite(
  context: TestContext,
  hosting: Hosting,
  destinations: Readonly<Record<string, unknown>>,
  options: Pick<SiteOptions, 'files' | 'scripts'> = {},
) {
  const site = await publishSite(context, { publish: { ...production(hosting) }, destinations, ...options });
  // Uncommitted work, which a destination publishes without committing it to the person's branch.
  write(site.root, 'page.txt', 'A draft');
  return site;
}

/** Everything production is made of on this computer and on GitHub. */
async function productionState(site: Site) {
  return {
    main: await site.revision(site.remote, 'refs/heads/main'),
    head: await site.revision(site.root, 'HEAD'),
    branch: (await git(site.root, ['symbolic-ref', '--short', 'HEAD'])).stdout,
    index: (await git(site.root, ['diff', '--cached', '--name-status'])).stdout,
    status: (await git(site.root, ['status', '--porcelain'])).stdout,
    receipt: await readDeploymentReceipt(site.root),
  };
}

/** One publish to one destination, after which production must be exactly as it was. */
export async function publishDestination(site: Site, publisher: DesktopPublisher, id: string) {
  const before = await productionState(site);
  publisher.start(site.root, `destination:${id}`);
  const state = await finished(publisher, site.root);
  assert.deepEqual(await productionState(site), before, 'Publishing a destination changed production');
  return state;
}

/** A refusal, with the key it was refused as, and nothing built, pushed, deployed or recorded. */
export async function refusedAs(site: Site, publisher: DesktopPublisher, key: string, id = 'staging') {
  const refs = await site.refs();
  const state = await publishDestination(site, publisher, id);
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, key);
  assert.equal(await site.refs(), refs, 'A refused publish pushes nothing');
  assert.deepEqual(site.calls(), [], 'A refused publish builds and deploys nothing');
  assert.equal(await readDeploymentReceipt(site.root, id), undefined);
}
