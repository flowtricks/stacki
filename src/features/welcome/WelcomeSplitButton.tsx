// The welcome screen's split buttons: one main action and one alternative in
// the menu, on the shared split button (src/ui/SplitButton.tsx).
import type { ReactNode } from 'react';
import SplitButton from '../../ui/SplitButton';

interface WelcomeSplitButtonProps {
  readonly className: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly menuLabel: string;
  readonly menuIcon?: ReactNode;
  readonly menuTitle: string;
  readonly onClick: () => void;
  readonly onMenuSelect: () => void;
}

export default function WelcomeSplitButton(props: WelcomeSplitButtonProps) {
  return (
    <SplitButton
      className={props.className}
      label={props.label}
      icon={props.icon}
      menuTitle={props.menuTitle}
      items={[{ label: props.menuLabel, icon: props.menuIcon, onSelect: props.onMenuSelect }]}
      onClick={props.onClick}
    />
  );
}
