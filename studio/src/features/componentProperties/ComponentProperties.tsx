import { propertyErrorTextFor } from '../../../vendor/stacki/src/lib/i18n/propertyErrorText';
import { useTranslate } from '../../../vendor/stacki/src/lib/i18n/useTranslate';
import { usePropertySaveGuard } from './usePropertySaveGuard';
import ComponentPropertiesPanel from '../../../vendor/stacki/src/features/componentProperties/ComponentPropertiesPanel';
import type { SharedDocument } from '../collaboration/useDocument';
import { revertComponentProperties } from './propertyTransport';

export function ComponentProperties({ document, refresh }: { readonly document: SharedDocument; readonly refresh: () => void }) {
  const translate = useTranslate();
  const { phase, changePhase } = usePropertySaveGuard();
  return (
    <>
      {phase === 'saving' && (
        <div className="property-saving-overlay" role="status">
          {translate('shell.saving.properties')}
        </div>
      )}
      <ComponentPropertiesPanel
        projectPath="studio"
        file={document.file}
        name={
          document.file
            .split('/')
            .at(-1)
            ?.replace(/\.astro$/, '') ?? ''
        }
        flushSave={() => document.whenSaved()}
        onSavePhase={changePhase}
        onSaved={async () => {
          refresh();
        }}
        onRecordUndo={(initial) => {
          let token = initial;
          const restore = async () => {
            await document.whenSaved();
            const result = await revertComponentProperties(token);
            if (!result.ok) {
              throw new Error(propertyErrorTextFor(result.error, translate));
            }
            token = result.value.undo;
            refresh();
          };
          document.recordCommand({ undo: restore, redo: restore });
        }}
      />
    </>
  );
}
