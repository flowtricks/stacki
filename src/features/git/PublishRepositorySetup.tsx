import { useTranslate } from '../../lib/i18n/useTranslate';
import PublishModal from './PublishModal';
import type { PublishRequest, PublishResult } from './PublishModal';
import { initializeGit, readGitInfo } from './gitChipBridge';
import { publishGitProject } from './gitPublishWorkflow';
import { openExternalURL } from '../../ipc/appBridge';
import { failureOf } from '../../lib/cleanError';

export function PublishRepositorySetup({
  projectPath,
  close,
  flushSave,
}: {
  readonly projectPath: string;
  readonly close: () => void;
  readonly flushSave: () => Promise<unknown>;
}) {
  const translate = useTranslate();
  async function configure(request: PublishRequest): Promise<PublishResult> {
    try {
      await flushSave();
      const info = await readGitInfo(projectPath);
      if (!info.ok) {
        return info;
      }
      if (!info.value.isRepo) {
        const initialized = await initializeGit(projectPath);
        if (!initialized.ok) {
          return initialized;
        }
      }
      return await publishGitProject(projectPath, request, translate);
    } catch (error: unknown) {
      return failureOf(error);
    }
  }
  return (
    <PublishModal
      projectPath={projectPath}
      defaultName={projectPath.split(/[/\\]/).at(-1) ?? 'website'}
      branch={translate('git.publish.currentBranch')}
      onClose={close}
      onPublish={configure}
      openExternal={(url) => {
        void openExternalURL(url);
      }}
    />
  );
}
