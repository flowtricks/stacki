// An image or file field of a connected CMS. Choosing a file uploads it to the
// CMS (the main process opens the dialog and sends the file), and the field
// then points at the stored asset, as the CMS's own editor writes it. An image
// is a thumbnail tile — click an empty one to upload, hover a full one to
// replace or remove it — the same tile a list of images is a grid of
// (RemoteImageGrid.tsx). An image keeps its own fields (alt text and the like)
// when it is replaced; its crop and focal point belonged to the old picture, so
// they go with it.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  remoteObject,
  type RemoteSchemaField,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteAsset } from '../../../shared/properties/cmsRemote';
import { uploadRemoteAsset } from '../../ipc/cmsConnectionsBridge';
import { ErrorToast } from '../../ui/ErrorToast';
import { TrashIcon, UploadIcon } from '../../ui/Icons';
import { RemoteObjectEditor } from './RemoteField';
import type { RemoteEditContext, RemoteValueProps } from './RemoteValueEditor';

export function RemoteAssetInput(
  props: RemoteValueProps & {
    readonly kind: 'image' | 'file';
    readonly fields: readonly RemoteSchemaField[];
  },
) {
  const { kind, value, context } = props;
  const object = remoteObject(value);
  const reference = assetReference(value);
  const upload = useAssetUpload(context, kind);
  const choose = () => upload.choose((asset) => props.onChange(pointingAt(object, kind, asset)));
  const asset = reference === undefined ? undefined : context.assets.get(reference);
  // An SVG is stored as a file, but it is a picture: it previews like an image.
  const svg = kind === 'file' && /\.svg$/i.test(asset?.filename ?? asset?.url ?? '');
  return (
    <div className={`remote-cms-asset is-${kind}`}>
      {kind === 'image' || svg ? (
        <ImageTile
          shape="natural"
          vector={svg}
          asset={asset}
          reference={reference}
          busy={upload.busy}
          onChoose={choose}
          onRemove={() => props.onChange(undefined)}
        />
      ) : (
        <FileRow
          name={asset?.filename}
          reference={reference}
          busy={upload.busy}
          onChoose={choose}
          onRemove={() => props.onChange(undefined)}
        />
      )}
      {upload.error && <ErrorToast message={upload.error} />}
      {props.fields.length > 0 && reference !== undefined && (
        <RemoteObjectEditor
          fields={props.fields}
          typeName={kind}
          value={value}
          context={context}
          onChange={props.onChange}
        />
      )}
    </div>
  );
}

/** One upload at a time, with its failure kept to show beside the control. */
export function useAssetUpload(context: RemoteEditContext, kind: 'image' | 'file') {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const run = async (onUploaded: (asset: RemoteAsset) => void) => {
    setBusy(true);
    setError(undefined);
    const uploaded = await uploadRemoteAsset(context.projectPath, context.connectionId, kind);
    setBusy(false);
    if (!uploaded.ok) {
      setError(uploaded.message);
    } else if (uploaded.value !== undefined) {
      context.addAsset(uploaded.value);
      onUploaded(uploaded.value);
    }
  };
  const choose = (onUploaded: (asset: RemoteAsset) => void) => void run(onUploaded);
  return { busy, error, choose };
}

