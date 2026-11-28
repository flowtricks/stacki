// The one rule for showing a picture whole inside a box, used by the image viewer and the frame picker.
import { assert } from '../../shared/core/assert';

interface Size {
  readonly width: number;
  readonly height: number;
}

/** The largest size of `frame`'s own aspect that fits `box`, in whole pixels. */
export function fitContain(frame: Size, box: Size): Size {
  assert(frame.width >= 1, 'fitContain: a frame has a width');
  assert(frame.height >= 1, 'fitContain: a frame has a height');
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  // A hair of slack, so a side that scales to a whole number exactly is not floored one short by float error.
  return { width: Math.max(1, Math.floor(frame.width * scale + 1e-9)), height: Math.max(1, Math.floor(frame.height * scale + 1e-9)) };
}
