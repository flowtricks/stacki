import { GitHubRepository } from '../features/github/github';
import { boundedText, downloadRelease, latestRelease } from '../features/updates/catalog';
import { record, string } from '../shared/validation';
import type { Environment } from './environment';
import release from '../shared/release.json';

export async function updateRoutes(request: Request, environment: Environment): Promise<Response> {
  try {
    if (request.method === 'GET') {
      return Response.json({ current: release.version, latest: await latestRelease() }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }
    const body = await boundedText(new Response(request.body), 1000);
    if (body.length > 1000) {
      return new Response('Too large', { status: 413 });
    }
    const input = record(JSON.parse(body));
    if (input['replaceCustomizations'] !== true || input['current'] !== release.version) {
      return new Response('Confirm replacing Studio customizations from the current version', {
        status: 409,
      });
    }
    const next = await downloadRelease(string(input['version'], 40));
    const repository = new GitHubRepository({
      appId: environment.GITHUB_APP_ID,
      installationId: environment.GITHUB_INSTALLATION_ID,
      privateKey: environment.GITHUB_PRIVATE_KEY,
      repository: environment.GITHUB_REPOSITORY,
      branch: environment.GITHUB_BRANCH,
    });
    return Response.json(await repository.prepareStudioUpdate(next));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Studio update failed' }, { status: 400 });
  }
}