/** An image as a thumbnail: empty, it uploads on click; full, hover offers replace and remove. */
export function ImageTile(props: {
  readonly asset: RemoteAsset | undefined;
  readonly reference: string | undefined;
  /** `natural` keeps the picture's own aspect ratio; `tile` crops to the grid's. */
  readonly shape: 'natural' | 'tile';
  /** An SVG file: shown as it is, whole, since the image service does not resize it. */
  readonly vector?: boolean;
  readonly busy: boolean;
  readonly onChoose: () => void;
  readonly onRemove: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  if (props.reference === undefined) {
    return (
      <button
        type="button"
        className="remote-cms-tile is-empty"
        title="Upload an image"
        disabled={props.busy}
        onClick={props.onChoose}
      >
        {props.busy ? (
          'Uploading…'
        ) : (
          <>
            <UploadIcon size={16} />
            <span>Upload image</span>
          </>
        )}
      </button>
    );
  }
  // The box takes the picture's own shape from its asset id before a byte has
  // loaded, and shimmers until the picture arrives, so nothing below it moves.
  const size = imageSize(props.reference);
  const style = size ? { aspectRatio: `${size.width} / ${size.height}` } : undefined;
  return (
    <div
      className={`remote-cms-tile ${loaded ? '' : 'is-loading'} ${props.vector ? 'is-vector' : ''}`}
      title={props.asset?.filename}
      style={props.shape === 'natural' ? style : undefined}
    >
      {props.asset && (
        <img
          ref={(image) => {
            // A picture already in the browser's cache is complete before React listens.
            if (image?.complete && image.naturalWidth > 0) {
              setLoaded(true);
            }
          }}
          src={props.vector ? props.asset.url : `${props.asset.url}?w=480&fit=max&auto=format`}
          alt={props.asset.filename}
          draggable={false}
          onLoad={() => setLoaded(true)}
        />
      )}
      <div className="remote-cms-tile-actions">
        <button type="button" title="Replace" disabled={props.busy} onClick={props.onChoose}>
          <UploadIcon size={12} />
        </button>
        <button type="button" className="is-remove" title="Remove" onClick={props.onRemove}>
          <TrashIcon size={12} />
        </button>
      </div>
      {props.busy && <span className="remote-cms-tile-busy">Uploading…</span>}
    </div>
  );
}

function FileRow(props: {
  readonly name: string | undefined;
  readonly reference: string | undefined;
  readonly busy: boolean;
  readonly onChoose: () => void;
  readonly onRemove: () => void;
}) {
  const empty = props.reference === undefined;
  const action = empty ? 'Upload' : 'Replace';
  return (
    <div className="remote-cms-asset-row">
      <span className="remote-cms-asset-name">
        {empty ? 'No file' : (props.name ?? props.reference)}
      </span>
      <div className="remote-cms-asset-actions">
        <button type="button" disabled={props.busy} onClick={props.onChoose}>
          <UploadIcon size={12} /> {props.busy ? 'Uploading…' : action}
        </button>
        {!empty && (
          <button type="button" className="ghost" title="Remove" onClick={props.onRemove}>
            <TrashIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

/** An image's pixel size, which Sanity writes into its asset id: `image-<hash>-1200x800-jpg`. */
export function imageSize(
  reference: string | undefined,
): { readonly width: number; readonly height: number } | undefined {
  const match =
    reference === undefined
      ? undefined
      : (/-(\d{1,5})x(\d{1,5})-[a-z0-9]+$/.exec(reference) ?? undefined);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (width > 0 && height > 0) {
    return { width, height };
  }
  return undefined;
}

/** The stored asset an image or file value points at, if any. */
export function assetReference(value: RemoteValue | undefined): string | undefined {
  const reference = remoteObject(remoteObject(value)?.['asset'])?.['_ref'];
  return typeof reference === 'string' ? reference : undefined;
}

// What belonged to the old file: its reference, and an image's crop and focal point.
const REPLACED_KEYS = ['asset', 'crop', 'hotspot'];

// The field's new value: the stored asset, with the field's own fields kept.
export function pointingAt(
  previous: { readonly [key: string]: RemoteValue } | undefined,
  kind: 'image' | 'file',
  asset: RemoteAsset,
): RemoteValue {
  assert(asset.id.startsWith(`${kind}-`), 'An uploaded asset is of the field kind');
  const own = Object.fromEntries(
    Object.entries(previous ?? {}).filter(([key]) => !REPLACED_KEYS.includes(key)),
  );
  return { ...own, _type: kind, asset: { _type: 'reference', _ref: asset.id } };
}
