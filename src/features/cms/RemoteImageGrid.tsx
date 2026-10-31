// A list of images as a grid of thumbnails, the way a CMS shows a multi-image
// field: drag a tile onto another to move it there, hover a tile to replace or
// remove it, and the last tile adds one. Tiles move in two dimensions, so this
// uses the platform's drag and drop rather than the row reorder, which reads
// only vertical position. A replaced image keeps its list key.
import { useState, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import { remoteObject, type RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { ErrorToast } from '../../ui/ErrorToast';
import { ImageTile, assetReference, pointingAt, useAssetUpload } from './RemoteAssetInput';
import type { RemoteEditContext } from './RemoteValueEditor';
import { remoteKey } from './remoteValues';

export function RemoteImageGrid(props: {
  readonly items: readonly RemoteValue[];
  readonly context: RemoteEditContext;
  readonly onChange: (items: readonly RemoteValue[]) => void;
}) {
  const { items, context } = props;
  const upload = useAssetUpload(context, 'image');
  const [replacing, setReplacing] = useState<number | undefined>(undefined);
  const [dragging, setDragging] = useState<number | undefined>(undefined);
  const replace = (index: number) => {
    setReplacing(index);
    upload.choose((asset) => {
      const previous = items[index];
      const key = (previous === undefined ? undefined : itemKey(previous)) ?? remoteKey();
      const next = remoteObject(pointingAt(remoteObject(previous), 'image', asset)) ?? {};
      props.onChange(
        items.map((item, position) => (position === index ? { ...next, _key: key } : item)),
      );
    });
  };
  const add = () => {
    setReplacing(undefined);
    upload.choose((asset) => {
      const next = remoteObject(pointingAt(undefined, 'image', asset)) ?? {};
      props.onChange([...items, { ...next, _key: remoteKey() }]);
    });
  };
  const drop = (target: number) => {
    if (dragging !== undefined) {
      props.onChange(movedTo(items, dragging, target));
    }
    setDragging(undefined);
  };
  return (
    <>
      <div className="remote-cms-tiles">
        {items.map((item, index) => {
          const reference = assetReference(item);
          return (
            <TileSlot
              key={itemKey(item) ?? index}
              dragging={dragging === index}
              onDragStart={() => setDragging(index)}
              onDrop={() => drop(index)}
              onDragEnd={() => setDragging(undefined)}
            >
              <ImageTile
                shape="tile"
                asset={reference === undefined ? undefined : context.assets.get(reference)}
                reference={reference}
                busy={upload.busy && replacing === index}
                onChoose={() => replace(index)}
                onRemove={() => props.onChange(items.filter((_, position) => position !== index))}
              />
            </TileSlot>
          );
        })}
        <ImageTile
          shape="tile"
          asset={undefined}
          reference={undefined}
          busy={upload.busy && replacing === undefined}
          onChoose={add}
          onRemove={() => undefined}
        />
      </div>
      {upload.error && <ErrorToast message={upload.error} />}
    </>
  );
}

// A tile that can be dragged, and dropped onto to take its place.
function TileSlot(props: {
  readonly dragging: boolean;
  readonly children: ReactNode;
  readonly onDragStart: () => void;
  readonly onDrop: () => void;
  readonly onDragEnd: () => void;
}) {
  return (
    <div
      className={`remote-cms-tile-slot ${props.dragging ? 'is-dragging' : ''}`}
      draggable={true}
      onDragStart={props.onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        props.onDrop();
      }}
      onDragEnd={props.onDragEnd}
    >
      {props.children}
    </div>
  );
}

function itemKey(item: RemoteValue): string | undefined {
  const key = remoteObject(item)?.['_key'];
  return typeof key === 'string' ? key : undefined;
}

// The list with the item at `from` moved to sit where `to` was.
export function movedTo(
  items: readonly RemoteValue[],
  from: number,
  to: number,
): readonly RemoteValue[] {
  assert(from >= 0, 'A move starts inside the list');
  assert(from < items.length, 'A move starts inside the list');
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) {
    next.splice(Math.min(to, next.length), 0, item);
  }
  return next;
}
