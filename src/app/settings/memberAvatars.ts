// Pictures for the Roles tab's member chips. A login names its picture with no request
// (`github.com/<login>.png`, shared/ipc/commitAvatars.ts); a picture the search already
// returned (on GitHub's avatar host, smaller and cached by the browser) is preferred for as
// long as the window lives. Both pass the commit avatars' host check, so a chip can only
// ever load from GitHub.
import { assert } from '../../../shared/core/assert';
import { githubLoginAvatar, parseAvatarURL } from '../../../shared/ipc/commitAvatars';

export const MEMBER_AVATAR_LIMITS = {
  /** Logins whose search picture is remembered; the oldest is forgotten first. */
  entriesMax: 500,
} as const satisfies Record<string, number>;

const known = new Map<string, string>();

/** Remembers the picture a suggestion carried for `login`. */
export function rememberMemberAvatar(login: string, url: string): void {
  assert(login.length > 0, 'Member avatars: a login is named');
  const checked = parseAvatarURL(url);
  const key = login.toLowerCase();
  known.delete(key);
  if (known.size >= MEMBER_AVATAR_LIMITS.entriesMax) {
    const oldest = known.keys().next();
    if (oldest.done !== true) {
      known.delete(oldest.value);
    }
  }
  known.set(key, checked);
  assert(known.size <= MEMBER_AVATAR_LIMITS.entriesMax, 'Member avatars: the cache is bounded');
}

/** The picture for a member's chip, or undefined for a name that is not a GitHub login. */
export function memberAvatarURL(login: string): string | undefined {
  return known.get(login.toLowerCase()) ?? githubLoginAvatar(login);
}
