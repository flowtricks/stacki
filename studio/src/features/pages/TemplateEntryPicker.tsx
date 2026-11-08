// The title bar's entry switcher for a template page: Desktop's own picker
// (src/app/DynamicPicker.tsx), fed from the template entry store. It sits beside the
// page switcher, where Desktop has it beside the URL field.
import DynamicPicker from '../../../vendor/stacki/src/app/DynamicPicker';
import { routeFor } from '../project/projectClient';
import { chooseTemplateEntry, useTemplateEntries } from './templateEntryStore';

export function TemplateEntryPicker({ file }: { readonly file: string }) {
  const template = useTemplateEntries(file);
  if (template === undefined || template.state.kind === 'loading') {
    return null; // Not a template, or its entries are on their way: nothing to pick from yet.
  }
  const { entries, error } = template.state.value;
  const index = Math.max(
    0,
    entries.findIndex((entry) => entry.route === template.route),
  );
  return (
    <DynamicPicker
      entries={entries}
      index={index}
      error={error}
      pattern={routeFor(file)}
      onPick={(picked) => {
        const entry = entries[picked];
        if (entry !== undefined) {
          chooseTemplateEntry(file, entry.route);
        }
      }}
    />
  );
}
