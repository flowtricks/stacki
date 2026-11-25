// The icon a Files row draws, by what the entry is and, for a file, by its name. Every drawing is from the Central
// icon system already in the app (src/ui/central/centralGeometry.tsx, docs/central-icons.md): nothing new is drawn.
import { mediaKindOf, type ExplorerEntryKind } from '../../../shared/ipc/fileExplorer';
import { centralIcon } from '../../ui/central/CentralIcon';
import { fileText as centralFileText, image as centralImage, video as centralVideo } from '../../ui/central/centralGeometry';
import { AudioFileIcon, BracesIcon, CodeIcon, ExternalIcon, FileIcon, FolderIcon, FolderOpenIcon, LockIcon, UnlinkIcon } from '../../ui/Icons';

const ImageFileIcon = centralIcon(centralImage);
const VideoFileIcon = centralIcon(centralVideo);
const TextFileIcon = centralIcon(centralFileText);

const CODE_NAME = /\.(astro|[cm]?[jt]sx?|css|scss|sass|less|html?|vue|svelte|svg|sh|zsh|bash|toml|ya?ml|xml)$/i;
const DATA_NAME = /\.(json|jsonc|json5|lock)$/i;
const TEXT_NAME = /\.(md|mdx|markdown|txt|log|csv)$/i;
// Files that by convention hold secrets: drawn with a lock, so a person sees what they are opening.
const SECRET_NAME = /^\.env(\..+)?$|\.(pem|key)$/i;

export function FileEntryIcon(props: { readonly name: string; readonly kind: ExplorerEntryKind; readonly open: boolean | undefined }) {
  switch (props.kind) {
    case 'directory':
    case 'link-directory':
      return props.open === true ? <FolderOpenIcon size={14} /> : <FolderIcon size={14} />;
    case 'link-outside':
      return <ExternalIcon size={14} />;
    case 'link-broken':
      return <UnlinkIcon size={14} />;
    case 'file':
    case 'link-file':
    case 'other':
      return <NamedFileIcon name={props.name} />;
    default: {
      const exhaustive: never = props.kind;
      return exhaustive;
    }
  }
}

function NamedFileIcon({ name }: { readonly name: string }) {
  if (SECRET_NAME.test(name)) {
    return <LockIcon size={14} />;
  }
  const media = mediaKindOf(name);
  if (media === 'image' || /\.svg$/i.test(name)) {
    return <ImageFileIcon size={14} />;
  }
  if (media === 'video') {
    return <VideoFileIcon size={14} />;
  }
  if (media === 'audio') {
    return <AudioFileIcon size={14} />;
  }
  if (DATA_NAME.test(name)) {
    return <BracesIcon size={14} />;
  }
  if (CODE_NAME.test(name)) {
    return <CodeIcon size={14} />;
  }
  if (TEXT_NAME.test(name)) {
    return <TextFileIcon size={14} />;
  }
  return <FileIcon size={14} />;
}
