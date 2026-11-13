import { useTranslate } from '../lib/i18n/useTranslate';
import { ErrorToast } from '../ui/ErrorToast';
interface DynamicPickerProps {
  readonly entries: readonly { readonly label: string }[];
  readonly index: number;
  readonly onPick: (index: number) => void;
  readonly error?: string | undefined;
  readonly pattern: string;
}
import Dropdown from '../ui/Dropdown';
import { FileIcon } from '../ui/Icons';

// Which entry of a dynamic route ([slug].astro) the canvas is rendered against.
//
// The route itself is a pattern, so there is nothing to preview until one of
// getStaticPaths' entries is chosen — /posts/[slug] is a 404, /posts/hello is a
// page. Only the data changes here: the template is shared by every entry, so
// whatever gets edited applies to all of them.
//
// Every option is a page that a collection generates, so it reads as one: the
// page glyph and the purple the rest of the app gives generated routes, in the
// Pages panel and the title bar. The list is as long as the collection is, so
// it is always searchable — a threshold would only mean the box appears when a
// project crosses some number of posts, which is a worse thing to learn than
// "the box is always there".
//
// Live preview is off. Each option is a full page navigation, so skimming the
// list would reload the canvas once per hover.
export default function DynamicPicker({ entries, index, onPick, error, pattern }: DynamicPickerProps) {
  const translate = useTranslate();
  if (error) {
    return <ErrorToast message={translate('shell.dynamicPicker.loadFailed', { error })} />;
  }
  if (!entries.length) {
    return (
      <span className="route-chip" title={translate('shell.dynamicPicker.noPathsTitle', { pattern })}>
        {translate('shell.dynamicPicker.noPaths')}
      </span>
    );
  }
  return (
    <span className="route-picker" title={translate('shell.dynamicPicker.title')}>
      <Dropdown
        className="route-dd collection"
        menuClassName="route-menu collection"
        value={String(index)}
        options={entries.map((entry, i) => ({
          value: String(i),
          label: entry.label,
          icon: <FileIcon size={12} />,
        }))}
        onChange={(value: string) => onPick(Number(value))}
        livePreview={false}
        searchable
        searchPlaceholder={translate('shell.dynamicPicker.search')}
      />
    </span>
  );
}
