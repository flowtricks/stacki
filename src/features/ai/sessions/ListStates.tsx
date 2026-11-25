// The cards the chat list shows when it has no rows to show: no chats yet (with the way to start one), a search
// or filter that matches nothing (with the way to clear it), and a list that could not be read (with the way to
// try again; the reason is the panel's error toast, never a paragraph here). All three are the app's shared
// EmptyState, so this list's "nothing here" reads like every other panel's, and each has exactly one action.
// The split layout's chat column draws `NoChats` too, so the two layouts never word it differently.
import { assert } from '../../../../shared/core/assert';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { EmptyState } from '../../../ui/EmptyState';
import { CommentIcon, PlusIcon, SearchIcon, WarningTriangleIcon } from '../../../ui/Icons';
import { DEFAULT_CHAT_FILTER, aiState, loadAiProject, newChat, preferredAgent, setChatListFilter } from '../aiStore';

export function NoChats() {
  const translate = useTranslate();
  return (
    <EmptyState
      align="center"
      icon={<CommentIcon size={20} />}
      title={translate('ai.sessions.empty')}
      description={translate('ai.sessions.empty.hint')}
      action={
        <button type="button" className="ai-primary ai-sessions-start" onClick={() => void newChat(preferredAgent())}>
          <PlusIcon size={12} /> {translate('ai.sessions.newChat')}
        </button>
      }
    />
  );
}

/** Clearing keeps "Show archived": it widens the list, so it never is why nothing matched. */
export function NoMatchingChats() {
  const translate = useTranslate();
  const clear = (): void => setChatListFilter({ ...DEFAULT_CHAT_FILTER, showArchived: aiState().filter.showArchived });
  return (
    <EmptyState
      align="center"
      icon={<SearchIcon size={20} />}
      title={translate('ai.sessions.noMatch')}
      action={
        <button type="button" className="ai-sessions-start" onClick={clear}>
          {translate('ai.sessions.clearFilters')}
        </button>
      }
    />
  );
}

export function ChatsNotRead() {
  const translate = useTranslate();
  const retry = (): void => {
    const { projectPath } = aiState();
    assert(projectPath !== undefined, 'ChatsNotRead: a project is open');
    void loadAiProject(projectPath);
  };
  return (
    <EmptyState
      align="center"
      icon={<WarningTriangleIcon size={20} />}
      title={translate('ai.sessions.loadFailed')}
      action={
        <button type="button" className="ai-sessions-start" onClick={retry}>
          {translate('ai.common.tryAgain')}
        </button>
      }
    />
  );
}
