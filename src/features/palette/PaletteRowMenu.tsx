// The "…" on a Components panel row (a component or a folder header): the shared Menu with a "Roles" submenu
// (componentRolesMenu.ts) listing every role with a switch for whether it may add this. The button is on every
// row in every layout (a slot is reserved for it in roleMenu.css, so the row text never shifts); what the menu
// holds depends on the panel: Show instances for a component, Roles when the project has a roles file.
import { useEffect, useMemo } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { MoreIcon } from '../../ui/Icons';
import Menu, { useMenuTrigger, type MenuEntry } from '../../ui/Menu';
import './roleMenu.css';

export function PaletteRowMenu(props: {
  /** The menu's rows, built when it opens; `anchor` is the button, which a row such as Show instances anchors its popup to. */
  readonly entries: (anchor: HTMLElement | undefined) => readonly MenuEntry[];
  /** The row's name, for the button's accessible label. */
  readonly name: string;
  /** Told when the menu opens or closes, so the panel can keep its hover card away while it is open. */
  readonly onOpenChange: (open: boolean) => void;
}) {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const { entries, name } = props;
  const rows = useMemo(() => entries(trigger.anchor), [entries, trigger.anchor]);
  const label = translate('palette.roles.options', { name });
  const { open } = trigger;
  const { onOpenChange } = props;
  useEffect(() => {
    onOpenChange(open);
    return () => onOpenChange(false);
  }, [open, onOpenChange]);
  return (
    <>
      <button
        ref={trigger.ref}
        type="button"
        className={`ghost palette-row-menu${trigger.open ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={trigger.open}
        aria-label={label}
        draggable={false}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          trigger.toggle();
        }}
      >
        <MoreIcon size={14} />
      </button>
      <Menu open={trigger.open} anchor={trigger.anchor} entries={rows} label={label} onClose={trigger.close} />
    </>
  );
}
