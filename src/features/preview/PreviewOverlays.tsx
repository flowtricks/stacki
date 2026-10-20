import React, { useState } from 'react';
import type { Box } from './outlineBoxes';
import type { Annotation, PreviewMessage } from './previewMessages';
import { hoverIsSelection, onePerPlace, outlineBoxPath } from './outlineBoxes';
import { spacingBands, withLiveSpacing } from './spacingBands';
import {
  BranchIcon,
  CodeIcon,
  CommentIcon,
  CornerIcon,
  CustomElementIcon,
  ElementComponentIcon,
  LayoutIcon,
  RepeatIcon,
  TextIcon,
  astroAssetIcon,
  elementIcon,
} from '../../ui/Icons';

export interface OverlayInfo {
  readonly label: string;
  readonly kind: 'component' | 'map' | 'element';
  readonly tag: string | undefined;
  readonly astroAsset: boolean;
  readonly dynamicTag: boolean;
  readonly nodeKind: string;
  readonly isLayout: boolean;
  readonly bound: boolean;
}

/** A Feedback note drawn on the canvas, on one copy of its element. */
export interface PinOverlay {
  readonly id: string;
  /** The element's marker path, in whichever file rendered it. */
  readonly path: string;
  readonly occurrence: number;
  /** The 1-based number the Feedback list shows the note under. */
  readonly index: number;
  readonly note: string;
}

/** The Feedback tab's layer: clicks annotate, notes show as pins, and a box
 * takes the note for the element just clicked. */
export interface CanvasFeedback {
  readonly pins: readonly PinOverlay[];
  readonly openPinId: string | undefined;
  readonly composer:
    { readonly path: string; readonly occurrence: number; readonly target: string } | undefined;
  readonly onAnnotate: (annotation: Annotation) => void;
  readonly onAdd: (note: string) => void;
  readonly onCancel: () => void;
  readonly onOpenPin: (id: string | undefined) => void;
  /** A pin the Feedback list asked to bring on screen, until the canvas has. */
  readonly revealId: string | undefined;
  readonly onRevealed: () => void;
  readonly onDone: (id: string) => void;
  readonly onRemove: (id: string) => void;
}

export interface SpacingHover {
  readonly kind: 'padding' | 'margin' | 'gap';
  readonly sides?: readonly string[];
  readonly labels?: Readonly<Record<string, string>>;
  /** The values a drag is writing, per side: they size the band ahead of the page. */
  readonly live?: Readonly<Record<string, string>>;
}

// The measurements as the canvas frame reports them (src/features/preview/previewMessages.ts): a
// path it could not measure, and a copy without spacing, are absent.
type RectsMessage = Extract<PreviewMessage, { readonly kind: 'rects' }>;
export type RectMap = RectsMessage['rects'];
export type SpacingMap = RectsMessage['spacing'];

interface PreviewOverlaysProps {
  readonly rects: RectMap;
  readonly spacing: SpacingMap;
  readonly scale: number;
  readonly spacingHover?: SpacingHover | undefined;
  readonly selPath: string | undefined;
  readonly selOcc: number | undefined;
  readonly hoverPath: string | undefined;
  readonly hoverOcc: number | undefined;
  readonly focusPath: string | undefined;
  readonly focusWhole: boolean;
  readonly overlayInfo?: (path: string) => OverlayInfo | undefined;
  readonly feedback?: CanvasFeedback | undefined;
}

export function PreviewOverlays(props: PreviewOverlaysProps) {
  return (
    <>
      {!props.focusWhole && (
        <FocusOverlays path={props.focusPath} rects={props.rects} scale={props.scale} />
      )}
      <SpacingOverlays {...props} />
      <NodeOutlines {...props} />
      {props.feedback && (
        <FeedbackOverlays feedback={props.feedback} rects={props.rects} scale={props.scale} />
      )}
    </>
  );
}

