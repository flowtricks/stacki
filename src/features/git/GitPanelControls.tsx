// The History panel's git controls with a session of their own, for a host whose only git surface is the panel
// (Studio). Desktop's session is the window's instead (src/app/shell/DesktopGitPull.tsx), because its title bar and
// shortcut pull with the panel closed.
import type { ComponentProps } from 'react';
import GitChip from './GitChip';
import { GitSessionDialogs } from './GitSessionDialogs';
import { useGitSession, type GitHost } from './useGitSession';

type Props = GitHost & Omit<ComponentProps<typeof GitChip>, 'session'>;

export default function GitPanelControls({ incoming, withBranchChange, pullShortcut, ...host }: Props) {
  const session = useGitSession(host);
  return (
    <>
      <GitChip
        session={session}
        pullShortcut={pullShortcut}
        {...(incoming === undefined ? {} : { incoming })}
        {...(withBranchChange === undefined ? {} : { withBranchChange })}
      />
      <GitSessionDialogs session={session} />
    </>
  );
}
