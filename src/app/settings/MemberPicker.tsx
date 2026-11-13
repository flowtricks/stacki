// The "Add GitHub username" field of a role card (its Add button sits inside the field's right end), with suggestions the way GitHub's own
// picker offers them: after a 250 ms pause in typing, at most eight matching users with
// their picture, login and name, the repository's collaborators and recent commit
// authors first. ArrowUp and ArrowDown move through them, Enter picks the highlighted
// one (or adds the typed text when none is), Escape closes the list, and a click picks.
// The suggestions are help, never a gate: typing a username and pressing Add works
// whether GitHub answers or not, and a failed search is one quiet row.
//
// The list is a live filter, not a sequence of separate answers. While a search for the
// newest text is pending, the last answer stays on screen, narrowed at once to the logins
// that contain the text; when the answer lands it replaces the rows in place, keyed by
// login, so a row that stays does not remount and its picture does not reload. The
// highlight follows a login rather than a position, so it survives typing unless its row
// leaves. Only the newest search may change the list: an older answer that lands late is
// kept in the recent-answers cache (so backspacing is instant) but never shown.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { assert } from '../../../shared/core/assert';
import { GITHUB_USER_SEARCH_LIMITS, githubUserQuery, type GitHubUserSearchResult, type GitHubUserSuggestion } from '../../../shared/ipc/githubUserSearch';
import { sameLogin } from '../../../shared/properties/projectRoles';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { searchGitHubUsers } from '../../ipc/githubUserSearchBridge';
import CommitAvatar from '../../features/history/CommitAvatar';
import { memberAvatarURL, rememberMemberAvatar } from './memberAvatars';
import './memberPicker.css';

// The English texts, for tests; the picker shows them translated (settings.roles.members.unavailable, .noMatches).
export const MEMBER_UNAVAILABLE_TEXT = "Can't search GitHub right now";
export const MEMBER_NO_MATCHES_TEXT = 'No matches';

export const MEMBER_PICKER_LIMITS = {
  /** Recent answers kept per picker, so backspacing shows them without a request; the oldest is forgotten first. */
  cachedQueriesMax: 32,
  /** One row's height; memberPicker.css sets the same on every row so the list's height can animate. */
  rowHeightPx: 28,
  /** The gap between rows and the list's padding, as in memberPicker.css. */
  rowGapPx: 1,
  listPaddingPx: 4,
} as const satisfies Record<string, number>;

/** The answer the list is drawn from: the newest one that landed, for the query it answered. */
type Answer = { readonly kind: 'none' } | { readonly kind: 'answered'; readonly query: string; readonly result: GitHubUserSearchResult };

/** Whether the person has put the list away (Escape, blur) since they last typed. */
type Presence = 'shown' | 'dismissed';

/** What the open list draws below its rows, at most one quiet line. */
type StatusRow = 'none' | 'unavailable' | 'no-matches';

