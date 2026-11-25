// The header's Modes button: a small menu of the modes registered in panelModes.ts, each row a switch with its
// tooltip. The button shows the mode that is on (its icon, pressed and in the accent colour), so it is clear at a
// glance that the canvas is in a mode, and choosing that row again turns it off. With no mode registered there is
// no button.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { cursorClick as centralCursorClick } from '../../../ui/central/centralGeometry';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { setPanelMode, usePanelModes } from '../panelModes';
import { TipButton } from './TipButton';

const ModesGlyph = centralIcon(centralCursorClick);

export function ModesMenu() {
  const translate = useTranslate();
  const trigger = useMenuTrigger();
  const { modes, active } = usePanelModes();
  if (modes.length === 0) {
    return undefined;
  }
  const label = active === undefined ? translate('ai.modes.menu') : translate('ai.modes.active', { mode: active.label(translate) });
  const entries: readonly MenuEntry[] = modes.map((mode) => ({
    kind: 'item',
    id: `mode-${mode.id}`,
    label: mode.label(translate),
    icon: mode.icon(),
    tooltip: mode.tooltip(translate),
    checked: mode === active,
    onSelect: () => setPanelMode(mode.id, mode === active ? 'off' : 'on'),
  }));
  return (
    <>
      <TipButton
        buttonRef={trigger.ref}
        className={active === undefined ? 'ai-modes-button' : 'ai-modes-button is-active'}
        label={label}
        pressed={active !== undefined}
        menu={{ open: trigger.open }}
        onClick={trigger.toggle}
      >
        {active === undefined ? <ModesGlyph size={16} /> : active.icon()}
      </TipButton>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        label={translate('ai.modes.menu')}
        placement="below-end"
        entries={trigger.open ? entries : []}
        onClose={trigger.close}
      />
    </>
  );
}
