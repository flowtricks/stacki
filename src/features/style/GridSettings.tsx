import GridAxisMode from './GridAxisMode';
import { AreasSection } from './GridAreas';
import { AutoSection, Modal } from './GridAutoSection';
import { type SetProp, type ClearProp, type Read, type OnProvenance, type OnSelectSelector, type LabelProps } from './GridSettingsKit';
import { useTranslate } from '../../lib/i18n/useTranslate';

// The "Grid settings" modal (Webflow's Configure-grid popup): the Columns and Rows
// (one mode control each, GridAxisMode), the auto-generated track sizes, and the areas.

export default function GridSettings({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
  onClose,
}: {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  onProvenance: OnProvenance;
  onSelectSelector: OnSelectSelector;
  onClose: () => void;
}) {
  const labels: LabelProps = { read, busy, clearProp, onProvenance, onSelectSelector };
  const translate = useTranslate();
  return (
    <Modal onClose={onClose}>
      <GridAxisMode title={translate('style.gridSettings.columns')} prop="grid-template-columns" axis="column" setProp={setProp} labels={labels} />
      <AutoSection title={translate('style.gridSettings.autoColumns')} prop="grid-auto-columns" axis="column" setProp={setProp} labels={labels} />
      <GridAxisMode title={translate('style.gridSettings.rows')} prop="grid-template-rows" axis="row" setProp={setProp} labels={labels} />
      <AutoSection title={translate('style.gridSettings.autoRows')} prop="grid-auto-rows" axis="row" setProp={setProp} labels={labels} />
      <AreasSection setProp={setProp} labels={labels} />
    </Modal>
  );
}
