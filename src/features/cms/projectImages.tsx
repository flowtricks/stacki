// A content entry's picture is a project file, not a link: the remote views
// find it among the project's assets, read once for the whole collection view,
// and draw it with the Assets panel's own thumbnail. A CMS's pictures are links
// on its CDN, so a connected CMS reads no assets at all.
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { WireAssetEntry } from '../../../shared/ipc/ipcResults';
import { isAstroContent, type CmsSource } from '../../../shared/properties/astroContent';
import { useAssetEntries } from '../../ui/AssetField';
import AssetThumb from '../../ui/AssetThumb';
import { ElementImageIcon } from '../../ui/Icons';

type AssetFile = Extract<WireAssetEntry, { readonly isDir: false }>;
const ProjectImages = createContext<ReadonlyMap<string, AssetFile>>(new Map());

/** Makes the project's images available below, for content collections only. */
export function ProjectImagesScope(props: {
  readonly projectPath: string;
  readonly source: CmsSource;
  readonly children: ReactNode;
}) {
  if (!isAstroContent(props.source)) {
    return props.children;
  }
  return (
    <ProjectImagesProvider projectPath={props.projectPath}>{props.children}</ProjectImagesProvider>
  );
}

/** The asset a project-relative path names, when it is one of the project's files. */
export function useProjectImage(file: string | undefined): AssetFile | undefined {
  const images = useContext(ProjectImages);
  return file === undefined ? undefined : images.get(file);
}

/**
 * The dropdown class for choices with pictures: larger pictures, and the check
 * moved to the end of the row so the pictures line up (remoteCms.css).
 */
export const OPTION_IMAGE_MENU = 'option-image-menu';

/** Whether any choice has a picture, so those without one show a placeholder. */
export function hasOptionImage(options: readonly { readonly imageFile?: string }[]): boolean {
  return options.some((option) => option.imageFile !== undefined);
}

/**
 * A choice's picture in a dropdown: the record's image, or, among choices that
 * have pictures, a grey placeholder that keeps the names lined up.
 */
export function OptionImage(props: {
  readonly file: string | undefined;
  readonly placeholder: boolean;
}) {
  const asset = useProjectImage(props.file);
  if (asset !== undefined) {
    return <AssetThumb file={asset} className="option-image" />;
  }
  if (props.placeholder) {
    return (
      <span className="option-image is-placeholder">
        <ElementImageIcon size={12} />
      </span>
    );
  }
  return undefined;
}

function ProjectImagesProvider(props: {
  readonly projectPath: string;
  readonly children: ReactNode;
}) {
  const entries = useAssetEntries(props.projectPath);
  const images = useMemo(
    () => new Map(entries.filter(isAssetFile).map((entry) => [entry.rel, entry])),
    [entries],
  );
  return <ProjectImages.Provider value={images}>{props.children}</ProjectImages.Provider>;
}

function isAssetFile(entry: WireAssetEntry): entry is AssetFile {
  return !entry.isDir;
}
