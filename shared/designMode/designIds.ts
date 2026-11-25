// Design mode (experimental, removable: src/app/designMode/REMOVE.md): the ids of its frames and of the elements
// of a frame's document, branded so the two never trade places. Validated constructors, which is why they live
// in shared/ (the layer where an assertion right after validation is allowed).

declare const designBrand: unique symbol;
type DesignBrand<T, B> = T & { readonly [designBrand]: B };

/** A frame on the design canvas. */
export type FrameId = DesignBrand<string, 'FrameId'>;
/** An element of a frame's document, carried as its `data-dm-id`; equal ids in two frames name the same element of the page. */
export type DesignElementId = DesignBrand<string, 'DesignElementId'>;

export const FRAME_ID_PATTERN = /^f[0-9a-z]{1,24}$/;
export const ELEMENT_ID_PATTERN = /^[en][0-9a-z]{1,24}$/;

export function toFrameId(value: string): FrameId {
  if (!FRAME_ID_PATTERN.test(value)) {
    throw new Error('Assertion failed: toFrameId: a frame id of the grammar: ' + value);
  }
  return value as FrameId;
}

export function toDesignElementId(value: string): DesignElementId {
  if (!ELEMENT_ID_PATTERN.test(value)) {
    throw new Error('Assertion failed: toDesignElementId: an element id of the grammar: ' + value);
  }
  return value as DesignElementId;
}
