import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDownIcon } from '../../ui/Icons';
import Popup from '../../ui/Popup';

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
  const { open, setOpen, groupRef, triggerRef, itemRef } = useSplitMenu();
  const menuId = useId();
  return (
    <div className="welcome-split-button" ref={groupRef}>
      <button
        className={props.className}
        onClick={() => {
          setOpen(false);
          props.onClick();
        }}
      >
        {props.icon}
        {props.label}
      </button>
      <button
        ref={triggerRef}
        className={`welcome-split-arrow ${props.className}`}
        aria-label={props.menuTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <ChevronDownIcon size={13} />
      </button>
      <Popup
        mode="popover"
        portal={false}
        open={open}
        anchor={triggerRef.current ?? undefined}
        within={groupRef.current ?? undefined}
        onClose={() => setOpen(false)}
        className="welcome-split-menu"
        role="menu"
        id={menuId}
      >
        {({ finish }) => (
          <SplitMenuItem
            itemRef={itemRef}
            label={props.menuLabel}
            icon={props.menuIcon}
            onSelect={() =>
              finish(() => {
                setOpen(false);
                props.onMenuSelect();
              })
            }
          />
        )}
      </Popup>
    </div>
  );
}

function SplitMenuItem({
  label,
  icon,
  itemRef,
  onSelect,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly itemRef: React.RefObject<HTMLButtonElement>;
  readonly onSelect: () => void;
}) {
  return (
    <button autoFocus ref={itemRef} role="menuitem" onClick={onSelect}>
      {icon}
      {label}
    </button>
  );
}

function useSplitMenu() {
  const [open, setOpen] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRef = useRef<HTMLButtonElement>(null);
  return { open, setOpen, groupRef, triggerRef, itemRef };
}
