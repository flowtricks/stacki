import release from '../../shared/release.json';
import type { Session } from './useSession';
import { Avatar } from './Avatar';
import { StackiLogo } from '../../shared/ui/StackiLogo';
import { useRef, useState } from 'react';
import Popup from '../../../vendor/stacki/src/ui/Popup';
import { CommentIcon } from '../../../vendor/stacki/src/ui/Icons';
import { RoleMenu } from '../roles/RoleMenu';
import { SoundToggle } from '../settings/SoundToggle';
import './accountMenu.css';

interface AccountMenuProps {
  readonly saved: boolean;
  readonly session: Session | undefined;
  readonly cursorChat: (() => void) | undefined;
}

export function AccountMenu(props: AccountMenuProps) {
  const menu = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <div className="account-menu">
      <button
        ref={menu}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="studio-brand"
        aria-label="Stacki account menu"
        title="Stacki account menu"
      >
        <StackiLogo />
      </button>
      <Popup
        mode="popover"
        portal={false}
        className="account-popover"
        open={open}
        onClose={close}
        anchor={menu.current ?? undefined}
        label="Stacki account"
      >
        {(actions) => (
          <>
            <RoleMenu saved={props.saved} close={actions.close} />
            <SoundToggle />
            <button
              className="account-action"
              type="button"
              aria-label="Cursor chat"
              aria-keyshortcuts="/"
              disabled={props.cursorChat === undefined}
              title={props.cursorChat ? 'Cursor chat (/)' : 'Available in the page editing preview'}
              onClick={() =>
                actions.finish(() => {
                  close();
                  props.cursorChat?.();
                })
              }
            >
              <CommentIcon />
              <span>Cursor chat</span>
              <kbd aria-hidden="true">/</kbd>
            </button>
            <AccountIdentity saved={props.saved} session={props.session} />
            <span className="account-version">Stacki Studio {release.version}</span>
          </>
        )}
      </Popup>
    </div>
  );
}

function AccountIdentity({ saved, session }: Pick<AccountMenuProps, 'saved' | 'session'>) {
  if (session?.kind !== 'github') {
    return (
      <span className="local-session">
        {session?.kind === 'local' ? 'Local development · no sign-in required' : 'Loading account…'}
      </span>
    );
  }
  return (
    <div className="account-profile">
      <span className="account-avatar" aria-hidden="true">
        <Avatar key={session.id} id={session.id} name={session.login} />
      </span>
      <div className="account-profile-name">
        <strong title={`@${session.login}`}>@{session.login}</strong>
        <span>GitHub account</span>
      </div>
      <form method="post" action="/studio/auth/logout">
        <button
          className="account-sign-out"
          type="submit"
          disabled={!saved}
          title={saved ? 'Sign out of this studio' : 'Wait for your edits to finish saving'}
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
