import { connectRepository } from '../../ipc/repositoryBridge';
import type { PublishRequest, PublishResult } from './PublishModal';
import { assert } from '../../../shared/core/assert';
import { parseIpcPayload } from '../../../shared/ipc/ipcPayloads';
import { commitGitChanges, createGitHubRepository, readGitInfo } from './gitChipBridge';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

// The owner flushes editor writes before this workflow reads the working tree.
// Each operating failure stops the next destructive step; no parser is caught.
export async function publishGitProject(projectPath: string, request: PublishRequest, translate: Translator = ENGLISH_TRANSLATE): Promise<PublishResult> {
  // Validate the complete request before committing anything on disk.
  const payload =
    request.kind === 'existing'
      ? {
          kind: 'existing' as const,
          ...parseIpcPayload('git:connect', { projectPath, ...request }),
        }
      : { kind: 'new' as const, ...parseIpcPayload('git:publish', { projectPath, ...request }) };
  if (payload.kind === 'new' && payload.repoName.trim().length === 0) {
    return { ok: false, error: translate('git.publish.enterName') };
  }
  const state = await readGitInfo(projectPath);
  if (!state.ok) {
    return state;
  }
  if (!state.value.isRepo) {
    return { ok: false, error: translate('git.publish.initializeFirst') };
  }
  if (state.value.remote) {
    return { ok: false, error: translate('git.publish.hasRemote') };
  }
  assert(state.value.ahead >= 0, 'Git publish: ahead count must be nonnegative');
  assert(Number.isSafeInteger(state.value.ahead), 'Git publish: ahead count must be an integer');
  if (state.value.dirty || state.value.branch === '(no commits yet)') {
    request.onStep(translate('git.publish.step.committing'));
    const committed = await commitGitChanges(projectPath, 'Initial commit from Stacki');
    if (!committed.ok) {
      return committed;
    }
  }
  if (payload.kind === 'existing') {
    request.onStep(translate('git.publish.step.connecting'));
    const result = await connectRepository(projectPath, payload.repository);
    return result.ok ? { ok: true, value: result.value.url } : result;
  }
  request.onStep(translate('git.publish.step.creating'));
  const published = await createGitHubRepository(projectPath, payload.repoName, {
    isPrivate: payload.isPrivate,
  });
  return published.ok ? { ok: true, value: published.value.url } : published;
}
