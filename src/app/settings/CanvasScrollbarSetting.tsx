// The Canvas row of Editor settings: where Chromium's own scrollbar starts (shared/properties/canvasScrollbar.ts).
// "Off" keeps the canvas's thin bar beside every frame, so the page always has the breakpoint's whole width; each
// other choice is a computer breakpoint or Desktop, widest first, and means it and every wider frame: "Laptop and wider".
// Tablets and phones are not offered (chromiumScrollbarBreakpoints): their own scrollbar floats over the page.
// The list is the open project's breakpoints, or the defaults when none is open. A saved breakpoint this project does
// not have shows as Off, which is what the canvas then does.
import { assert } from '../../../shared/core/assert';
import { chromiumScrollbarBreakpoints } from '../../../shared/properties/canvasScrollbar';
import {
  CANVAS_SCROLLBAR_DEFAULT,
  CANVAS_SCROLLBAR_OFF,
  canvasScrollbarPreferenceText,
  parseCanvasScrollbarPreference,
  type CanvasScrollbarPreference,
} from '../../../shared/properties/canvasScrollbarChoice';
import { DESKTOP_ID, type ResolvedBreakpoint } from '../../../shared/properties/projectBreakpoints';
import { useProjectBreakpoints } from '../../ipc/useProjectBreakpoints';
import { breakpointLabel } from '../../lib/breakpointLabel';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Dropdown, { type DropdownOption } from '../../ui/Dropdown';
import { SettingsRow } from './SettingsLayout';

export interface CanvasScrollbarSettingProps {
  readonly projectPath: string | undefined;
  /** The saved choice; undefined while it loads. */
  readonly preference: CanvasScrollbarPreference | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: CanvasScrollbarPreference) => void;
}

export function CanvasScrollbarSetting(props: CanvasScrollbarSettingProps) {
  const translate = useTranslate();
  const { resolved: breakpoints } = useProjectBreakpoints(props.projectPath);
  const widestFirst = chromiumScrollbarBreakpoints(breakpoints);
  const choice = (id: string, name: string): DropdownOption<string> => ({
    value: id,
    label: translate('settings.editor.canvas.scrollbar.from', { breakpoint: name }),
  });
  const named = (list: readonly ResolvedBreakpoint[]): readonly DropdownOption<string>[] =>
    list.map((breakpoint) => choice(breakpoint.id, breakpointLabel(breakpoint, translate)));
  // Desktop sits where the breakpoint cards draw it: after the wider breakpoints, before the narrower ones.
  const options: readonly DropdownOption<string>[] = [
    { value: CANVAS_SCROLLBAR_OFF, label: translate('settings.editor.canvas.scrollbar.off') },
    ...named(widestFirst.filter((breakpoint) => breakpoint.direction === 'up')),
    choice(DESKTOP_ID, translate('settings.breakpoints.desktop')),
    ...named(widestFirst.filter((breakpoint) => breakpoint.direction === 'down')),
  ];
  assert(options.length === widestFirst.length + 2, 'CanvasScrollbarSetting: Off, Desktop and one choice per computer breakpoint');
  const saved = canvasScrollbarPreferenceText(props.preference ?? CANVAS_SCROLLBAR_DEFAULT);
  const value = options.some((option) => option.value === saved) ? saved : CANVAS_SCROLLBAR_OFF;
  assert(
    options.some((option) => option.value === value),
    'CanvasScrollbarSetting: the shown choice is in the list',
  );
  const label = translate('settings.editor.canvas.scrollbar.label');
  return (
    <SettingsRow label={label} info={translate('settings.editor.canvas.scrollbar.info')}>
      <Dropdown
        ariaLabel={label}
        value={value}
        options={options}
        disabled={props.disabled}
        onChange={(picked) => props.onChange(parseCanvasScrollbarPreference(picked))}
      />
    </SettingsRow>
  );
}
