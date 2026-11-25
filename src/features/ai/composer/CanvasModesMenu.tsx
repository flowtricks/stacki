// The "Canvas" chip of the composer's status line and its menu: the canvas modes features registered
// (src/lib/canvasModes.ts), one row each, checked while it is on. The chip names the mode that is on, and
// hides itself when no feature registered a mode.
import { useLocale, useTranslate } from '../../../lib/i18n/useTranslate';
import { useCanvasModes } from '../../../lib/canvasModes';
import Menu, { useMenuTrigger, type MenuEntry } from '../../../ui/Menu';
import TipAnchor from '../../../ui/TipAnchor';
import { StatusChip } from './StatusChip';

export function CanvasModesMenu() {
  const translate = useTranslate();
  const { locale } = useLocale();
  const trigger = useMenuTrigger();
  const modes = useCanvasModes();
  if (modes.length === 0) {
    return undefined;
  }
  const active = modes.find((mode) => mode.isActive());
  const entries: MenuEntry[] = [
    { kind: 'heading', id: 'heading', label: translate('ai.composer.canvasModes') },
    ...modes.map((mode): MenuEntry => ({
      kind: 'item',
      id: 'canvas-mode:' + mode.id,
      label: mode.label(locale),
      icon: mode.icon,
      tooltip: mode.description(locale),
      checked: mode.isActive(),
      onSelect: mode.toggle,
    })),
  ];
  return (
    <>
      <TipAnchor text={translate('ai.composer.canvasModes.title')}>
        <StatusChip
          buttonRef={trigger.ref}
          open={trigger.open}
          disabled={false}
          tone="plain"
          ariaLabel={translate('ai.composer.canvasModes')}
          title=""
          onClick={trigger.toggle}
        >
          {active?.icon}
          <span className="ai-chip-text">{active === undefined ? translate('ai.composer.canvasModes.chip') : active.label(locale)}</span>
        </StatusChip>
      </TipAnchor>
      <Menu
        open={trigger.open}
        anchor={trigger.anchor}
        entries={entries}
        label={translate('ai.composer.canvasModes')}
        placement="above-start"
        widthPxMin={240}
        onClose={trigger.close}
      />
    </>
  );
}