export function MemberPicker(props: {
  readonly roleName: string;
  readonly members: readonly string[];
  /** The open project, for its GitHub account and repository; undefined turns suggestions off. */
  readonly projectPath: string | undefined;
  readonly addMember: (login: string) => boolean;
}) {
  const { roleName, members, projectPath, addMember } = props;
  const translate = useTranslate();
  const [typed, setTyped] = useState('');
  const [answer, setAnswer] = useState<Answer>({ kind: 'none' });
  const [presence, setPresence] = useState<Presence>('shown');
  // Undefined is "no row": Enter then adds what was typed.
  const [highlightLogin, setHighlightLogin] = useState<string | undefined>(undefined);
  const cache = useRef(new Map<string, GitHubUserSearchResult>());
  const listId = useId();
  const query = projectPath === undefined ? undefined : githubUserQuery(typed);
  useEffect(() => {
    if (projectPath === undefined || query === undefined) {
      setAnswer({ kind: 'none' });
      return undefined;
    }
    const key = cacheKey(projectPath, query);
    const cached = recallAnswer(cache.current, key);
    if (cached !== undefined) {
      setAnswer((previous) => answered(previous, query, cached));
      return undefined;
    }
    // The newest search is this effect's; its cleanup retires it before the next one starts.
    let lifetime: 'newest' | 'stale' = 'newest';
    const timer = setTimeout(() => {
      void searchGitHubUsers(projectPath, query).then((result) => {
        // A failed search is not remembered, so the next keystroke tries GitHub again.
        if (result.github === 'searched') {
          rememberAnswer(cache.current, key, result);
        }
        if (lifetime === 'stale') {
          return;
        }
        for (const user of result.users) {
          if (user.avatarURL !== undefined) {
            rememberMemberAvatar(user.login, user.avatarURL);
          }
        }
        setAnswer((previous) => answered(previous, query, result));
      });
    }, GITHUB_USER_SEARCH_LIMITS.debounceMs);
    return () => {
      lifetime = 'stale';
      clearTimeout(timer);
    };
  }, [projectPath, query]);
  const users = query === undefined ? [] : visibleSuggestions(answer, query, members);
  const pending = searchPending(answer, query);
  const status = statusRow(answer, { users, pending });
  const rowCount = users.length + (status === 'none' ? 0 : 1);
  const open = listOpen({ presence, query, rowCount });
  const highlight = users.findIndex((user) => user.login === highlightLogin);
  // The highlighted row left the list: the highlight goes with it, so it does not come back by surprise.
  useEffect(() => {
    if (highlight < 0) {
      setHighlightLogin(undefined);
    }
  }, [highlight]);
  assert(users.length <= GITHUB_USER_SEARCH_LIMITS.usersMax, 'Member picker: suggestions are capped');
  assert(highlight < users.length, 'Member picker: the highlight is a listed row');
  const add = (login: string) => {
    if (addMember(login)) {
      setTyped('');
      setAnswer({ kind: 'none' });
      setHighlightLogin(undefined);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    keyDown(event, { open, users, highlight }, { setHighlightLogin, add, close: () => setPresence('dismissed') });
  };
  return (
    <form
      className="app-role-add"
      onSubmit={(event) => {
        event.preventDefault();
        add(typed);
      }}
    >
      <div className="app-role-member-field">
        <PersonPlusIcon />
        <input
          role="combobox"
          aria-label={translate('settings.roles.members.add.label', { name: roleName })}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open ? activeDescendant(listId, users[highlight]) : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={translate('settings.roles.members.add.placeholder')}
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            setPresence('shown');
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setPresence('dismissed')}
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            className="app-role-suggestions"
            aria-label={translate('settings.roles.members.suggestions', { query: typed.trim() })}
            aria-busy={pending}
            style={{ height: listHeightPx(rowCount) }}
          >
            {users.map((user) => (
              <SuggestionRow
                key={user.login}
                id={optionId(listId, user.login)}
                user={user}
                highlighted={user.login === highlightLogin}
                pick={() => add(user.login)}
              />
            ))}
            {status === 'unavailable' && (
              <li className="app-role-suggestion-status" role="status">
                {translate('settings.roles.members.unavailable')}
              </li>
            )}
            {status === 'no-matches' && (
              <li className="app-role-suggestion-status" role="status">
                {translate('settings.roles.members.noMatches')}
              </li>
            )}
          </ul>
        )}
        {/* Inside the field's right end, quiet until there is text to add. */}
        <button type="submit" className="app-role-add-button" disabled={typed.trim() === ''}>
          {translate('settings.roles.members.add.button')}
        </button>
      </div>
    </form>
  );
}

// A person with a plus, the add row's mark.
function PersonPlusIcon() {
  return (
    <svg
      className="app-role-add-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="6.5" cy="5.5" r="2.5" />
      <path d="M2 13c.4-2.2 2.1-3.5 4.5-3.5 1 0 1.9.2 2.6.7" />
      <path d="M12.5 8.5v4M10.5 10.5h4" />
    </svg>
  );
}

/** The list's keys. Enter on no row falls through to the form, which adds the typed text. */
function keyDown(
  event: KeyboardEvent<HTMLInputElement>,
  view: { readonly open: boolean; readonly users: readonly GitHubUserSuggestion[]; readonly highlight: number },
  act: { readonly setHighlightLogin: (login: string | undefined) => void; readonly add: (login: string) => void; readonly close: () => void },
): void {
  if (!view.open) {
    return;
  }
  assert(view.highlight < view.users.length, 'Member picker: the highlight is a listed row');
  const last = view.users.length - 1;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      act.setHighlightLogin(view.users[Math.min(view.highlight + 1, last)]?.login);
      return;
    case 'ArrowUp':
      event.preventDefault();
      act.setHighlightLogin(view.users[Math.max(view.highlight - 1, -1)]?.login);
      return;
    case 'Enter': {
      const user = view.highlight >= 0 ? view.users[view.highlight] : undefined;
      if (user !== undefined) {
        event.preventDefault();
        act.add(user.login);
      }
      return;
    }
    case 'Escape':
      event.preventDefault();
      act.close();
      return;
    default:
      return;
  }
}

/**
 * The rows to draw for `query`: the answer for it as GitHub gave it, or, while that is
 * pending, the last answer narrowed to the logins that contain the text. Members already
 * in the role are never offered.
 */
function visibleSuggestions(answer: Answer, query: string, members: readonly string[]): readonly GitHubUserSuggestion[] {
  assert(query.length > 0, 'Member picker: a query is typed');
  if (answer.kind === 'none') {
    return [];
  }
  const needle = query.toLowerCase();
  const matching = answer.query === query ? answer.result.users : answer.result.users.filter((user) => user.login.toLowerCase().includes(needle));
  const users = matching.filter((user) => !members.some((member) => sameLogin(member, user.login)));
  assert(users.length <= answer.result.users.length, 'Member picker: filtering only removes rows');
  return users;
}

/** Whether the newest text still waits for its own answer. */
function searchPending(answer: Answer, query: string | undefined): boolean {
  if (query === undefined) {
    return false;
  }
  if (answer.kind === 'none') {
    return true;
  }
  return answer.query !== query;
}

