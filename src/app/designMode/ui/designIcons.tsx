// Design mode's icons: all from the Central icon system already registered in src/ui/central/centralGeometry.tsx
// (docs/central-icons.md); none is drawn here.
import { centralIcon } from '../../../ui/central/CentralIcon';
import {
  add,
  arrowRotateCounterClockwise,
  canvas,
  chevronDown,
  close,
  component,
  copy,
  cursorClick,
  download,
  eye,
  eyeOff,
  image,
  layers,
  more,
  pointerHand,
  redo,
  search,
  sparkle,
  square,
  styles,
  text,
  trashCanSimple,
  undo,
  unlink,
  expand,
} from '../../../ui/central/centralGeometry';

export const DesignModeIcon = centralIcon(canvas);
export const MoveToolIcon = centralIcon(cursorClick);
export const TextToolIcon = centralIcon(text);
export const BoxToolIcon = centralIcon(square);
export const ImageToolIcon = centralIcon(image);
export const ComponentToolIcon = centralIcon(component);
export const HandToolIcon = centralIcon(pointerHand);
export const UndoIcon = centralIcon(undo);
export const RedoIcon = centralIcon(redo);
export const AddIcon = centralIcon(add);
export const CloseIcon = centralIcon(close);
export const MoreIcon = centralIcon(more);
export const CopyIcon = centralIcon(copy);
export const DeleteIcon = centralIcon(trashCanSimple);
export const ShowIcon = centralIcon(eye);
export const HideIcon = centralIcon(eyeOff);
export const UnlinkIcon = centralIcon(unlink);
export const SendIcon = centralIcon(sparkle);
export const ExportIcon = centralIcon(download);
export const ResetIcon = centralIcon(arrowRotateCounterClockwise);
export const LayersIcon = centralIcon(layers);
export const StyleIcon = centralIcon(styles);
export const ChevronIcon = centralIcon(chevronDown);
export const SearchIcon = centralIcon(search);
export const FitIcon = centralIcon(expand);