function FocusOverlays({
  path,
  rects,
  scale,
}: {
  readonly path: string | undefined;
  readonly rects: RectMap;
  readonly scale: number;
}) {
  if (!path) {
    return undefined;
  }
  return onePerPlace(rects[path] ?? undefined).map((box, index) => (
    <div key={`focus-${index}`} className="node-focus" style={boxStyle(box, scale)} />
  ));
}

function SpacingOverlays(props: PreviewOverlaysProps) {
  const { spacingHover, selPath: selectedPath } = props;
  if (!spacingHover || !selectedPath) {
    return undefined;
  }
  const boxes = props.rects[selectedPath] ?? [];
  const measurements = props.spacing[selectedPath] ?? [];
  const box = boxes[props.selOcc ?? 0] ?? boxes[0];
  const measurement = measurements[props.selOcc ?? 0] ?? measurements[0] ?? undefined;
  const sized = withLiveSpacing(measurement, spacingHover.kind, spacingHover.live);
  return spacingBands(box, sized, spacingHover.kind, spacingHover.sides).map((band, index) => (
    <div
      key={`sp-${band.side}-${index}`}
      className={`spacing-band is-${spacingHover.kind}`}
      style={boxStyle(band, props.scale)}
    >
      <span className="spacing-band-label">
        {spacingHover.labels?.[band.side] ?? spacingLabel(band)}
      </span>
    </div>
  ));
}

function NodeOutlines(props: PreviewOverlaysProps) {
  const outlines = outlineTargets(props);
  return outlines.flatMap((outline) => {
    // An annotation can name an element of any file, which the open file's
    // model cannot label: outline it plainly.
    const info = props.feedback ? ANNOTATION_OUTLINE : props.overlayInfo?.(outline.path);
    const geometryPath = outlineBoxPath(outline.path, info?.nodeKind);
    const all = props.rects[geometryPath] ?? props.rects[outline.path];
    if (!all || !info) {
      return [];
    }
    // No occurrence means the node, so draw one box per place. A number means
    // the specific repeated copy clicked on the canvas.
    const selected = outline.occ === undefined ? undefined : all[outline.occ];
    const boxes =
      outline.occ === undefined ? onePerPlace(all) : selected ? [selected] : all.slice(0, 1);
    return boxes.map((box, index) => (
      <div
        key={`${outline.type}-${index}`}
        className={`node-outline ${outline.type} ${info.kind}${info.bound ? ' bound' : ''}`}
        style={boxStyle(box, props.scale)}
      >
        {info.label && (
          <span className={`node-outline-tag ${box.y * props.scale < 20 ? 'inside' : ''}`}>
            {outlineIcon(info)}
            {info.label}
          </span>
        )}
      </div>
    ));
  });
}

interface OutlineTarget {
  readonly path: string;
  readonly type: 'hover' | 'sel';
  readonly occ: number | undefined;
}

function outlineTargets(props: PreviewOverlaysProps): readonly OutlineTarget[] {
  const targets: OutlineTarget[] = [];
  if (
    props.hoverPath &&
    !hoverIsSelection(
      { path: props.hoverPath, occ: props.hoverOcc },
      { path: props.selPath, occ: props.selOcc },
    )
  ) {
    targets.push({ path: props.hoverPath, type: 'hover', occ: props.hoverOcc });
  }
  // While annotating, the note box marks what was clicked; the editor's
  // selection is not what a click there means.
  if (props.selPath && !props.feedback) {
    targets.push({ path: props.selPath, type: 'sel', occ: props.selOcc });
  }
  return targets;
}

const ANNOTATION_OUTLINE: OverlayInfo = {
  label: '',
  kind: 'element',
  tag: undefined,
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'element',
  isLayout: false,
  bound: false,
};

