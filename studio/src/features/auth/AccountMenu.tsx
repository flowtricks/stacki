import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import release from '../../shared/release.json';
import type { Session } from './useSession';
import { Avatar } from './Avatar';
import { StackiLogo } from '../../shared/ui/StackiLogo';
import { useRef, useState } from 'react';
import Popup from '../../../vendor/stacki/src/ui/Popup';
import { CommentIcon } from '../../../vendor/stacki/src/ui/Icons';
import { RoleMenu } from '../roles/RoleMenu';
import { SoundToggle } from '../settings/SoundToggle';
import { AppsPrivacyToggle } from '../apps/AppsPrivacyToggle';
import './accountMenu.css';

interface AccountMenuProps {
  readonly saved: boolean;
  readonly session: Session | undefined;
  readonly cursorChat: (() => void) | undefined;
}

export function AccountMenu(props: AccountMenuProps) {
  const translate = useTranslate();
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
        aria-label={translate('studio.account.menu')}
        title={translate('studio.account.menu')}
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
        label={translate('studio.account.label')}
      >
        {(actions) => (
          <>
            <RoleMenu saved={props.saved} close={actions.close} />
            <SoundToggle />
            <AppsPrivacyToggle />
            <button
              className="account-action"
              type="button"
              aria-label={translate('studio.account.cursorChat')}
              aria-keyshortcuts="/"
              disabled={props.cursorChat === undefined}
              title={props.cursorChat ? translate('studio.account.cursorChatShortcut') : translate('studio.account.cursorChatUnavailable')}
              onClick={() =>
                actions.finish(() => {
                  close();
                  props.cursorChat?.();
                })
              }
            >
              <CommentIcon />
              <span>{translate('studio.account.cursorChat')}</span>
              <kbd aria-hidden="true">/</kbd>
            </button>
            <AccountIdentity saved={props.saved} session={props.session} />
            <span className="account-version">{translate('studio.account.version', { version: release.version })}</span>
          </>
        )}
      </Popup>
    </div>
  );
}

function AccountIdentity({ saved, session }: Pick<AccountMenuProps, 'saved' | 'session'>) {
  const translate = useTranslate();
  if (session?.kind !== 'github') {
    return <span className="local-session">{session?.kind === 'local' ? translate('studio.account.local') : translate('studio.account.loading')}</span>;
  }
  return (
    <div className="account-profile">
      <span className="account-avatar" aria-hidden="true">
        <Avatar key={session.id} id={session.id} name={session.login} />
      </span>
      <div className="account-profile-name">
        <strong title={`@${session.login}`}>@{session.login}</strong>
        <span>{translate('studio.account.github')}</span>
      </div>
      <form method="post" action="/studio/auth/logout">
        <button
          className="account-sign-out"
          type="submit"
          disabled={!saved}
          title={saved ? translate('studio.account.signOutTitle') : translate('studio.account.signOutWait')}
        >
          {translate('studio.account.signOut')}
        </button>
      </form>
    </div>
  );
}
