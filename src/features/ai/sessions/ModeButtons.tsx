// The header's mode buttons, one per mode registered in panelModes.ts, in their registered order, right before "+".
// Each draws its mode's own icon with the app's tooltip naming it, presses in the accent colour while its mode is on
// (aria-pressed), and turns the mode off when clicked again; turning one on turns the others off (setPanelMode). The
// header knows no mode by name: a mode that is not registered has no button.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { setPanelMode, usePanelModes } from '../panelModes';
import { TipButton } from './TipButton';

export function ModeButtons() {
  const translate = useTranslate();
  const { modes, active } = usePanelModes();
  return (
    <>
      {modes.map((mode) => {
        const on = mode === active;
        return (
          <TipButton
            key={mode.id}
            className={on ? 'ai-mode-button is-active' : 'ai-mode-button'}
            label={mode.label(translate)}
            pressed={on}
            onClick={() => setPanelMode(mode.id, on ? 'off' : 'on')}
          >
            {mode.icon()}
          </TipButton>
        );
      })}
    </>
  );
}
