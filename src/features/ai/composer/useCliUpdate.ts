// What the model menu offers when the agent's installed CLI is too old to list today's models: update it, and
// say how it went as a toast. When the update changed nothing (Claude Code installed with Homebrew updates through
// Homebrew), the toast links the install guide.
import type { AgentId } from '../../../../shared/properties/ai/agentIds';
import { openExternalURL } from '../../../ipc/appBridge';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { reportActionToast, reportErrorToast } from '../../../ui/errorNotices';
import { updateAgentCli, type AiState } from '../aiStore';
import type { ComposerSettings } from './composerSettings';

const UPDATE_GUIDE_URL = 'https://code.claude.com/docs/en/setup';

export function useCliUpdate(state: AiState, agent: AgentId): ComposerSettings['cliUpdate'] {
  const translate = useTranslate();
  const availability = state.agents.find((entry) => entry.agent === agent);
  const version = availability?.state === 'ready' ? availability.outdatedCli : undefined;
  if (version === undefined) {
    return undefined;
  }
  const run = (): void => {
    void updateAgentCli(agent)
      .then((outcome) => {
        if (outcome === 'updated') {
          reportActionToast(translate('ai.composer.cli.updated'), 'success', []);
        } else if (outcome === 'outdated') {
          reportActionToast(translate('ai.composer.cli.stillOld'), 'warning', [
            { label: translate('ai.composer.cli.howTo'), run: () => openExternalURL(UPDATE_GUIDE_URL) },
          ]);
        }
      })
      .catch((error: unknown) => reportErrorToast(String(error)));
  };
  return { version, busy: state.updating.has(agent), run };
}