function outlineIcon(info: OverlayInfo): React.ReactNode {
  const size = 11;
  if (info.isLayout) {
    return <LayoutIcon size={size} />;
  }
  if (info.nodeKind === 'component') {
    // Fragments and dynamic tags share element styling and the custom-tag icon.
    if (info.kind === 'element') {
      return <CustomElementIcon size={size} />;
    }
    return info.astroAsset ? (
      astroAssetIcon(info.label, size)
    ) : (
      <ElementComponentIcon size={size} />
    );
  }
  switch (info.nodeKind) {
    case 'map':
      return <RepeatIcon size={size} />;
    case 'cond':
      return <BranchIcon size={size} />;
    case 'branch':
      return <CornerIcon size={size} />;
    case 'text':
      return <TextIcon size={size} />;
    case 'comment':
      return <CommentIcon size={size} />;
    case 'expr':
    case 'raw':
      return <CodeIcon size={size} />;
    default:
      return info.tag ? elementIcon(info.tag, size) : <CustomElementIcon size={size} />;
  }
}

function boxStyle(box: Box, scale: number): React.CSSProperties {
  return {
    left: box.x * scale,
    top: box.y * scale,
    width: box.w * scale,
    height: box.h * scale,
  };
}

function spacingLabel(box: Box & { readonly side: string }): string {
  const horizontal = box.side === 'left' || box.side === 'right';
  return `${Math.round(horizontal ? box.w : box.h)}px`;
}

// The Feedback pins, each opening a card with its note, and the box that takes
// a new note under the element just clicked. A pin or a box whose element
// reported no rect (another branch, off the page) draws nothing.
function FeedbackOverlays({
  feedback,
  rects,
  scale,
}: {
  readonly feedback: CanvasFeedback;
  readonly rects: RectMap;
  readonly scale: number;
}) {
  const boxOf = (place: { readonly path: string; readonly occurrence: number }) => {
    const all = rects[place.path];
    return all?.[place.occurrence] ?? all?.[0];
  };
  const { composer } = feedback;
  const composerBox = composer && boxOf(composer);
  return (
    <>
      {feedback.pins.flatMap((pin) => {
        const box = boxOf(pin);
        if (!box) {
          return [];
        }
        const open = feedback.openPinId === pin.id;
        return [
          <div
            key={pin.id}
            style={{ position: 'absolute', left: box.x * scale, top: box.y * scale }}
          >
            <button
              className={`feedback-pin${open ? ' is-open' : ''}`}
              title={pin.note}
              onClick={() => feedback.onOpenPin(open ? undefined : pin.id)}
            >
              {pin.index}
            </button>
            {open && <PinCard pin={pin} feedback={feedback} />}
          </div>,
        ];
      })}
      {composer && composerBox && (
        <NoteComposer
          key={`${composer.path}#${composer.occurrence}`}
          target={composer.target}
          left={composerBox.x * scale}
          top={(composerBox.y + composerBox.h) * scale + 6}
          feedback={feedback}
        />
      )}
    </>
  );
}

function PinCard({
  pin,
  feedback,
}: {
  readonly pin: PinOverlay;
  readonly feedback: CanvasFeedback;
}) {
  return (
    <div className="feedback-card">
      <p className="feedback-card-note">{pin.note}</p>
      <div className="feedback-card-actions">
        <button onClick={() => feedback.onDone(pin.id)}>Done</button>
        <button onClick={() => feedback.onRemove(pin.id)}>Delete</button>
      </div>
    </div>
  );
}

// Enter adds the note, Shift+Enter breaks the line, Escape closes the box.
function NoteComposer(props: {
  readonly target: string;
  readonly left: number;
  readonly top: number;
  readonly feedback: CanvasFeedback;
}) {
  const [draft, setDraft] = useState('');
  const submit = (): void => {
    const note = draft.trim();
    if (note) {
      props.feedback.onAdd(note);
    }
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      // The box's own Escape: the app's (leave the component) must not fire too.
      event.stopPropagation();
      props.feedback.onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };
  return (
    <div className="feedback-card feedback-composer" style={{ left: props.left, top: props.top }}>
      <textarea
        autoFocus
        value={draft}
        placeholder={`Note on ${props.target}`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="feedback-card-actions">
        <button onClick={props.feedback.onCancel}>Cancel</button>
        <button className="is-primary" disabled={!draft.trim()} onClick={submit}>
          Add note
        </button>
      </div>
    </div>
  );
}