/** The list shows while there is text, a row to draw, and the person has not put it away. */
function listOpen(view: { readonly presence: Presence; readonly query: string | undefined; readonly rowCount: number }): boolean {
  assert(Number.isSafeInteger(view.rowCount), 'Member picker: rows are counted');
  assert(view.rowCount <= GITHUB_USER_SEARCH_LIMITS.usersMax + 1, 'Member picker: at most the capped rows and one status row');
  if (view.presence === 'dismissed') {
    return false;
  }
  if (view.query === undefined) {
    return false;
  }
  return view.rowCount > 0;
}

/** The quiet line under the rows: GitHub could not be asked, or nothing matches yet while a search is pending. */
function statusRow(answer: Answer, view: { readonly users: readonly GitHubUserSuggestion[]; readonly pending: boolean }): StatusRow {
  if (answer.kind === 'answered' && answer.result.github === 'unavailable') {
    return 'unavailable';
  }
  if (view.users.length > 0) {
    return 'none';
  }
  // Nothing matches and nothing is coming: the list closes rather than saying so.
  if (view.pending && answer.kind === 'answered') {
    return 'no-matches';
  }
  return 'none';
}

/**
 * The new answer, with each row that was already on screen keeping its picture, so a row
 * that stays does not swap one GitHub avatar URL for another and flash while it reloads.
 */
function answered(previous: Answer, query: string, result: GitHubUserSearchResult): Answer {
  assert(query.length > 0, 'Member picker: an answer is for a typed query');
  assert(result.users.length <= GITHUB_USER_SEARCH_LIMITS.usersMax, 'Member picker: an answer is capped');
  if (previous.kind === 'none') {
    return { kind: 'answered', query, result };
  }
  const users = result.users.map((user) => {
    const shown = previous.result.users.find((before) => before.login === user.login);
    if (shown === undefined || shown.avatarURL === undefined) {
      return user;
    }
    return { ...user, avatarURL: shown.avatarURL };
  });
  return { kind: 'answered', query, result: { ...result, users } };
}

function cacheKey(projectPath: string, query: string): string {
  assert(projectPath.length > 0, 'Member picker: a project is open');
  assert(query.length > 0, 'Member picker: a query is typed');
  // A newline cannot appear in a login query, so the two parts never run together.
  return `${projectPath}\n${query.toLowerCase()}`;
}

/** The cached answer for `key`, now the most recently used, or undefined. */
function recallAnswer(cache: Map<string, GitHubUserSearchResult>, key: string): GitHubUserSearchResult | undefined {
  const result = cache.get(key);
  if (result !== undefined) {
    cache.delete(key);
    cache.set(key, result);
  }
  assert(cache.size <= MEMBER_PICKER_LIMITS.cachedQueriesMax, 'Member picker: the answer cache is bounded');
  return result;
}

function rememberAnswer(cache: Map<string, GitHubUserSearchResult>, key: string, result: GitHubUserSearchResult): void {
  assert(result.github === 'searched', 'Member picker: only answers from GitHub are cached');
  cache.delete(key);
  if (cache.size >= MEMBER_PICKER_LIMITS.cachedQueriesMax) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, result);
  assert(cache.size <= MEMBER_PICKER_LIMITS.cachedQueriesMax, 'Member picker: the answer cache is bounded');
}

/** The list's height for `rowCount` fixed-height rows, set inline so CSS can animate it as rows come and go. */
function listHeightPx(rowCount: number): number {
  assert(Number.isSafeInteger(rowCount), 'Member picker: rows are counted');
  assert(rowCount > 0, 'Member picker: an open list has a row');
  const { rowHeightPx, rowGapPx, listPaddingPx } = MEMBER_PICKER_LIMITS;
  return rowCount * rowHeightPx + (rowCount - 1) * rowGapPx + 2 * listPaddingPx;
}

function optionId(listId: string, login: string): string {
  return `${listId}-${login.toLowerCase()}`;
}

function activeDescendant(listId: string, user: GitHubUserSuggestion | undefined): string | undefined {
  if (user === undefined) {
    return undefined;
  }
  return optionId(listId, user.login);
}

function SuggestionRow(props: { readonly id: string; readonly user: GitHubUserSuggestion; readonly highlighted: boolean; readonly pick: () => void }) {
  const { user } = props;
  return (
    <li
      id={props.id}
      role="option"
      aria-selected={props.highlighted}
      className={props.highlighted ? 'app-role-suggestion highlight' : 'app-role-suggestion'}
      // Keep focus in the field, so the list is not closed by the click that picks from it.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.pick}
    >
      <CommitAvatar name={user.login} email="" url={user.avatarURL ?? memberAvatarURL(user.login)} />
      <span className="app-role-suggestion-login">{user.login}</span>
      {user.name !== undefined && <span className="app-role-suggestion-name">{user.name}</span>}
    </li>
  );
}
