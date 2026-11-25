// The header's Modes button, drawn with Central's toolbox: a neutral mark, so any mode can share the menu. It lists
// the modes registered in panelModes.ts, each row its icon and name. No row carries a tooltip: the menu focuses its first row as it opens, and a
// tooltip would then stand beside the menu unasked. While a mode is on, the button shows that
// mode's icon, pressed and in the accent colour, so it is clear at a glance that the canvas is in a mode, and
// choosing that row again turns it off. The button's own tooltip steps aside while the menu is open (TipButton).
// With no mode registered there is no button.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { toolbox as centralToolbox } from '../../../ui/central/centralGeometry';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import { setPanelMode, usePanelModes } from '../panelModes';
import { TipButton } from './TipButton';

const ModesGlyph = centralIcon(centralToolbox);

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
